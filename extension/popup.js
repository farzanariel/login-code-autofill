// The window behind the toolbar icon: helper status, recent codes, saved
// senders, site history and the per-site switches. Everything it shows comes from the local
// helper; text from mails is only ever set as text, never as HTML.
(() => {
  const HELPER = 'http://127.0.0.1:7791';
  const $ = (id) => document.getElementById(id);

  const get = (path) => fetch(HELPER + path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
  const post = (path, body) =>
    fetch(HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      r.json(),
    );

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  const row = (lines, button) => el('li', {}, [el('div', { className: 'grow' }, lines), ...(button ? [button] : [])]);
  const empty = (text) => el('li', { className: 'muted', textContent: text });
  const clock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function setStatus(tone, text, hint) {
    $('dot').className = `dot ${tone}`;
    $('status').textContent = text;
    $('hint').hidden = !hint;
    if (hint) $('hint').replaceChildren(...hint);
  }

  // ----- site history (written by background.js)

  // Today as a time, earlier days as a date.
  function when(at) {
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString()
      ? clock(at)
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function showHistory() {
    chrome.storage.local.get('history', ({ history = {} }) => {
      const last = (e) => Math.max(e.lastFilled || 0, e.lastMissed || 0);
      const sites = Object.entries(history).sort((a, b) => last(b[1]) - last(a[1])).slice(0, 8);
      $('history-block').hidden = !sites.length;
      $('history').replaceChildren(
        ...sites.map(([host, e]) => {
          const filled = e.filled
            ? `Filled ${e.filled} ${e.filled === 1 ? 'time' : 'times'}, last ${when(e.lastFilled)}${e.from ? `, from ${e.from}` : ''}`
            : `Never filled. No code arrived ${when(e.lastMissed)}`;
          const missed = e.filled && e.missed ? [el('div', { className: 'muted', textContent: `No code arrived ${e.missed} ${e.missed === 1 ? 'time' : 'times'}, last ${when(e.lastMissed)}` })] : [];
          return row([el('div', { textContent: host }), el('div', { className: 'muted', textContent: filled }), ...missed]);
        }),
      );
    });
  }
  $('history-clear').addEventListener('click', () => chrome.storage.local.set({ history: {} }, showHistory));

  // ----- per-site switches (kept in the extension, read by content.js)

  // A checkbox that keeps `host` in or out of the stored list `key`; checked means `listed`.
  function siteSwitch(box, key, host, listed) {
    chrome.storage.local.get(key, ({ [key]: list = [] }) => {
      box.checked = list.includes(host) === listed;
      box.addEventListener('change', () =>
        chrome.storage.local.get(key, ({ [key]: now = [] }) => {
          const rest = now.filter((h) => h !== host);
          chrome.storage.local.set({ [key]: box.checked === listed ? [...rest, host] : rest });
        }),
      );
    });
  }

  function setUpPause() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      let host = '';
      try {
        const url = new URL(tab.url);
        if (/^https?:$/.test(url.protocol)) host = url.hostname;
      } catch {}
      chrome.storage.local.get('pausedAll', ({ pausedAll }) => {
        $('all-on').checked = !pausedAll;
        $('all-on').addEventListener('change', () => chrome.storage.local.set({ pausedAll: !$('all-on').checked }));
      });
      if (!host) return;
      $('site-row').hidden = $('submit-row').hidden = false;
      $('site-label').textContent = `On ${host}`;
      siteSwitch($('site-on'), 'pausedSites', host, false);
      siteSwitch($('submit-on'), 'submitSites', host, true);
    });
  }

  // ----- helper status, inboxes, saved senders

  function showSenders(senders) {
    const pairs = Object.entries(senders).flatMap(([site, list]) => list.map((sender) => [site, sender]));
    $('senders').replaceChildren(
      ...(pairs.length
        ? pairs.map(([site, sender]) => {
            const remove = el('button', { type: 'button', textContent: 'Remove' });
            remove.setAttribute('aria-label', `Remove ${sender} for ${site}`);
            remove.addEventListener('click', async () => {
              const reply = await post('/senders/remove', { site, sender }).catch(() => null);
              if (reply?.senders) showSenders(reply.senders);
            });
            return row([el('div', { textContent: site }), el('div', { className: 'muted', textContent: `codes from ${sender}` })], remove);
          })
        : [empty('None yet. The badge asks when a code comes from a new sender.')]),
    );
  }

  async function showStatus() {
    let status;
    try {
      status = await get('/status');
    } catch {
      setStatus('err', 'Helper not running', [
        'Start it in the project folder with ',
        el('code', { textContent: 'npm start' }),
        ', or keep it always on with ',
        el('code', { textContent: 'npm run install-agent' }),
        '.',
      ]);
      return false;
    }
    const broken = status.mailboxes.filter((box) => !box.ok);
    if (broken.length) {
      setStatus('err', 'Gmail needs reconnecting', ['Run ', el('code', { textContent: 'npm run auth' }), ' in the project folder.']);
    } else {
      const n = status.mailboxes.length;
      setStatus('ok', `Helper running, ${n} ${n === 1 ? 'inbox' : 'inboxes'} connected`);
    }
    $('online').hidden = false;
    $('inboxes').replaceChildren(
      ...status.mailboxes.map((box) =>
        el('li', {}, [
          el('span', { className: `dot ${box.ok ? 'ok' : 'err'}` }),
          el('div', { className: 'grow' }, [el('div', { textContent: box.email })]),
          ...(box.ok ? [] : [el('span', { className: 'muted', textContent: 'not readable' })]),
        ]),
      ),
    );
    showSenders(status.senders);
    return true;
  }

  // ----- recent codes and sign-in links

  async function showRecent() {
    let recent;
    try {
      ({ recent } = await get('/recent'));
    } catch {
      $('recent').replaceChildren(empty('Could not read Gmail.'));
      return;
    }
    $('recent').replaceChildren(
      ...(recent.length
        ? recent.map((mail) => {
            const button = el('button', { type: 'button', textContent: mail.code ? 'Copy' : 'Open link' });
            button.addEventListener('click', async () => {
              if (!mail.code) return chrome.tabs.create({ url: mail.link });
              await navigator.clipboard.writeText(mail.code);
              button.textContent = 'Copied';
              setTimeout(() => (button.textContent = 'Copy'), 1500);
            });
            return row(
              [
                el('div', { className: mail.code ? 'code' : '', textContent: mail.code || 'Sign-in link' }),
                el('div', { className: 'muted', textContent: `${mail.from}, ${clock(mail.at)}` }),
              ],
              button,
            );
          })
        : [empty('No codes right now.')]),
    );
  }

  setUpPause();
  showHistory();
  showStatus().then((online) => online && showRecent());
})();
