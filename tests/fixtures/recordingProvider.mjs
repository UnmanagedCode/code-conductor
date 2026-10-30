#!/usr/bin/env node
// A provider that RECORDS what cc sent it, and is otherwise the real thing.
//
// Some claims are about a frame cc must NOT emit — "an older provider is never
// handed a `remoteId`", say. Those cannot be checked from cc's side or from a
// result: the only honest evidence is the bytes that crossed the pipe. So this
// is a passthrough around the reference provider that appends every CLIENT
// frame, verbatim, one JSON line per frame, to the file named by `--record`.
//
//   node recordingProvider.mjs --record <file> [--pty-epty] [reference provider flags…]
//
// `--pty-epty` stands in for a target that cannot allocate a terminal: the
// hello advertises `pty` whatever the provider said, and every pty exec is
// answered `error {code: EPTY}` here instead of reaching the provider.
//
// Nothing downstream is touched — the provider's answers are the real
// provider's own — so a test recording the wire is otherwise running exactly
// the configuration it asked for. Appended (not truncated) so a restarted
// provider adds to the same transcript rather than erasing what cc sent the
// generation before.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

let record = null;
let ptyEpty = false;
const passThrough = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--record') record = process.argv[++i];
  else if (process.argv[i] === '--pty-epty') ptyEpty = true;
  else passThrough.push(process.argv[i]);
}
if (!record) {
  process.stderr.write('recordingProvider: --record <file> is required\n');
  process.exit(1);
}

const child = spawn(process.execPath, [REFERENCE, ...passThrough], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
if (!ptyEpty) child.stdout.pipe(process.stdout);
else {
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      let f = null;
      try { f = JSON.parse(line); } catch { /* not ours to judge */ }
      if (f?.type === 'hello') f.capabilities = { ...f.capabilities, pty: true };
      process.stdout.write(`${f?.type === 'hello' ? JSON.stringify(f) : line}\n`);
    }
  });
}
child.on('exit', () => process.exit(0));

// Line-delimited, so a frame is only recorded once it is whole — a partial
// frame in the transcript would read as a frame cc never sent.
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    // Synchronous: the recording must be on disk before the answer this frame
    // provokes reaches cc, or a test that reads it after its own await races.
    appendFileSync(record, line + '\n');
    if (ptyEpty) {
      const f = JSON.parse(line);
      if (f.type === 'exec' && f.pty) {
        process.stdout.write(`${JSON.stringify({
          type: 'error', id: f.id, code: 'EPTY', message: 'openpty: out of pseudo-terminals (recordingProvider --pty-epty)',
        })}\n`);
        continue;
      }
    }
    child.stdin.write(line + '\n');
  }
});

process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });
