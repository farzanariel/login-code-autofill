// The window behind the toolbar icon: helper status, recent codes, saved
// senders and the pause switches. Everything it shows comes from the local
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

  // ----- pause switches (kept in the extension, read by content.js)

  function setUpPause() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      let host = '';
      try {
        const url = new URL(tab.url);
        if (/^https?:$/.test(url.protocol)) host = url.hostname;
      } catch {}
      chrome.storage.local.get(['pausedAll', 'pausedSites'], ({ pausedAll, pausedSites = [] }) => {
        $('all-on').checked = !pausedAll;
        $('all-on').addEventListener('change', () => chrome.storage.local.set({ pausedAll: !$('all-on').checked }));
        if (!host) return;
        $('site-row').hidden = false;
        $('site-label').textContent = `On ${host}`;
        $('site-on').checked = !pausedSites.includes(host);
        $('site-on').addEventListener('change', () =>
          chrome.storage.local.get('pausedSites', ({ pausedSites: now = [] }) => {
            const rest = now.filter((h) => h !== host);
            chrome.storage.local.set({ pausedSites: $('site-on').checked ? rest : [...rest, host] });
          }),
        );
      });
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
  showStatus().then((online) => online && showRecent());
})();
