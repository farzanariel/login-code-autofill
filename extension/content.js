// Watches every site for a sign-in code box, asks the local helper (via
// background.js) for the code that site's company just emailed, and types it
// in. It never submits: you still click the button. On a "check your email"
// page with no code box it offers the emailed sign-in link instead; the link
// only opens when you click the badge's button.
(() => {
  const POLL_MS = 3000;
  const GIVE_UP_MS = 150 * 1000;
  const CODE_HINT = /otp|code|verif|2fa|mfa|one.?time|passcode/i;
  // Boxes that say "code" but are not sign-in codes.
  const NOT_CODE = /zip|postal|post.?code|promo|coupon|gift|discount|voucher|referral|invite|card|cvc|cvv|area|country|phone/i;
  // Links and buttons that mail a fresh code.
  const RESEND = /resend|send (?:a )?(?:new|another) code|send (?:it )?again|new code/i;
  // Pages that mailed a sign-in link rather than a code.
  const LINK_HINT = /check your (?:e-?mail|inbox)|(?:sent|emailed) you an? (?:magic |sign.?in |log.?in |login )?link|magic link/i;
  const LINK_CHECKS = 40; // page-text looks per page load, so busy pages are not read forever
  let running = false;
  let paused = false; // switched off in the popup, for this site or everywhere
  let linkWatched = false; // the link wait runs once per page
  let linkChecks = 0;
  let linkTimer = 0;
  let badgeTimer = 0;
  let badgeRoot = null;
  let resentAt = 0; // when Resend was last clicked
  const handled = new WeakSet(); // each code box is tried once, plus once per Resend
  const used = new Set(); // codes already filled on this page, never filled twice

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

  // The badge lives in a closed shadow root so the page cannot read what it says.
  // `action` adds a button: { label, run }. Only a real click runs it, never one
  // the page fakes, and not in the first moment after it appears under the cursor.
  function badge(text, tone, action) {
    let host = document.getElementById('login-code-badge');
    if (!host) {
      host = document.createElement('div');
      host.id = 'login-code-badge';
      host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647';
      badgeRoot = host.attachShadow({ mode: 'closed' });
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.style.cssText =
      'padding:8px 12px;border-radius:6px;font:13px -apple-system,system-ui,sans-serif;color:#fff;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.2)';
    el.style.background = tone === 'ok' ? '#1a7f37' : tone === 'err' ? '#cf222e' : '#444';
    el.textContent = text;
    badgeRoot.replaceChildren(el);
    if (action) {
      const shownAt = Date.now();
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.style.cssText =
        'margin-left:10px;padding:2px 8px;border:1px solid rgba(255,255,255,.6);border-radius:4px;' +
        'background:transparent;color:#fff;font:inherit;cursor:pointer';
      button.addEventListener('click', (event) => event.isTrusted && Date.now() - shownAt > 600 && action.run());
      el.appendChild(button);
    }
    clearTimeout(badgeTimer);
    if (tone === 'ok') badgeTimer = setTimeout(() => host.remove(), action ? 60000 : 4000);
  }

  // "cloudflare.com, 11:02 AM": which mail the code or link came from.
  const source = (reply) =>
    `${reply.from}, ${new Date(reply.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  // A code mail came from a sender this site is not tied to: ask before using it.
  function offerSender(sender) {
    badge(`Code email from ${sender}. Use it for ${location.hostname}?`, 'wait', {
      label: 'Always use',
      run: () =>
        chrome.runtime.sendMessage({ type: 'login-code-sender', site: location.hostname, sender }, (reply) =>
          reply?.ok ? badge('Waiting for the code from Gmail…') : badge(`Code autofill: ${reply?.error || 'not saved'}`, 'err'),
        ),
    });
  }

  function offerLink(reply) {
    badge(`Sign-in link from ${source(reply)}`, 'ok', { label: 'Open link', run: () => location.assign(reply.link) });
  }

  // Shared sign-in pages name the real site in their address: Cloudflare Access
  // is <team>.cloudflareaccess.com/cdn-cgi/access/login/<the site>. Only the
  // hostnames are sent, never the rest of the address.
  function addressHosts() {
    let address = location.pathname + location.search;
    try {
      address = decodeURIComponent(address);
    } catch {}
    return [...new Set(address.toLowerCase().match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g) || [])].slice(0, 10).join(',');
  }

  const ask = (since) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(
        { type: 'login-code', site: location.hostname, since, hosts: addressHosts(), skip: [...used].join(',') },
        resolve,
      ),
    );

  // Tells the worker the wait is over so the toolbar icon stops showing it.
  const done = () => chrome.runtime.sendMessage({ type: 'login-code-done' }, () => void chrome.runtime.lastError);

  // Anything in the box other than a code we filled means you typed it yourself.
  const typedByHand = (targets) => {
    const value = targets.map((el) => el.value).join('');
    return Boolean(value) && !used.has(value);
  };

  // `since`: mail from this moment on counts. "Wrong code?" passes the first wait's start again.
  async function run(targets, since = Date.now()) {
    running = true;
    let started = Date.now();
    let linkOffered = false;
    let senderOffered = '';
    badge('Waiting for the code from Gmail…');
    while (Date.now() - started < GIVE_UP_MS) {
      if (paused) break;
      if (resentAt > since) since = started = resentAt; // a Resend restarts the wait
      if (targets.some((el) => !el.isConnected)) break; // page moved on
      if (typedByHand(targets)) break;
      const reply = await ask(since);
      if (reply?.code && !used.has(reply.code)) {
        used.add(reply.code);
        fill(targets, reply.code);
        const codeSince = since;
        badge(`Code from ${source(reply)}`, 'ok', { label: 'Wrong code?', run: () => tryAnother(targets, codeSince) });
        running = false;
        return;
      }
      if (reply?.error) badge(`Code autofill: ${reply.error}`, 'err');
      else if (reply?.other && reply.other !== senderOffered) {
        senderOffered = reply.other;
        offerSender(reply.other);
      } else if (reply?.link && !linkOffered && !senderOffered) {
        linkOffered = true; // the mail has a link but no code
        offerLink(reply);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (Date.now() - started >= GIVE_UP_MS) {
      if (!linkOffered) badge('No code arrived. Enter it by hand.', 'err');
    } else document.getElementById('login-code-badge')?.remove();
    running = false;
    done();
  }

  // "Wrong code?": clear the box and fill the next matching code, or wait for a new one.
  function tryAnother(targets, since) {
    if (running) return;
    targets.forEach((el) => setValue(el, ''));
    run(targets, since);
  }

  // No code box: quietly wait for a sign-in link and offer it when it lands.
  async function watchForLink() {
    linkWatched = true;
    const since = Date.now();
    while (Date.now() - since < GIVE_UP_MS && !paused) {
      if (running || used.size) return; // a code box showed up after all
      const reply = await ask(since);
      if (running || used.size) return;
      if (reply?.link) return offerLink(reply);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    done();
  }

  function checkForLinkPage() {
    if (linkWatched || linkTimer || linkChecks >= LINK_CHECKS) return;
    linkTimer = setTimeout(() => {
      linkTimer = 0;
      linkChecks += 1;
      if (!paused && !running && !used.size && LINK_HINT.test((document.body?.innerText || '').slice(0, 20000))) watchForLink();
    }, 1500);
  }

  function check() {
    if (running || paused) return;
    const targets = findTargets();
    if (!targets.length) return checkForLinkPage();
    if (handled.has(targets[0])) return;
    targets.forEach((el) => handled.add(el));
    if (!targets.map((el) => el.value).join('')) run(targets);
  }

  // Resend: wait for the new mail, even on a box that was already filled or gave up.
  document.addEventListener(
    'click',
    (event) => {
      const control = event.target.closest?.('button, a, [role="button"]');
      if (paused || !control || !RESEND.test(control.textContent || '')) return;
      const targets = findTargets();
      if (!targets.length) return;
      resentAt = Date.now();
      targets.forEach((el) => handled.add(el));
      if (!running && !typedByHand(targets)) run(targets);
    },
    true,
  );

  // The popup's switches: off everywhere, or off for this site.
  function readPause(then) {
    chrome.storage.local.get(['pausedAll', 'pausedSites'], ({ pausedAll, pausedSites = [] }) => {
      paused = Boolean(pausedAll) || pausedSites.includes(location.hostname);
      then();
    });
  }
  chrome.storage.onChanged.addListener(() => readPause(check));

  readPause(() => {
    check();
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
