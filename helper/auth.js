#!/usr/bin/env node

// One-time Gmail consent: mints a read-only refresh token for one mailbox and
// saves it to the project's .env.
//
//   node helper/auth.js                                   # -> GMAIL_REFRESH_TOKEN
//   node helper/auth.js --env-key GMAIL_WORK_REFRESH_TOKEN --login-hint you@work.com
//
// Needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env (a Google Cloud OAuth
// "Desktop app" client, see README). Scope is gmail.readonly only. Opens
// Google's consent screen; Google redirects to a one-shot localhost server
// that captures the code and exchanges it for tokens.

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { ENV_FILE, loadEnv } = require('./gmail');

const AUTH_HOST = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function parseArgs(argv) {
  const args = { envKey: 'GMAIL_REFRESH_TOKEN', loginHint: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-key') args.envKey = argv[++i] || args.envKey;
    else if (argv[i] === '--login-hint') args.loginHint = argv[++i] || '';
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(args.envKey)) throw new Error(`--env-key must be an ENV_VAR_NAME, got "${args.envKey}"`);
  return args;
}

// Replace the key's line if present, otherwise append it.
function saveEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (line.test(text)) text = text.replace(line, `${key}=${value}`);
  else text += `${text === '' || text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

async function exchange(code, redirectUri, clientId, clientSecret) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.refresh_token) {
    throw new Error(`Token exchange failed ${response.status}: ${JSON.stringify(json).slice(0, 400)}`
      + (response.ok ? '\n(No refresh_token returned: revoke prior access at https://myaccount.google.com/permissions and retry.)' : ''));
  }
  return json;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (see README).');
  const state = crypto.randomBytes(16).toString('hex');

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/') return res.writeHead(404).end();
      try {
        if (url.searchParams.get('error')) throw new Error(`Consent denied: ${url.searchParams.get('error')}`);
        if (url.searchParams.get('state') !== state) throw new Error('State mismatch, aborting.');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('No code in callback.');
        const tokens = await exchange(code, `http://localhost:${server.address().port}`, clientId, clientSecret);
        saveEnv(args.envKey, tokens.refresh_token);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<h2>Gmail connected.</h2><p>${args.envKey} saved to .env. You can close this tab.</p>`);
        console.log(`${args.envKey} saved to .env`);
        server.close();
        resolve();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Auth failed: ${e.message}`);
        server.close();
        reject(e);
      }
    });

    // Port 0: the OS picks a free port. Desktop OAuth clients accept loopback
    // redirects on any port.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://localhost:${server.address().port}`;
      const authUrl = `${AUTH_HOST}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        ...(args.loginHint ? { login_hint: args.loginHint } : {}),
      })}`;
      console.log(`Saving into ${args.envKey}.${args.loginHint ? ` Sign in as ${args.loginHint}.` : ''}`);
      execFile('open', [authUrl], (err) => {
        if (err) console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
      });
    });
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
