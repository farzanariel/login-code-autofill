// Minimal read-only Gmail client: no dependencies, just global fetch.
// Each mailbox is a stored OAuth refresh token (mint one with helper/auth.js)
// exchanged for a one-hour access token when needed.

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Load KEY=value lines from the project's .env without overriding real env vars. */
function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** A client for the mailbox whose refresh token is in env var `refreshTokenEnv`. */
function gmailClient(refreshTokenEnv) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env[refreshTokenEnv];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / ${refreshTokenEnv} (see README)`);
  }

  let cached = null;
  async function accessToken() {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) {
      throw new Error(`Gmail token refresh failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  async function get(pathAndQuery) {
    const response = await fetch(`${GMAIL_API_BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gmail GET ${pathAndQuery} failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }

  return {
    /** Message stubs ({ id, threadId }) for a Gmail search query. */
    async searchMessages(q, maxResults = 10) {
      const qs = new URLSearchParams({ q, maxResults: String(maxResults) });
      return (await get(`/messages?${qs}`)).messages || [];
    },
    getMessage: (id) => get(`/messages/${id}?format=full`),
  };
}

function header(message, name) {
  const headers = (message.payload && message.payload.headers) || [];
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Best-effort text body: text/plain if present, else tag-stripped text/html. */
function extractBody(message) {
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.body && node.body.data) parts.push({ mime: node.mimeType || '', text: decodeB64Url(node.body.data) });
    (node.parts || []).forEach(walk);
  })(message.payload);
  const plain = parts.find((p) => p.mime === 'text/plain');
  if (plain) return plain.text;
  const html = parts.find((p) => p.mime === 'text/html');
  if (html) {
    return html.text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  return decodeB64Url(message.payload && message.payload.body && message.payload.body.data);
}

module.exports = { ENV_FILE, loadEnv, gmailClient, header, extractBody };
