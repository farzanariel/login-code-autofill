const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Your own sender pairs are read from this file instead of the real senders.json.
const sendersFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-code-')), 'senders.json');
process.env.LOGIN_CODE_SENDERS = sendersFile;

const otp = require('./otp');
const { extractCode, rootDomain, senderAddress, senderMatchesSite, hostnamesIn, signInLink, pickLink, otpMailQuery } = otp;
const { extractLinks } = require('./gmail');
// Most tests only care which code is picked.
const pickCode = (...args) => otp.pickCode(...args)?.code ?? null;

test('extractCode reads the Feedvisor mail body', () => {
  assert.equal(extractCode('Your code is: 482913\r\nIt expires in 300 seconds.\r\n'), '482913');
});

test('extractCode reads other common wordings', () => {
  assert.equal(extractCode('Your verification code: 7731'), '7731');
  assert.equal(extractCode('Use 553201 to sign in. Do not share it.'), '553201');
  assert.equal(extractCode('Your one-time passcode is 99887766'), '99887766');
  assert.equal(extractCode('## OTP mail to verify user at login. For OTP verification, please enter this code: W-640218'), '640218');
});

test('extractCode ignores the expiry number and returns null without a code', () => {
  assert.equal(extractCode('It expires in 300 seconds.'), null);
  assert.equal(extractCode(''), null);
});

test('rootDomain strips subdomains and mail addresses', () => {
  assert.equal(rootDomain('dashboard.feedvisor.com'), 'feedvisor.com');
  assert.equal(rootDomain('ops@feedvisor.com'), 'feedvisor.com');
  assert.equal(rootDomain('sellercentral.amazon.co.uk'), 'amazon.co.uk');
  assert.equal(senderAddress('Feedvisor <OPS@feedvisor.com>'), 'ops@feedvisor.com');
});

test('senderMatchesSite only matches the same company', () => {
  assert.ok(senderMatchesSite('account-update@amazon.com', 'sellercentral.amazon.com'));
  assert.ok(!senderMatchesSite('account-update@amazon.com', 'amazon-login.example.com'));
  assert.ok(!senderMatchesSite('ops@feedvisor.com', ''));
  assert.ok(senderMatchesSite('mpportal-donotreply@walmart.com', 'login.account.wal-mart.com'));
  assert.ok(senderMatchesSite('mpportal-donotreply@walmart.com', 'seller.walmart.com'));
});

const now = 1_000_000_000_000;
const site = 'dashboard.feedvisor.com';

test('pickCode returns the newest unexpired code from the site since the request', () => {
  const messages = [
    { code: '111111', at: now - 200_000, sender: 'ops@feedvisor.com' },
    { code: '222222', at: now - 10_000, sender: 'ops@feedvisor.com' },
    { code: '333333', at: now - 5_000, sender: 'no-reply@ebay.com' },
  ];
  assert.equal(pickCode(messages, now - 30_000, now, site), '222222');
});

test('pickCode skips expired codes, codes from before this login, and other senders', () => {
  assert.equal(pickCode([{ code: '1', at: now - 601_000, sender: 'ops@feedvisor.com' }], now - 700_000, now, site), null);
  assert.equal(pickCode([{ code: '1', at: now - 120_000, sender: 'ops@feedvisor.com' }], now - 30_000, now, site), null);
  assert.equal(pickCode([{ code: '1', at: now - 1_000, sender: 'x@feedvisor-login.net' }], now - 30_000, now, site), null);
});

test('otpMailQuery searches from a minute before the request', () => {
  assert.match(otpMailQuery(now), new RegExp(`^after:${(now - 60_000) / 1000} `));
});

// The Cloudflare Access mail: subject, then the plain-text body.
const cloudflareMail = [
  'Cloudflare Access login code for help.techrificdeals.com',
  'Your Cloudflare Access code\n\n871673\n\nThis code expires after 10 minutes or if you request a new code.',
  'Prefer not to use the code?\nFinish logging in to help.techrificdeals.com below.',
  'https://wandering-sound-983c.cloudflareaccess.com/cdn-cgi/access/callback?nonce=abc&code=871673&secret=xyz',
  'Copyright Cloudflare, Inc. 101 Townsend Street, San Francisco, CA 94107',
].join('\n');
const teamHost = 'wandering-sound-983c.cloudflareaccess.com';
const cloudflare = (text, at) => ({ code: extractCode(text), at, sender: 'noreply@notify.cloudflare.com', hosts: hostnamesIn(text) });

test('extractCode reads the Cloudflare Access mail', () => {
  assert.equal(extractCode(cloudflareMail), '871673');
  assert.ok(senderMatchesSite('noreply@notify.cloudflare.com', teamHost));
});

test('pickCode takes the Cloudflare code for the site in the page address, not another site', () => {
  const other = cloudflareMail.replaceAll('help.techrificdeals.com', 'admin.example.com').replaceAll('871673', '555555').replace(teamHost, 'other-team.cloudflareaccess.com');
  const messages = [cloudflare(cloudflareMail, now - 20_000), cloudflare(other, now - 5_000)];
  assert.equal(pickCode(messages, now - 30_000, now, teamHost, ['help.techrificdeals.com']), '871673');
  assert.equal(pickCode(messages, now - 30_000, now, 'other-team.cloudflareaccess.com', ['admin.example.com']), '555555');
  // No site named in the address and a different team: nothing is filled.
  assert.equal(pickCode(messages, now - 30_000, now, 'third-team.cloudflareaccess.com', []), null);
  // A Cloudflare mail never fills a code box on an unrelated site.
  assert.equal(pickCode(messages, now - 30_000, now, 'dash.cloudflare.com', []), null);
});

test('pickCode skips codes that were already tried and reports the mail it came from', () => {
  const messages = [
    { code: '111111', at: now - 20_000, sender: 'ops@feedvisor.com' },
    { code: '222222', at: now - 10_000, sender: 'ops@feedvisor.com' },
  ];
  assert.equal(pickCode(messages, now - 30_000, now, site, [], ['222222']), '111111');
  assert.equal(pickCode(messages, now - 30_000, now, site, [], ['222222', '111111']), null);
  assert.deepEqual(otp.pickCode(messages, now - 30_000, now, site), messages[1]);
});

const b64 = (text) => Buffer.from(text).toString('base64url');
const callback = 'https://wandering-sound-983c.cloudflareaccess.com/cdn-cgi/access/callback?nonce=abc&code=871673&secret=xyz';

test('extractLinks reads HTML anchors with their wording and bare links in plain text', () => {
  const html = `<p>Hi</p><a class="b" href="${callback.replaceAll('&', '&amp;')}"><b>Log in</b></a> <a href='https://www.cloudflare.com'>www.cloudflare.com</a>`;
  const message = {
    payload: {
      parts: [
        { mimeType: 'text/plain', body: { data: b64(`Finish logging in:\n${callback}\nBye`) } },
        { mimeType: 'text/html', body: { data: b64(html) } },
      ],
    },
  };
  assert.deepEqual(extractLinks(message), [
    { url: callback, text: '' },
    { url: callback, text: 'Log in' },
    { url: 'https://www.cloudflare.com', text: 'www.cloudflare.com' },
  ]);
});

test('signInLink only takes a sign-in link on the site itself', () => {
  const links = [
    { url: 'https://www.cloudflare.com/', text: 'Cloudflare logo' },
    { url: 'https://app.example.com/unsubscribe/login', text: 'Unsubscribe' },
    { url: 'https://app.example.com/reset', text: 'Reset your password to sign in' },
    { url: 'https://evil.example.net/login', text: 'Log in' },
    { url: 'http://app.example.com/login', text: 'Log in' },
    { url: 'not a link', text: 'Log in' },
    { url: 'https://app.example.com/m/abc123', text: 'Sign in to Example' },
  ];
  assert.equal(signInLink(links, 'www.example.com'), 'https://app.example.com/m/abc123');
  assert.equal(signInLink([{ url: callback, text: '' }], teamHost), callback);
  assert.equal(signInLink(links, 'other.com'), null);
  assert.equal(signInLink([], 'example.com'), null);
});

test('pickLink returns the newest matching mail with its sign-in link', () => {
  const messages = [
    { ...cloudflare(cloudflareMail, now - 5_000), links: [{ url: callback, text: 'Log in' }] },
    { code: null, at: now - 1_000, sender: 'no-reply@ebay.com', links: [{ url: 'https://ebay.com/login', text: 'Log in' }] },
  ];
  const found = pickLink(messages, now - 30_000, now, teamHost, ['help.techrificdeals.com']);
  assert.equal(found.link, callback);
  assert.equal(found.sender, 'noreply@notify.cloudflare.com');
  // Another Cloudflare site's page gets nothing.
  assert.equal(pickLink(messages, now - 30_000, now, 'other-team.cloudflareaccess.com', ['admin.example.com']), null);
});

test('senders.json adds your own site -> sender pairs and is re-read when saved', () => {
  assert.ok(!senderMatchesSite('codes@mailer-example.net', 'app.shop-example.com'));
  fs.writeFileSync(sendersFile, JSON.stringify({ 'app.shop-example.com': ['codes@mailer-example.net'], 'other.com': 'single.com' }));
  assert.ok(senderMatchesSite('codes@mailer-example.net', 'login.shop-example.com'));
  assert.ok(senderMatchesSite('x@single.com', 'other.com'));
  assert.ok(!senderMatchesSite('codes@mailer-example.net', 'feedvisor.com'));
  // A broken file is ignored, not fatal.
  fs.writeFileSync(sendersFile, '{ nope');
  fs.utimesSync(sendersFile, new Date(), new Date(Date.now() + 5_000));
  assert.ok(!senderMatchesSite('codes@mailer-example.net', 'app.shop-example.com'));
  assert.ok(senderMatchesSite('ops@feedvisor.com', 'dashboard.feedvisor.com'));
});

test('pickUnknownSender offers the newest code mail from a sender not tied to the site', () => {
  const messages = [
    { code: '111111', at: now - 9_000, sender: 'ops@feedvisor.com' },
    { code: '222222', at: now - 8_000, sender: 'codes@new-mailer.net', hosts: [] },
    { code: null, at: now - 1_000, sender: 'news@shop.com', hosts: [] },
    cloudflare(cloudflareMail, now - 2_000),
  ];
  assert.equal(otp.pickUnknownSender(messages, now - 30_000, now, 'app.newsite.com').sender, 'codes@new-mailer.net');
  // Cloudflare mail for another site is never offered; old mail is not either.
  assert.equal(otp.pickUnknownSender([messages[3]], now - 30_000, now, 'app.newsite.com'), null);
  assert.equal(otp.pickUnknownSender(messages, now + 120_000, now, 'app.newsite.com'), null);
});

test('addSender saves the pair so the code is picked from then on', () => {
  fs.writeFileSync(sendersFile, JSON.stringify({ 'other.com': ['single.com'] }));
  const messages = [{ code: '222222', at: now - 8_000, sender: 'codes@new-mailer.net' }];
  assert.equal(pickCode(messages, now - 30_000, now, 'app.newsite.com'), null);
  otp.addSender('app.newsite.com', 'codes@new-mailer.net');
  otp.addSender('login.newsite.com', 'new-mailer.net');
  assert.deepEqual(JSON.parse(fs.readFileSync(sendersFile, 'utf8')), { 'other.com': ['single.com'], 'newsite.com': ['new-mailer.net'] });
  assert.equal(pickCode(messages, now - 30_000, now, 'app.newsite.com'), '222222');
  assert.equal(otp.pickUnknownSender(messages, now - 30_000, now, 'app.newsite.com'), null);
  // A file that does not parse is not overwritten.
  fs.writeFileSync(sendersFile, '{ nope');
  assert.throws(() => otp.addSender('a.com', 'b.com'));
  assert.equal(fs.readFileSync(sendersFile, 'utf8'), '{ nope');
});

test('removeSender forgets a saved pair', () => {
  fs.writeFileSync(sendersFile, JSON.stringify({ 'newsite.com': ['new-mailer.net', 'second.com'], 'other.com': ['single.com'] }));
  otp.removeSender('app.newsite.com', 'new-mailer.net');
  otp.removeSender('other.com', 'x@single.com');
  assert.deepEqual(JSON.parse(fs.readFileSync(sendersFile, 'utf8')), { 'newsite.com': ['second.com'] });
  assert.deepEqual(otp.ownSenders(), { 'newsite.com': ['second.com'] });
  assert.ok(!senderMatchesSite('codes@new-mailer.net', 'app.newsite.com'));
});

test('recentMail lists unexpired codes and sign-in links, newest first', () => {
  const messages = [
    { code: '111111', at: now - 700_000, sender: 'ops@feedvisor.com', links: [] },
    { code: '222222', at: now - 60_000, sender: 'ops@feedvisor.com', links: [] },
    { ...cloudflare(cloudflareMail, now - 5_000), links: [{ url: callback, text: 'Log in' }] },
    { code: null, at: now - 1_000, sender: 'hi@example.com', links: [{ url: 'https://app.example.com/magic/abc', text: 'Sign in' }] },
    { code: null, at: now - 500, sender: 'news@shop.com', links: [{ url: 'https://shop.com/sale', text: 'Shop now' }] },
  ];
  assert.deepEqual(otp.recentMail(messages, now), [
    { code: null, link: 'https://app.example.com/magic/abc', from: 'example.com', at: now - 1_000 },
    { code: '871673', link: callback, from: 'cloudflare.com', at: now - 5_000 },
    { code: '222222', link: null, from: 'feedvisor.com', at: now - 60_000 },
  ]);
  assert.equal(otp.recentMail(messages, now, 1).length, 1);
});
