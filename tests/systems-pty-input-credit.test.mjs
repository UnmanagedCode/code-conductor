// INPUT CREDIT, cc's side (docs/systems-protocol.md §5, "Input credit"): what
// cc puts on the wire, and what its caller sees, against a provider that
// grants no credit at all (tests/fixtures/noCreditPtyProvider.mjs) — and one
// that grants more than cc sent.
//
// What a real provider grants, and when, is the conformance suite's: see
// tests/systems-protocol-conformance.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CHUNK_BYTES } from '../src/systems/protocol.ts';
import * as protocol from '../src/systems/protocol.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'noCreditPtyProvider.mjs');
const SPEC = { argv: ['cat'], cols: 80, rows: 24, term: 'xterm' };

function windowBytes() {
  const W = protocol.PTY_INPUT_WINDOW_BYTES;
  assert.equal(typeof W, 'number', 'PTY_INPUT_WINDOW_BYTES is exported');
  return W;
}

// `barrier()` is a plain exec on the same connection: the fixture records each
// frame before it answers a later one, so once it returns, every frame cc sent
// before it is in `recorded()`.
async function withFixture(flags, fn, opts = {}) {
  const dir = await mkdtemp('cc-pty-input-credit-');
  const cwd = await fs.realpath(dir);
  const record = path.join(cwd, 'wire.ndjson');
  const sys = new ProviderSystem({
    id: 'no-credit-box', ...opts, launch: { argv: [process.execPath, FIXTURE, '--record', record, ...flags] },
  });
  const barrier = async () => assert.equal((await sys.exec({ argv: ['true'] }, { cwd, stdin: 'ignore' })).code, 0);
  const recorded = async () => (await fs.readFile(record, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    await fn({ sys, cwd, barrier, recorded });
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

const inputs = (frames) => frames.filter((f) => f.type === 'input');
const inputBytes = (frames) => inputs(frames).reduce((n, f) => n + Buffer.from(f.dataB64, 'base64').length, 0);

// PINS rule 2, at its boundary: with no credit returned, cc puts EXACTLY one
// window of input on the wire — a write one byte past it sends the window and
// holds the last byte — and never an `input` frame above CHUNK_BYTES.
test('a terminal granted no credit gets exactly one input window on the wire', async () => {
  const W = windowBytes();
  await withFixture([], async ({ sys, cwd, barrier, recorded }) => {
    const terminal = await sys.openTerminal({ ...SPEC, cwd }, { onData() {}, onExit() {} });
    terminal.write(Buffer.alloc(W + 1, 0x61));
    await barrier();
    const frames = await recorded();
    assert.equal(inputBytes(frames), W, 'one window and not one byte more');
    assert.ok(inputs(frames).every((f) => Buffer.from(f.dataB64, 'base64').length <= CHUNK_BYTES),
      'no input frame is above CHUNK_BYTES');
    terminal.close();
  });
});

// PINS rule 7: credit starvation stalls input only — a `resize` and a `close`
// still go out, and the close ends the terminal `closed`.
test('credit starvation blocks neither resize nor close', async () => {
  const W = windowBytes();
  await withFixture([], async ({ sys, cwd, barrier, recorded }) => {
    let end = null;
    const terminal = await sys.openTerminal({ ...SPEC, cwd }, { onData() {}, onExit(e) { end = e; } });
    terminal.write(Buffer.alloc(W + 1, 0x61));
    await barrier();
    const id = inputs(await recorded())[0].id;
    terminal.resize(100, 40);
    terminal.close();
    await barrier();
    const frames = await recorded();
    assert.ok(frames.some((f) => f.type === 'resize' && f.id === id && f.cols === 100 && f.rows === 40),
      'the resize went out');
    assert.ok(frames.some((f) => f.type === 'close' && f.id === id), 'the close went out');
    assert.deepEqual(end, { kind: 'closed' });
  });
});

// PINS rule 7, the caller's view: with no credit, `write` reports backpressure,
// `onDrain` never fires, and cc does NOT end the terminal — not even past the
// op ceiling, which bounds only the open.
test('a terminal granted no credit reports backpressure, never drains, and is not failed by cc', async () => {
  const W = windowBytes();
  const OP_MS = 200;
  await withFixture([], async ({ sys, cwd, barrier }) => {
    let drains = 0;
    let end = null;
    const terminal = await sys.openTerminal({ ...SPEC, cwd }, {
      onData() {}, onExit(e) { end = e; }, onDrain() { drains += 1; },
    });
    assert.equal(terminal.write(Buffer.alloc(W + 1, 0x61)), false, 'write reports backpressure');
    await barrier();
    await new Promise((r) => setTimeout(r, 3 * OP_MS));
    assert.equal(drains, 0, 'nothing drained: no credit came back');
    assert.equal(end, null, 'cc did not end the terminal');
    terminal.close();
    assert.deepEqual(end, { kind: 'closed' });
  }, { defaultOpTimeoutMs: OP_MS });
});

// PINS rule 6: an `inputAck` granting more than cc has sent ends that terminal
// `failed` EPROTO and sends `close` for it — and the connection carries on.
test('an inputAck past what cc sent ends the terminal failed EPROTO, and the connection carries on', async () => {
  await withFixture(['--over-ack'], async ({ sys, cwd, barrier, recorded }) => {
    let endWith;
    const ended = new Promise((r) => { endWith = r; });
    const terminal = await sys.openTerminal({ ...SPEC, cwd }, { onData() {}, onExit: endWith });
    terminal.write('x');
    let timer;
    const end = await Promise.race([
      ended.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the terminal did not end within 5000ms')), 5_000); }),
    ]);
    assert.equal(end.kind, 'failed');
    assert.equal(end.error.code, 'EPROTO');
    await barrier();
    const frames = await recorded();
    const id = inputs(frames)[0].id;
    assert.ok(frames.some((f) => f.type === 'close' && f.id === id), 'a close was sent for the terminal');
  });
});
