// Watches every site for a sign-in code box, asks the local helper (via
// background.js) for the code that site's company just emailed, and types it
// in. It never submits: you still click the button.
(() => {
  const POLL_MS = 3000;
  const GIVE_UP_MS = 150 * 1000;
  const CODE_HINT = /otp|code|verif|2fa|mfa|one.?time|passcode/i;
  // Boxes that say "code" but are not sign-in codes.
  const NOT_CODE = /zip|postal|post.?code|promo|coupon|gift|discount|voucher|referral|invite|card|cvc|cvv|area|country|phone/i;
  let running = false;
  const handled = new WeakSet(); // each code box is tried once

  const visible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;

  // Test ids count too: Walmart's code box has no id, name or linked label,
  // only data-automation-id="twoFa-input-enter-otp".
  const label = (el) =>
    [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute('aria-label'),
      el.labels?.[0]?.textContent,
      el.getAttribute('data-automation-id'),
      el.getAttribute('data-testid'),
    ].join(' ');

  function findTargets() {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const split = inputs.filter((el) => el.maxLength === 1 && /^(text|tel|number|)$/.test(el.type));
    if (split.length >= 4) return split;
    const single = inputs.find(
      (el) =>
        el.autocomplete === 'one-time-code' ||
        (/^(text|tel|number)$/.test(el.type) &&
          !el.autocomplete.startsWith('cc-') &&
          CODE_HINT.test(label(el)) &&
          !NOT_CODE.test(label(el))),
    );
    return single ? [single] : [];
  }

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(targets, code) {
    if (targets.length === 1) setValue(targets[0], code);
    else targets.forEach((el, i) => setValue(el, code[i] || ''));
    targets[targets.length - 1].focus();
  }

  function badge(text, tone) {
    let el = document.getElementById('login-code-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'login-code-badge';
      el.style.cssText =
        'position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:8px 12px;border-radius:6px;' +
        'font:13px -apple-system,system-ui,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2)';
      document.body.appendChild(el);
    }
    el.style.background = tone === 'ok' ? '#1a7f37' : tone === 'err' ? '#cf222e' : '#444';
    el.textContent = text;
    if (tone === 'ok') setTimeout(() => el.remove(), 4000);
  }

  const ask = (since) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'login-code', site: location.hostname, since }, resolve));

  async function run(targets) {
    running = true;
    const since = Date.now();
    badge('Waiting for the code from Gmail…');
    while (Date.now() - since < GIVE_UP_MS) {
      if (targets.some((el) => !el.isConnected)) break; // page moved on
      if (targets.map((el) => el.value).join('')) break; // you typed it yourself
      const reply = await ask(since);
      if (reply?.code) {
        fill(targets, reply.code);
        badge('Code filled from Gmail', 'ok');
        running = false;
        return;
      }
      if (reply?.error) badge(`Code autofill: ${reply.error}`, 'err');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (Date.now() - since >= GIVE_UP_MS) badge('No code arrived. Enter it by hand.', 'err');
    else document.getElementById('login-code-badge')?.remove();
    running = false;
  }

  function check() {
    if (running) return;
    const targets = findTargets();
    if (!targets.length || handled.has(targets[0])) return;
    targets.forEach((el) => handled.add(el));
    if (!targets.map((el) => el.value).join('')) run(targets);
  }

  check();
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
})();
