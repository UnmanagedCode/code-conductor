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
// UNCHANGED, appending one `<epoch-ms>\t<dir>\t<type>` line per frame to
// `--log`.
//
// THE TIMESTAMP IS WHAT MAKES OVERLAP A MEASUREMENT. A round-trip count and a
// wall time give a concurrency factor only by DIVISION — a residual fitted to
// the one number the decomposition exists to explain, with no free parameter
// left to check it against. Pairing each request frame with its reply gives
// ΣRTᵢ directly, and ΣRTᵢ / wall IS the mean in-flight depth. Only the
// frame TYPE is recorded: a `data` frame carries 64 KiB of base64 and a log of
// payloads would be its own memory problem.
//
// AN `exec` IS TAGGED `exec:argv` OR `exec:shell`, and that one bit is what
// makes a union measurement attributable. cc's DERIVATIONS are all `argv`
// (`env LC_ALL=C find …`); a REDIRECTED BASH command is `shell`. Both ride the
// same handle to the same box, so a bare `exec` count cannot say which cost
// belongs to the union's transport and which to the worker's own commands. The
// tag is the frame's SHAPE, never its contents — a command line is the worker's
// and does not belong in a log.
//
// Hand-written against docs/systems-protocol.md §1's framing and importing
// nothing from `src/`, for the same reason tests/fake-provider.mjs does.

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

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
  // A `StringDecoder` RATHER THAN `chunk.toString('utf8')`, because a decode
  // per chunk turns a multi-byte character split across a chunk boundary into
  // U+FFFD — the line then fails to parse and counts as `unparseable`. Every
  // path in this repo is ASCII today, so it is latent; it is fixed rather than
  // noted because the error direction UNDER-COUNTS `readFile`, which is
  // precisely the direction that would flatter the revalidate claim this
  // instrument exists to check.
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buf += decoder.write(chunk);
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      let type = '?';
      let f = null;
      try {
        f = JSON.parse(line);
        type = f.type ?? '?';
        // The one discriminator, and it is structural: a derivation carries
        // `argv`, a redirected shell command carries `shell`.
        if (type === 'exec') type = Array.isArray(f.argv) ? 'exec:argv' : 'exec:shell';
      } catch { type = 'unparseable'; f = null; }
      // The id too, when the frame carries one: an in-flight interval needs
      // its request paired with its own reply, and cc multiplexes by id.
      const id = typeof f?.id === 'string' ? f.id : '';
      onLine(`${Date.now()}\t${dir}\t${type}\t${id}\n`);
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
