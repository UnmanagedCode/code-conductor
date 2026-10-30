#!/usr/bin/env node
// A provider that RECORDS what cc sent it, and is otherwise the real thing.
//
// Some claims are about a frame cc must NOT emit — "an older provider is never
// handed a `remoteId`", say. Those cannot be checked from cc's side or from a
// result: the only honest evidence is the bytes that crossed the pipe. So this
// is a passthrough around the reference provider that appends every CLIENT
// frame, verbatim, one JSON line per frame, to the file named by `--record`.
//
//   node recordingProvider.mjs --record <file> [--pty-fake <mode>] [reference provider flags…]
//
// `--pty-fake` stands in for a pty target that misbehaves in one named way: the
// hello advertises `pty` whatever the provider said, and every pty exec is
// answered HERE, never reaching the provider. Modes:
//   epty      — `error {code: EPTY}`: the target cannot allocate a terminal.
//   silent    — nothing, ever: an open that never starts.
//   overflow  — `ptyStarted`, then on the id's first `input`, one chunk more
//               stdout than PTY_WINDOW_BYTES with no ack waited for.
//   window    — `ptyStarted`, then per `input`: an `a` in it sends EXACTLY
//               PTY_WINDOW_BYTES of stdout, a `b` sends ONE byte — neither
//               waits for an ack, so the test decides where the boundary is.
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
import { CHUNK_BYTES, PTY_WINDOW_BYTES } from '../../src/systems/protocol.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

let record = null;
let ptyFake = null;
const passThrough = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--record') record = process.argv[++i];
  else if (process.argv[i] === '--pty-fake') ptyFake = process.argv[++i];
  else passThrough.push(process.argv[i]);
}
if (ptyFake !== null && !['epty', 'silent', 'overflow', 'window'].includes(ptyFake)) {
  process.stderr.write(`recordingProvider: unknown --pty-fake mode ${JSON.stringify(ptyFake)}\n`);
  process.exit(1);
}
if (!record) {
  process.stderr.write('recordingProvider: --record <file> is required\n');
  process.exit(1);
}

const child = spawn(process.execPath, [REFERENCE, ...passThrough], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
if (ptyFake === null) child.stdout.pipe(process.stdout);
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
    if (ptyFake !== null && fakePty(JSON.parse(line))) continue;
    child.stdin.write(line + '\n');
  }
});

process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });

// The pty ids this fixture answered itself, so their follow-on frames stay here.
const fakeIds = new Set();
const flooded = new Set();
const answer = (f) => process.stdout.write(`${JSON.stringify(f)}\n`);

// True when the frame was a fake pty's and has been answered here.
function fakePty(f) {
  if (f.type === 'exec' && f.pty) {
    fakeIds.add(f.id);
    if (ptyFake === 'epty') {
      answer({ type: 'error', id: f.id, code: 'EPTY', message: 'openpty: out of pseudo-terminals (recordingProvider --pty-fake epty)' });
    } else if (ptyFake === 'overflow' || ptyFake === 'window') {
      answer({ type: 'ptyStarted', id: f.id });
    }
    return true;
  }
  if (!fakeIds.has(f.id)) return false;
  if (ptyFake === 'overflow' && f.type === 'input' && !flooded.has(f.id)) {
    flooded.add(f.id);
    const chunk = Buffer.alloc(CHUNK_BYTES, 0x78).toString('base64');
    for (let seq = 0; seq * CHUNK_BYTES <= PTY_WINDOW_BYTES; seq++) {
      answer({ type: 'stdout', id: f.id, seq, dataB64: chunk });
    }
  }
  if (ptyFake === 'window' && f.type === 'input') {
    const text = Buffer.from(f.dataB64, 'base64').toString('utf8');
    const send = (bytes) => {
      for (let at = 0; at < bytes; at += CHUNK_BYTES) {
        const n = Math.min(CHUNK_BYTES, bytes - at);
        answer({ type: 'stdout', id: f.id, seq: seqs.get(f.id) ?? 0, dataB64: Buffer.alloc(n, 0x77).toString('base64') });
        seqs.set(f.id, (seqs.get(f.id) ?? 0) + 1);
      }
    };
    if (text.includes('a')) send(PTY_WINDOW_BYTES);
    if (text.includes('b')) send(1);
  }
  return true;
}
const seqs = new Map();
