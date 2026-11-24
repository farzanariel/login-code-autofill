// Content scripts cannot call the loopback helper themselves (the page's origin
// would be sent and refused), so they ask this worker to fetch for them.
// The toolbar icon shows what is happening on a tab: waiting on Gmail, code
// filled, something to click, or the helper being down. Chrome clears it when
// the tab moves to another page.
function mark(tab, text, color) {
  if (!tab) return;
  chrome.action.setBadgeText({ tabId: tab.id, text });
  if (text) chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color });
}

function markReply(tab, reply) {
  if (reply.error) mark(tab, '!', '#cf222e');
  else if (reply.code) mark(tab, '✓', '#1a7f37');
  else if (reply.link || reply.other) mark(tab, '?', '#9a6700');
  else mark(tab, '…', '#666');
}

// "off" on every tab while autofill is switched off everywhere in the popup.
function showPaused() {
  chrome.storage.local.get('pausedAll', ({ pausedAll }) => {
    chrome.action.setBadgeText({ text: pausedAll ? 'off' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#666' });
  });
}
chrome.runtime.onInstalled.addListener(showPaused);

// Right-click menu on any text box, for code boxes the extension did not
// recognise. content.js knows which box was right-clicked.
chrome.runtime.onInstalled.addListener(() =>
  chrome.contextMenus.create({ id: 'login-code-fill', title: 'Fill sign-in code here', contexts: ['editable'] }, () => void chrome.runtime.lastError),
);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'login-code-fill' || tab?.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'login-code-fill-here' }, { frameId: 0 }, () => void chrome.runtime.lastError);
});
chrome.runtime.onStartup.addListener(showPaused);
chrome.storage.onChanged.addListener(showPaused);

// Site history for the popup: per hostname, how often a code was filled or
// never arrived, and when. Codes themselves are not kept.
function record(sender, msg) {
  let host;
  try {
    host = new URL(sender.url).hostname;
  } catch {
    return;
  }
  chrome.storage.local.get('history', ({ history = {} }) => {
    const entry = history[host] || { filled: 0, missed: 0 };
    if (msg.type === 'login-code-filled') {
      entry.filled += 1;
      entry.lastFilled = Date.now();
      entry.from = String(msg.from || '');
    } else {
      entry.missed += 1;
      entry.lastMissed = Date.now();
    }
    history[host] = entry;
    const last = (e) => Math.max(e.lastFilled || 0, e.lastMissed || 0);
    const newest = Object.entries(history).sort((a, b) => last(b[1]) - last(a[1])).slice(0, 50);
    chrome.storage.local.set({ history: Object.fromEntries(newest) });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'login-code-filled' || msg?.type === 'login-code-missed') {
    record(sender, msg);
    return false;
  }
  if (msg?.type === 'login-code-done') {
    mark(sender.tab, '');
    return false;
  }
  // "Always use": remember that this sender mails codes for this site.
  if (msg?.type === 'login-code-sender') {
    fetch('http://127.0.0.1:7791/senders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: msg.site, sender: msg.sender }),
    })
      .then((r) => r.json())
      .then(reply)
      .catch(() => reply({ error: 'helper not running' }));
    return true;
  }
  if (msg?.type !== 'login-code') return false;
  const query = new URLSearchParams({ site: msg.site, since: String(msg.since), hosts: msg.hosts || '', skip: msg.skip || '' });
  fetch(`http://127.0.0.1:7791/code?${query}`)
    .then((r) => (r.ok ? r.json() : { error: `helper returned ${r.status}` }))
    .catch(() => ({ error: 'helper not running' }))
    .then((result) => {
      markReply(sender.tab, result);
      reply(result);
    });
  return true;
});
