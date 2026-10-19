#!/usr/bin/env node

// Local helper for the sign-in code autofill Chrome extension (../extension).
// When a site shows a code box the extension asks
//   GET http://127.0.0.1:7791/code?site=<hostname>&since=<ms>
// and gets { code } once a code mail from that site's company lands in one of
// your Gmail inboxes.
//
// Loopback only on purpose: it hands out live sign-in codes, so it must never
// be reachable from the network. Requests labeled with a website's Origin are
// refused, and it sends no CORS headers, so web pages cannot read its replies.
//
//   node helper/server.js
//   node helper/setup-agent.js      # run it always-on via launchd (macOS)

const http = require('node:http');
const { loadEnv, gmailClient, header, extractBody } = require('./gmail');
const { otpMailQuery, extractCode, senderAddress, pickCode } = require('./otp');

loadEnv();
const PORT = Number(process.env.LOGIN_CODE_PORT || 7791);
// Env var names holding one refresh token each; every listed inbox is searched.
const MAILBOX_ENVS = (process.env.LOGIN_CODE_MAILBOXES || 'GMAIL_REFRESH_TOKEN')
  .split(',').map((k) => k.trim()).filter((k) => k && process.env[k]);
const mailboxes = MAILBOX_ENVS.map((key) => ({ key, gmail: gmailClient(key) }));

// "<mailbox>:<message id>" -> { code, at, sender }. A message never changes, so each is fetched once.
const seen = new Map();

async function scanMailbox({ key, gmail }, sinceMs) {
  for (const stub of await gmail.searchMessages(otpMailQuery(sinceMs), 10)) {
    const id = `${key}:${stub.id}`;
    if (seen.has(id)) continue;
    const message = await gmail.getMessage(stub.id);
    const text = `${header(message, 'Subject')}\n${extractBody(message)}`;
    seen.set(id, { code: extractCode(text), at: Number(message.internalDate), sender: senderAddress(header(message, 'From')) });
  }
}

async function latestCode(site, sinceMs) {
  await Promise.all(mailboxes.map((mailbox) => scanMailbox(mailbox, sinceMs)));
  return pickCode([...seen.values()], sinceMs, Date.now(), site);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  // The extension's worker sends no Origin (its host permission skips CORS).
  // A web page's fetch always carries its own Origin; a page that omits it
  // (no-cors) gets an opaque reply it cannot read.
  if ((origin && !origin.startsWith('chrome-extension://')) || host !== `127.0.0.1:${PORT}`) {
    return send(res, 403, { error: 'forbidden' });
  }
  const url = new URL(req.url, `http://${host}`);
  if (req.method !== 'GET' || url.pathname !== '/code') return send(res, 404, { error: 'not found' });
  const site = url.searchParams.get('site') || '';
  if (!site) return send(res, 400, { error: 'site is required' });
  const since = Number(url.searchParams.get('since')) || Date.now();
  try {
    send(res, 200, { code: await latestCode(site, since) });
  } catch (err) {
    console.error(new Date().toISOString(), 'gmail lookup failed:', err.message);
    send(res, 502, { error: 'gmail lookup failed' });
  }
});

if (!mailboxes.length) {
  console.error('No mailbox configured: run `npm run auth` first (see README).');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`${new Date().toISOString()} login-code helper on 127.0.0.1:${PORT} (${MAILBOX_ENVS.join(', ')})`);
});
