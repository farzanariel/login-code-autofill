// Helpers for the sign-in code autofill. Any site that emails a one-time
// code: the helper finds the newest code mail from the same company as the
// site you are signing in to, and the extension types it in.

const fs = require('node:fs');
const path = require('node:path');

const CODE_TTL_MS = 10 * 60 * 1000;
// The mail can land a moment before the extension sees the code box, so a
// message slightly older than the request's `since` still counts.
const SINCE_SLACK_MS = 60 * 1000;

// Senders that mail codes on another company's behalf: site root -> extra
// sender roots. Your own pairs go in senders.json (the badge's "Always use"
// button writes it), not here.
const SENDER_ALIASES = {
  // Seller Center signs in on login.account.wal-mart.com; codes come from walmart.com.
  'wal-mart.com': ['walmart.com'],
  // Cloudflare Access asks for the code on <team>.cloudflareaccess.com.
  'cloudflareaccess.com': ['cloudflare.com'],
};

// Senders that mail codes for many unrelated sites. Their mail only counts
// when it names the site being signed in to (Cloudflare's subject reads
// "Cloudflare Access login code for help.example.com").
const SHARED_SENDERS = new Set(['cloudflare.com']);

// Your own site -> sender pairs: { "site.com": ["mailer.com"] }.
const SENDERS_FILE = process.env.LOGIN_CODE_SENDERS || path.join(__dirname, '..', 'senders.json');
let own = { mtime: 0, map: {} };

/** senders.json as site root -> sender roots, re-read whenever the file is saved. */
function ownSenders() {
  let mtime = 0;
  try {
    mtime = fs.statSync(SENDERS_FILE).mtimeMs;
  } catch {
    return {}; // no file: nothing extra
  }
  if (mtime === own.mtime) return own.map;
  own = { mtime, map: {} };
  try {
    for (const [site, senders] of Object.entries(JSON.parse(fs.readFileSync(SENDERS_FILE, 'utf8')))) {
      own.map[rootDomain(site)] = [].concat(senders).map(rootDomain);
    }
  } catch (err) {
    console.error(new Date().toISOString(), `senders.json ignored: ${err.message}`);
    own.map = {};
  }
  return own.map;
}

/** Gmail search for code mails received since `sinceMs` (minus slack). */
function otpMailQuery(sinceMs) {
  const after = Math.floor((sinceMs - SINCE_SLACK_MS) / 1000);
  return `after:${after} {subject:code subject:verification subject:verify subject:passcode subject:otp subject:"one-time" subject:"sign in" subject:"sign-in" subject:"log in" subject:"magic link" subject:login subject:authentication subject:security}`;
}

function extractCode(text) {
  // An optional letter prefix (Walmart "W-123456", Google "G-123456") is not typed.
  const labeled = /(?:code|passcode|otp|pin)\s*(?:is)?\s*[:\-]?\s*(?:[A-Z]-)?(\d{4,8})\b/i.exec(text || '');
  if (labeled) return labeled[1];
  const bare = /\b(\d{6})\b/.exec(text || '');
  return bare ? bare[1] : null;
}

/** "dashboard.feedvisor.com" -> "feedvisor.com"; "ops@feedvisor.com" -> "feedvisor.com". */
function rootDomain(hostOrAddress) {
  const host = String(hostOrAddress || '').toLowerCase().split('@').pop().replace(/[>\s].*$/, '');
  const parts = host.split('.').filter(Boolean);
  // co.uk / com.au style: keep three labels.
  const keep = parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** Email address out of a From header ("Feedvisor <ops@feedvisor.com>"). */
function senderAddress(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader || '');
  return (m ? m[1] : String(fromHeader || '')).trim().toLowerCase();
}

function senderMatchesSite(sender, siteHost) {
  const site = rootDomain(siteHost);
  const from = rootDomain(sender);
  if (!site) return false;
  return from === site || (SENDER_ALIASES[site] || []).includes(from) || (ownSenders()[site] || []).includes(from);
}

/** Hostnames written in a mail or a page address, lower-cased. */
function hostnamesIn(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g) || []);
}

/** A shared sender's mail must name the page's own host or one in its address (`pageHosts`). */
function mailNamesSite(message, siteHost, pageHosts) {
  if (!SHARED_SENDERS.has(rootDomain(message.sender))) return true;
  const wanted = new Set([siteHost, ...pageHosts].map((h) => String(h).toLowerCase()));
  return (message.hosts || []).some((h) => wanted.has(h));
}

const SIGN_IN_TEXT = /log.?in|sign.?in|magic link|verify|confirm/i;
const SIGN_IN_PATH = /log.?in|sign.?in|magic|verify|confirm|callback|auth|token/i;
const NOT_SIGN_IN = /unsubscribe|preferences|privacy|terms|help|support|reset|password/i;

/**
 * The link in a mail ([{ url, text }]) that finishes signing in to `siteHost`:
 * https, on the site's own domain, and worded or addressed like a sign-in link.
 */
function signInLink(links, siteHost) {
  const site = rootDomain(siteHost);
  for (const { url, text } of links || []) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || rootDomain(parsed.hostname) !== site) continue;
    if (NOT_SIGN_IN.test(`${text} ${parsed.pathname}`)) continue;
    if (SIGN_IN_TEXT.test(text) || SIGN_IN_PATH.test(parsed.pathname)) return parsed.href;
  }
  return null;
}

/** Unexpired mails since `sinceMs`, newest first. */
function fresh(messages, sinceMs, nowMs) {
  return messages.filter((m) => m.at >= sinceMs - SINCE_SLACK_MS && nowMs - m.at < CODE_TTL_MS).sort((a, b) => b.at - a.at);
}

/** Unexpired mails from the site's company since `sinceMs`, newest first. */
function fromSite(messages, sinceMs, nowMs, siteHost, pageHosts) {
  return fresh(messages, sinceMs, nowMs).filter(
    (m) => senderMatchesSite(m.sender, siteHost) && mailNamesSite(m, siteHost, pageHosts),
  );
}

/**
 * Newest code mail whose sender is not tied to the site yet, or null. The
 * extension asks whether to always use that sender for the site.
 */
function pickUnknownSender(messages, sinceMs, nowMs, siteHost, pageHosts = []) {
  return (
    fresh(messages, sinceMs, nowMs).find(
      (m) => m.code && rootDomain(m.sender) && !senderMatchesSite(m.sender, siteHost) && mailNamesSite(m, siteHost, pageHosts),
    ) || null
  );
}

/** Forget a pair saved in senders.json. */
function removeSender(siteHost, sender) {
  const site = rootDomain(siteHost);
  const from = rootDomain(sender);
  if (!fs.existsSync(SENDERS_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(SENDERS_FILE, 'utf8'));
  for (const key of Object.keys(saved)) {
    if (rootDomain(key) !== site) continue;
    saved[key] = [].concat(saved[key]).filter((s) => rootDomain(s) !== from);
    if (!saved[key].length) delete saved[key];
  }
  fs.writeFileSync(SENDERS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
  own.mtime = 0;
}

/** Sites a sender's mail can sign in to: its own domain plus every site it is paired with. */
function sitesFor(sender) {
  const from = rootDomain(sender);
  const paired = (map) => Object.keys(map).filter((site) => map[site].includes(from));
  return [from, ...paired(SENDER_ALIASES), ...paired(ownSenders())];
}

/**
 * Unexpired codes and sign-in links for the extension's popup, newest first:
 * [{ code, link, from, at }]. Not tied to a page, so it is only ever shown to
 * you, never typed into a site.
 */
function recentMail(messages, nowMs, limit = 8) {
  return messages
    .filter((m) => m.at <= nowMs && nowMs - m.at < CODE_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .map((m) => ({
      code: m.code || null,
      link: sitesFor(m.sender).map((site) => signInLink(m.links, site)).find(Boolean) || null,
      from: rootDomain(m.sender),
      at: m.at,
    }))
    .filter((r) => r.code || r.link)
    .slice(0, limit);
}

/** Remember in senders.json that `sender`'s domain mails codes for `siteHost`. */
function addSender(siteHost, sender) {
  const site = rootDomain(siteHost);
  const from = rootDomain(sender);
  if (!site || !from) throw new Error('site and sender are required');
  // A file that does not parse is left alone rather than overwritten.
  const saved = fs.existsSync(SENDERS_FILE) ? JSON.parse(fs.readFileSync(SENDERS_FILE, 'utf8')) : {};
  const key = Object.keys(saved).find((k) => rootDomain(k) === site) || site;
  const list = [].concat(saved[key] || []);
  if (!list.map(rootDomain).includes(from)) list.push(from);
  saved[key] = list;
  fs.writeFileSync(SENDERS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
  own.mtime = 0; // re-read on the next lookup
}

/**
 * Newest mail ({ code, at, sender, hosts, links }) carrying a code for the
 * site, or null. `pageHosts` are hostnames found in the page's address;
 * codes in `skip` were already tried.
 */
function pickCode(messages, sinceMs, nowMs, siteHost, pageHosts = [], skip = []) {
  return fromSite(messages, sinceMs, nowMs, siteHost, pageHosts).find((m) => m.code && !skip.includes(m.code)) || null;
}

/** Newest mail carrying a sign-in link for the site, with that link as `link`, or null. */
function pickLink(messages, sinceMs, nowMs, siteHost, pageHosts = []) {
  for (const m of fromSite(messages, sinceMs, nowMs, siteHost, pageHosts)) {
    const link = signInLink(m.links, siteHost);
    if (link) return { ...m, link };
  }
  return null;
}

module.exports = {
  CODE_TTL_MS, otpMailQuery, extractCode, rootDomain, senderAddress, senderMatchesSite, hostnamesIn, signInLink,
  pickCode, pickLink, pickUnknownSender, addSender, removeSender, ownSenders, recentMail,
};
