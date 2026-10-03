// Fake `claude auth …` for the Claude-login tests. Run as
//   CLAUDE_BIN="<node> tests/fake-claude-auth.mjs"
// Every string it prints is the real CLI's (captured from `claude auth status`
// and `claude auth login` over plain pipes), so the parsers under test meet the
// shapes they meet in production.
//
//   auth status [--json]   prints FAKE_AUTH_STATUS verbatim, exits
//                          FAKE_AUTH_STATUS_EXIT (default 0). The real CLI exits
//                          1 when signed out but still prints the JSON.
//   auth login             by FAKE_AUTH_LOGIN_MODE:
//     normal (default)     banner + `visit: <url>` + the prompt with no trailing
//                          newline, then one stdin line at a time:
//                            GOOD#STATE  → exit 0
//                            no `#`      → "Invalid code…" on stderr, keep reading
//                            otherwise   → "Login failed: …400" on stderr, exit 1
//                          stdin EOF is IGNORED — the real CLI hangs there.
//     ignore-term          normal, but SIGTERM is ignored (only SIGKILL ends it)
//     hang                 prints nothing, waits forever
//     exit-before-url      a stderr line, exit 1
//
// FAKE_AUTH_RECORD=<file>: writes {argv, pid, env} as the first line at start
// and appends each received stdin line as `{"line": …}`.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAKE_LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fake&code_challenge_method=S256&state=STATE';

function main() {
  const argv = process.argv.slice(2);
  const record = process.env.FAKE_AUTH_RECORD;
  const rec = (obj) => { if (record) fs.appendFileSync(record, JSON.stringify(obj) + '\n'); };
  rec({
    argv, pid: process.pid,
    env: { BROWSER: process.env.BROWSER ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null },
  });

  if (argv[0] !== 'auth') { process.stderr.write(`fake-claude-auth: unsupported argv ${JSON.stringify(argv)}\n`); process.exit(2); }

  if (argv[1] === 'status') {
    process.stdout.write((process.env.FAKE_AUTH_STATUS ?? '') + '\n');
    process.exitCode = Number(process.env.FAKE_AUTH_STATUS_EXIT ?? 0);
    return;
  }

  if (argv[1] !== 'login') { process.stderr.write(`fake-claude-auth: unsupported argv ${JSON.stringify(argv)}\n`); process.exit(2); }

  const mode = process.env.FAKE_AUTH_LOGIN_MODE ?? 'normal';
  // Keeps the process alive past stdin EOF, as the real CLI does.
  const keepAlive = () => setInterval(() => {}, 1 << 30);
  if (mode === 'hang') { keepAlive(); return; }
  if (mode === 'exit-before-url') {
    process.stderr.write('Login failed: unable to reach the authorization server\n');
    process.exit(1);
  }

  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write(`If the browser didn't open, visit: ${FAKE_LOGIN_URL}\n`);
  process.stdout.write('Paste code here if prompted > ');
  keepAlive();

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      rec({ line });
      if (line === 'GOOD#STATE') process.exit(0);
      if (!line.includes('#')) {
        process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
        continue;
      }
      process.stderr.write('Login failed: Request failed with status code 400\n');
      process.exit(1);
    }
  });
}

// Imported by the tests for FAKE_LOGIN_URL; only a direct run plays the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
