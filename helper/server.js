#!/usr/bin/env node

// Local helper for the sign-in code autofill Chrome extension (../extension).
// When a site shows a code box the extension asks
//   GET http://127.0.0.1:7791/code?site=<hostname>&since=<ms>
//       [&hosts=<hostnames in the page address>][&skip=<codes already tried>]
// and gets { code, link, from, at, other } once a mail from that site's company
// lands in one of your Gmail inboxes: the code and/or sign-in link in it, the
// sender's domain and when it arrived. `other` is the domain of a code mail
// from a sender not tied to the site yet; when you click "Always use" the
// extension saves the pair with
//   POST http://127.0.0.1:7791/senders  { site, sender }
//
// Loopback only on purpose: it hands out live sign-in codes, so it must never
// be reachable from the network. Requests labeled with a website's Origin are
// refused, and it sends no CORS headers, so web pages cannot read its replies.
//
//   node helper/server.js
//   node helper/setup-agent.js      # run it always-on via launchd (macOS)

const http = require('node:http');
const { loadEnv, gmailClient, header, extractBody, extractLinks } = require('./gmail');
const {
  CODE_TTL_MS, otpMailQuery, extractCode, senderAddress, rootDomain, hostnamesIn, pickCode, pickLink, pickUnknownSender, addSender,
} = require('./otp');

loadEnv();
const PORT = Number(process.env.LOGIN_CODE_PORT || 7791);
// Env var names holding one refresh token each; every listed inbox is searched.
const MAILBOX_ENVS = (process.env.LOGIN_CODE_MAILBOXES || 'GMAIL_REFRESH_TOKEN')
  .split(',').map((k) => k.trim()).filter((k) => k && process.env[k]);
const mailboxes = MAILBOX_ENVS.map((key) => ({ key, gmail: gmailClient(key) }));

// "<mailbox>:<message id>" -> { code, at, sender, hosts, links }. A message never changes, so each is fetched once.
const seen = new Map();

async function scanMailbox({ key, gmail }, sinceMs) {
  for (const stub of await gmail.searchMessages(otpMailQuery(sinceMs), 10)) {
    const id = `${key}:${stub.id}`;
    if (seen.has(id)) continue;
    const message = await gmail.getMessage(stub.id);
    const text = `${header(message, 'Subject')}\n${extractBody(message)}`;
    seen.set(id, { code: extractCode(text), at: Number(message.internalDate), sender: senderAddress(header(message, 'From')), hosts: hostnamesIn(text), links: extractLinks(message) });
  }
}

async function latestMail(site, sinceMs, pageHosts, skip) {
  await Promise.all(mailboxes.map((mailbox) => scanMailbox(mailbox, sinceMs)));
  const messages = [...seen.values()];
  const withCode = pickCode(messages, sinceMs, Date.now(), site, pageHosts, skip);
  const withLink = pickLink(messages, sinceMs, Date.now(), site, pageHosts);
  const source = withCode || withLink;
  return {
    code: withCode ? withCode.code : null,
    link: withLink ? withLink.link : null,
    from: source ? rootDomain(source.sender) : null,
    at: source ? source.at : null,
    other: withCode ? null : rootDomain((pickUnknownSender(messages, sinceMs, Date.now(), site, pageHosts) || {}).sender),
  };
}

/** Save site -> sender, but only for a sender whose code mail is sitting in the inbox right now. */
function rememberSender(site, sender) {
  const from = rootDomain(sender);
  const mailed = [...seen.values()].some((m) => m.code && Date.now() - m.at < CODE_TTL_MS && rootDomain(m.sender) === from);
  if (!site || !from || !mailed) return false;
  addSender(site, from);
  console.log(new Date().toISOString(), `sender added: ${rootDomain(site)} <- ${from}`);
  return true;
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('close', () => resolve({}));
  });
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
  // POST only: a web page's POST always carries its Origin and was refused above.
  if (req.method === 'POST' && url.pathname === '/senders') {
    const { site, sender } = await readJson(req);
    try {
      return rememberSender(String(site || ''), String(sender || ''))
        ? send(res, 200, { ok: true })
        : send(res, 400, { error: 'no code mail from that sender' });
    } catch (err) {
      console.error(new Date().toISOString(), 'saving sender failed:', err.message);
      return send(res, 500, { error: 'could not save senders.json' });
    }
  }
  if (req.method !== 'GET' || url.pathname !== '/code') return send(res, 404, { error: 'not found' });
  const site = url.searchParams.get('site') || '';
  if (!site) return send(res, 400, { error: 'site is required' });
  const since = Number(url.searchParams.get('since')) || Date.now();
  const pageHosts = hostnamesIn(url.searchParams.get('hosts'));
  const skip = (url.searchParams.get('skip') || '').split(',').filter(Boolean);
  try {
    send(res, 200, await latestMail(site, since, pageHosts, skip));
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
