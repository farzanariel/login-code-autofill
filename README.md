# Sign-in Code Autofill

A Chrome extension plus a tiny local helper. When a site asks for the code it
just emailed you, the code is typed into the box for you, straight from your Gmail.
It never clicks Submit for you.

- Works on any site that emails a code (Walmart Seller Center, Amazon, Feedvisor, ...).
- Reads Gmail **read-only**, and only while a code box is open on the page
  (about one search every 3 seconds, for at most 150 seconds).
- Anti-phishing: a code is only handed to a site when the email came from the
  same company as the site's domain. `walmart.com` mail fills
  `seller.walmart.com`, but never `walmart-login.example.com`.
- No dependencies. Node 18+ and Chrome.

## How it works

```
page with a code box ──> extension content script ──> extension worker
                                                           │  GET 127.0.0.1:7791/code?site=…
                                                           ▼
                                   helper (Node, loopback only) ──> Gmail API (read-only)
```

1. `extension/content.js` watches every page for a one-time-code input: a box marked
   `autocomplete="one-time-code"`, a box whose name, label or test id says code/OTP/verification,
   or a row of 4+ single-character boxes.
2. It asks the helper for a code from mail received since the box appeared.
3. `helper/server.js` searches your inbox(es) for code-like subjects, pulls the
   digits out (`W-123456` becomes `123456`), and returns the newest one from the right sender.
4. The extension fills the box and shows a small badge in the corner of the page.
5. Clicking **Resend** (or "send a new code") starts a fresh wait and skips the code it already
   filled, so the new code replaces the old one.

The helper only listens on `127.0.0.1`, refuses requests carrying a website's
`Origin`, and sends no CORS headers, so web pages cannot read codes from it.

## Setup

### 1. Google OAuth client (one time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project
   and enable the **Gmail API**.
2. Under **APIs & Services > OAuth consent screen**, set it up as *External* and
   add yourself as a test user.
3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**.
4. Copy `.env.example` to `.env` and paste the client ID and secret into it.

### 2. Connect your inbox

```bash
npm run auth
```

This opens Google's consent screen (scope `gmail.readonly`) and saves
`GMAIL_REFRESH_TOKEN` to `.env`. For a second inbox:

```bash
node helper/auth.js --env-key GMAIL_WORK_REFRESH_TOKEN --login-hint you@work.com
```

Then list both in `.env`: `LOGIN_CODE_MAILBOXES=GMAIL_REFRESH_TOKEN,GMAIL_WORK_REFRESH_TOKEN`.

### 3. Run the helper

```bash
npm start
```

On macOS, to keep it running in the background and start it at login:

```bash
npm run install-agent
```

The log is at `~/Library/Logs/login-code-autofill.log`. `npm run uninstall-agent` removes it.

### 4. Load the extension

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and pick the `extension/` folder. After pulling changes, click the reload icon
on the extension and reload the sign-in page. Chrome does not add a newly
loaded or reloaded extension to tabs that were already open.

## Sites that mail from another domain

If a site's codes come from a different company domain than the site itself,
add it to `SENDER_ALIASES` in `helper/otp.js`:

```js
const SENDER_ALIASES = {
  'wal-mart.com': ['walmart.com'], // login.account.wal-mart.com, mail from walmart.com
};
```

## Troubleshooting

- **No badge appears on the code screen:** the extension didn't recognise the box.
  Open DevTools on the input and check its attributes. Sites with no useful
  name, id, label or test id need a new hint in `findTargets()` in `extension/content.js`.
- **Badge says "helper not running":** start it with `npm start` or `npm run install-agent`.
- **Badge waits, then says no code arrived:** check the email reached a connected
  inbox and that its sender's domain matches the site (see aliases above).
  You can ask the helper directly:

  ```bash
  curl "http://127.0.0.1:7791/code?site=seller.walmart.com&since=$(( ($(date +%s) - 600) * 1000 ))"
  ```

## Tests

```bash
npm test
```

## License

MIT
