// A PROVIDER THAT COUNTS ITS OWN WIRE, and is otherwise the provider it wraps.
//
//   node tests/recordingProvider.mjs --log <path> -- <provider argv…>
//
// Several claims in this epic are about ROUND TRIPS rather than about results:
// "a listing is ONE exec", "a warm open sends no readFile at all", "the cap
// refuses before a byte moves". None of them can be asserted on a return value
// — the right answer arrives either way — so they are asserted on the frames
// that crossed, and this is what makes those observable.
//
// It spawns the real provider and relays stdin→child and child→stdout
// UNCHANGED, appending one `<dir>\t<type>` line per frame to `--log`. Only the
// frame TYPE is recorded: a `data` frame carries 64 KiB of base64 and a log of
// payloads would be its own memory problem.
//
// Hand-written against docs/systems-protocol.md §1's framing and importing
// nothing from `src/`, for the same reason tests/fake-provider.mjs does.

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--log');
const logPath = at === -1 ? null : argv[at + 1];
const sep = argv.indexOf('--');
if (logPath === null || sep === -1) {
  process.stderr.write('recordingProvider: --log <path> -- <provider argv…>\n');
  process.exit(2);
}
writeFileSync(logPath, '');

const child = spawn(argv[sep + 1], argv.slice(sep + 2), { stdio: ['pipe', 'pipe', 'inherit'] });

// One decoder per direction. A frame is a whole line; a partial one is HELD,
// never counted twice and never dropped — the same rule the real decoder has.
function tap(dir, onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      let type = '?';
      try { type = JSON.parse(line).type ?? '?'; } catch { type = 'unparseable'; }
      onLine(`${dir}\t${type}\n`);
    }
  };
}

const record = (line) => { try { appendFileSync(logPath, line); } catch { /* the log is an instrument, never the subject */ } };

const toChild = tap('c2p', record);
process.stdin.on('data', (c) => { toChild(c); child.stdin.write(c); });
// MUST 3: the provider exits when its stdin reaches EOF. Relaying the EOF is
// what keeps that true through the wrapper.
process.stdin.on('end', () => child.stdin.end());
process.stdin.on('error', () => {});
child.stdin.on('error', () => {});

const fromChild = tap('p2c', record);
child.stdout.on('data', (c) => { fromChild(c); process.stdout.write(c); });

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on('error', (e) => { process.stderr.write(`recordingProvider: ${e.message}\n`); process.exit(2); });
