// Pure helpers for the sign-in code autofill. Any site that emails a one-time
// code: the helper finds the newest code mail from the same company as the
// site you are signing in to, and the extension types it in.

const CODE_TTL_MS = 10 * 60 * 1000;
// The mail can land a moment before the extension sees the code box, so a
// message slightly older than the request's `since` still counts.
const SINCE_SLACK_MS = 60 * 1000;

// Senders that mail codes on another company's behalf: site root -> extra
// sender roots. Add one when a site's codes come from a different domain.
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

/** Gmail search for code mails received since `sinceMs` (minus slack). */
function otpMailQuery(sinceMs) {
  const after = Math.floor((sinceMs - SINCE_SLACK_MS) / 1000);
  return `after:${after} {subject:code subject:verification subject:verify subject:passcode subject:otp subject:"one-time" subject:"sign in" subject:"sign-in" subject:login subject:authentication subject:security}`;
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
  return Boolean(site) && (from === site || (SENDER_ALIASES[site] || []).includes(from));
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

/**
 * Newest unexpired code ({ code, at, sender, hosts }) from the site's company
 * since `sinceMs`. `pageHosts` are hostnames found in the page's address.
 */
function pickCode(messages, sinceMs, nowMs, siteHost, pageHosts = []) {
  const fresh = messages
    .filter(
      (m) =>
        m.code &&
        m.at >= sinceMs - SINCE_SLACK_MS &&
        nowMs - m.at < CODE_TTL_MS &&
        senderMatchesSite(m.sender, siteHost) &&
        mailNamesSite(m, siteHost, pageHosts),
    )
    .sort((a, b) => b.at - a.at);
  return fresh.length ? fresh[0].code : null;
}

module.exports = { CODE_TTL_MS, otpMailQuery, extractCode, rootDomain, senderAddress, senderMatchesSite, hostnamesIn, pickCode };
