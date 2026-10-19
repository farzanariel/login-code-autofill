#!/usr/bin/env node

// Install (or remove) the helper as an always-on launchd agent, so the Chrome
// extension finds it after every reboot. macOS only.
//
//   node helper/setup-agent.js              # install + start
//   node helper/setup-agent.js --uninstall

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LABEL = 'com.login-code-autofill.helper';
const ROOT = path.join(__dirname, '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'login-code-autofill.log');
const domain = `gui/${process.getuid()}`;

if (process.argv.includes('--uninstall')) {
  spawnSync('launchctl', ['bootout', domain, PLIST], { stdio: 'ignore' });
  try { fs.unlinkSync(PLIST); } catch { /* not installed */ }
  console.log(`Removed ${LABEL}.`);
  process.exit(0);
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, 'helper', 'server.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(PLIST), { recursive: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(PLIST, xml);
spawnSync('launchctl', ['bootout', domain, PLIST], { stdio: 'ignore' });
const loaded = spawnSync('launchctl', ['bootstrap', domain, PLIST], { encoding: 'utf8' });
if (loaded.status !== 0) {
  console.error(loaded.stderr || loaded.stdout || `launchctl bootstrap exited ${loaded.status}`);
  process.exit(1);
}
console.log(`Installed ${LABEL}: helper on 127.0.0.1:7791. Log: ${LOG}`);
