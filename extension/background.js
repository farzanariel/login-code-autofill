// Content scripts cannot call the loopback helper themselves (the page's origin
// would be sent and refused), so they ask this worker to fetch for them.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'login-code') return false;
  const query = new URLSearchParams({ site: msg.site, since: String(msg.since) });
  fetch(`http://127.0.0.1:7791/code?${query}`)
    .then((r) => (r.ok ? r.json() : { error: `helper returned ${r.status}` }))
    .then(reply)
    .catch(() => reply({ error: 'helper not running' }));
  return true;
});
