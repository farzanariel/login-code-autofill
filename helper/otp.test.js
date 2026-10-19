const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCode, pickCode, rootDomain, senderAddress, senderMatchesSite, otpMailQuery } = require('./otp');

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
