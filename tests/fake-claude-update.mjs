// Fake `claude update` / `claude --version` for the Claude CLI update tests
// (src/claudeUpdate.ts). Run as
//   CLAUDE_BIN="<node> tests/fake-claude-update.mjs"
//
//   --version   prints `<v> (Claude Code)` and exits 0, where <v> is the trimmed
//               contents of FAKE_CLAUDE_VERSION_FILE when that file exists,
//               else 2.0.0.
//   update      FAKE_UPDATE_RECORD=<file>: first writes
//               {argv, projectDirName: $CLAUDE_CODE_PROJECT_DIR_NAME ?? null}
//               there. Then by FAKE_UPDATE_MODE:
//     ok (default)  stdout `Current version: <v>`, stderr `Checking for
//                   updates...`; with FAKE_UPDATE_TO=<to>, writes <to> to
//                   FAKE_CLAUDE_VERSION_FILE and prints `Successfully updated
//                   from <v> to <to>`. Exits 0.
//     fail          stdout `Current version: <v>`, stderr `Error: failed to
//                   install update`, exits 1.
//     gate          polls every 20 ms until the file FAKE_UPDATE_GATE names
//                   exists, then behaves as ok.
//     hang          never exits.
//   anything else   a stderr line, exit 2.

import fs from 'node:fs';

const versionFile = process.env.FAKE_CLAUDE_VERSION_FILE;
const currentVersion = () => (versionFile && fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '2.0.0');

function ok() {
  const v = currentVersion();
  process.stdout.write(`Current version: ${v}\n`);
  process.stderr.write('Checking for updates...\n');
  const to = process.env.FAKE_UPDATE_TO;
  if (to) {
    fs.writeFileSync(versionFile, to);
    process.stdout.write(`Successfully updated from ${v} to ${to}\n`);
  }
  process.exitCode = 0;
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(`${currentVersion()} (Claude Code)\n`);
} else if (argv.length === 1 && argv[0] === 'update') {
  const record = process.env.FAKE_UPDATE_RECORD;
  if (record) fs.writeFileSync(record, JSON.stringify({ argv, projectDirName: process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? null }));
  const mode = process.env.FAKE_UPDATE_MODE ?? 'ok';
  if (mode === 'ok') ok();
  else if (mode === 'fail') {
    process.stdout.write(`Current version: ${currentVersion()}\n`);
    process.stderr.write('Error: failed to install update\n');
    process.exitCode = 1;
  } else if (mode === 'gate') {
    const gate = process.env.FAKE_UPDATE_GATE;
    const poll = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(poll); ok(); } }, 20);
  } else if (mode === 'hang') setInterval(() => {}, 1 << 30);
  else { process.stderr.write(`fake-claude-update: unknown FAKE_UPDATE_MODE ${mode}\n`); process.exitCode = 2; }
} else {
  process.stderr.write(`fake-claude-update: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
