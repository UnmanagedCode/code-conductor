#!/usr/bin/env node
// A provider that advertises `pty` and NEVER returns input credit
// (docs/systems-protocol.md §5, "Input credit") — the cc side of the input
// window, observed on the wire.
//
//   node noCreditPtyProvider.mjs --record <file> [--over-ack]
//
// It is a stand-in, not a passthrough: no program ever runs. Every pty exec is
// answered `ptyStarted` and then nothing; every plain exec is answered `exit 0`
// at once, so a test can use one as a BARRIER — cc writes frames to the pipe in
// order and this fixture records each one before it answers the next, so once a
// plain exec has returned every frame cc sent before it is in the recording.
//
// Recorded, one JSON line per frame: every `input`, `resize` and `close`.
//
// `--over-ack` answers the FIRST `input` of each pty id with an `inputAck` for
// one byte more than that frame carried — a credit grant past what cc sent,
// which rule 6 makes a protocol violation.

import { appendFileSync } from 'node:fs';
import { PROTOCOL_VERSION } from '../../src/systems/protocol.ts';

let record = null;
let overAck = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--record') record = process.argv[++i];
  else if (process.argv[i] === '--over-ack') overAck = true;
  else {
    process.stderr.write(`noCreditPtyProvider: unknown argument ${JSON.stringify(process.argv[i])}\n`);
    process.exit(1);
  }
}
if (!record) {
  process.stderr.write('noCreditPtyProvider: --record <file> is required\n');
  process.exit(1);
}

const answer = (f) => process.stdout.write(`${JSON.stringify(f)}\n`);
const overAcked = new Set();

function handle(f) {
  if (f.type === 'hello') {
    answer({ type: 'hello', protocol: PROTOCOL_VERSION, provider: 'no-credit-pty/1', capabilities: { pty: true } });
  } else if (f.type === 'exec' && f.pty) {
    answer({ type: 'ptyStarted', id: f.id });
  } else if (f.type === 'exec') {
    answer({ type: 'exit', id: f.id, code: 0, signal: null, timedOut: false });
  } else if (f.type === 'input' || f.type === 'resize' || f.type === 'close') {
    // Synchronous, so the recording is on disk before any later answer.
    appendFileSync(record, `${JSON.stringify(f)}\n`);
    if (overAck && f.type === 'input' && !overAcked.has(f.id)) {
      overAcked.add(f.id);
      answer({ type: 'inputAck', id: f.id, bytes: Buffer.from(f.dataB64, 'base64').length + 1 });
    }
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
