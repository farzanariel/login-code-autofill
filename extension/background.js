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
chrome.runtime.onStartup.addListener(showPaused);
chrome.storage.onChanged.addListener(showPaused);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
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
