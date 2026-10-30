// THE `pty` FALLBACK (docs/systems-protocol.md §2): a provider that does not
// advertise the capability is refused SYSTEM_NO_PTY with NOTHING on the wire,
// whether it was told `--no-pty` or simply has no python3; and the three ways a
// pty target can misbehave — no terminal (EPTY), an open that never starts
// (ETIMEDOUT), output past the credit window (EPROTO) — each end by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PTY_WINDOW_BYTES } from '../src/systems/protocol.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { REFERENCE_PROVIDER } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const RECORDING = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const SPEC = { argv: ['cat'], cols: 80, rows: 24, term: 'xterm' };
const HANDLERS = { onData() {}, onExit() {} };

async function withDir(fn) {
  const dir = await mkdtemp('cc-pty-fallback-');
  try { return await fn(await fs.realpath(dir)); }
  finally { await rmrf(dir); }
}

async function recorded(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The recording is appended as frames arrive, so a frame cc has just sent may
// still be on its way.
async function settleRecorded(file, pred, ms = 5_000) {
  const until = Date.now() + ms;
  for (;;) {
    const frames = await recorded(file);
    if (pred(frames) || Date.now() > until) return frames;
    await new Promise(r => setTimeout(r, 20));
  }
}

const isPtyFrame = (f) => (f.type === 'exec' && 'pty' in f) || ['input', 'resize', 'ack'].includes(f.type);

// PINS: `--no-pty` is advertised as `pty:false`, and cc then refuses the open
// SYSTEM_NO_PTY (501) naming the system and its provider — without one pty
// exec, input, resize or ack frame reaching it.
test('a provider without pty is refused SYSTEM_NO_PTY and is sent no pty frame', async () => {
  await withDir(async (cwd) => {
    const record = path.join(cwd, 'wire.ndjson');
    const sys = new ProviderSystem({
      id: 'no-pty-box', launch: { argv: [process.execPath, RECORDING, '--record', record, '--no-pty'] },
    });
    try {
      await sys.connect();
      assert.equal(sys.handshake.capabilities.pty, false, 'the flag is what it advertises');
      for (let i = 0; i < 2; i++) {
        await assert.rejects(sys.openTerminal({ ...SPEC, cwd }, HANDLERS),
          (e) => e.statusCode === 501 && e.code === 'SYSTEM_NO_PTY'
            && e.message.includes("'no-pty-box'") && e.message.includes(sys.handshake.provider));
      }
      // The same connection still serves everything else.
      assert.equal((await sys.exec({ argv: ['true'] }, { cwd })).code, 0);
    } finally {
      sys.dispose();
    }
    const frames = await recorded(record);
    assert.ok(frames.some((f) => f.type === 'exec'), 'the recording saw the exec, so it is live');
    assert.deepEqual(frames.filter(isPtyFrame), [], 'no pty frame was put on the wire');
  });
});

// PINS: a reference provider whose PATH holds no python3 advertises `pty:false`
// on its own — no flag — and is refused like one told `--no-pty`.
test('a reference provider with no python3 on its PATH advertises no pty', async () => {
  await withDir(async (cwd) => {
    const bin = path.join(cwd, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    const sys = new ProviderSystem({
      id: 'no-python-box',
      launch: { argv: [process.execPath, REFERENCE_PROVIDER], env: { ...process.env, PATH: bin } },
    });
    try {
      await sys.connect();
      assert.equal(sys.handshake.capabilities.pty, false);
      await assert.rejects(sys.openTerminal({ ...SPEC, cwd }, HANDLERS),
        (e) => e.statusCode === 501 && e.code === 'SYSTEM_NO_PTY' && e.message.includes("'no-python-box'"));
    } finally {
      sys.dispose();
    }
  });
});

// PINS: a target that cannot allocate a terminal rejects the open as a
// SystemError EPTY, and the failed open holds no slot — with a cap of ONE, the
// second attempt is EPTY again, never TERMINAL_LIMIT.
test('a target that cannot allocate a terminal rejects EPTY and frees the slot', async () => {
  await withDir(async (cwd) => {
    const record = path.join(cwd, 'wire.ndjson');
    const sys = new ProviderSystem({
      id: 'epty-box', maxTerminals: 1,
      launch: { argv: [process.execPath, RECORDING, '--record', record, '--pty-fake', 'epty'] },
    });
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(sys.openTerminal({ ...SPEC, cwd }, HANDLERS),
          (e) => e.name === 'SystemError' && e.code === 'EPTY' && /out of pseudo-terminals/.test(e.message),
          `attempt ${i}`);
      }
    } finally {
      sys.dispose();
    }
    const execs = (await recorded(record)).filter((f) => f.type === 'exec' && f.pty);
    assert.equal(execs.length, 2, 'each attempt really sent a pty exec');
    assert.deepEqual(execs[0].pty, { cols: 80, rows: 24, term: 'xterm' }, 'the pty spec as sent, with no overlay');
    assert.deepEqual(execs[0].argv, ['cat']);
    assert.equal('shell' in execs[0] || 'env' in execs[0] || 'timeoutMs' in execs[0] || 'stdin' in execs[0], false,
      'a pty exec carries none of the plain exec\'s shell, env, timeoutMs or stdin');
  });
});

// PINS: a pty open the provider never answers is bounded by the op ceiling: it
// rejects ETIMEDOUT, a `close` goes out for its id, and its slot is freed —
// with a cap of ONE, the second attempt times out too, never TERMINAL_LIMIT.
test('a pty open the provider never answers rejects ETIMEDOUT, closes its id and frees the slot', async () => {
  await withDir(async (cwd) => {
    const record = path.join(cwd, 'wire.ndjson');
    const sys = new ProviderSystem({
      id: 'silent-box', maxTerminals: 1, defaultOpTimeoutMs: 300,
      launch: { argv: [process.execPath, RECORDING, '--record', record, '--pty-fake', 'silent'] },
    });
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(sys.openTerminal({ ...SPEC, cwd }, HANDLERS),
          (e) => e.name === 'SystemError' && e.code === 'ETIMEDOUT' && /300ms/.test(e.message), `attempt ${i}`);
      }
    } finally {
      sys.dispose();
    }
    const opened = (frames) => frames.filter((f) => f.type === 'exec' && f.pty).map((f) => f.id);
    const frames = await settleRecorded(record, (fs_) => {
      const ids = opened(fs_);
      return ids.length === 2 && ids.every((id) => fs_.some((f) => f.type === 'close' && f.id === id));
    });
    const ids = opened(frames);
    assert.equal(ids.length, 2, 'each attempt sent a pty exec');
    for (const id of ids) {
      assert.ok(frames.some((f) => f.type === 'close' && f.id === id), `a close was sent for ${id}`);
    }
  });
});

// PINS: cc ENFORCES the credit window. A provider that sends more unacked
// stdout than PTY_WINDOW_BYTES has the terminal closed and ended `failed`
// EPROTO — at once, while paused, delivering none of what it held — and the
// slot is freed while the connection stays up.
test('stdout past the credit window ends the terminal failed EPROTO', async () => {
  await withDir(async (cwd) => {
    const record = path.join(cwd, 'wire.ndjson');
    const sys = new ProviderSystem({
      id: 'overflow-box', maxTerminals: 1,
      launch: { argv: [process.execPath, RECORDING, '--record', record, '--pty-fake', 'overflow'] },
    });
    try {
      let delivered = 0;
      let endWith;
      const ended = new Promise((r) => { endWith = r; });
      const terminal = await sys.openTerminal({ ...SPEC, cwd }, {
        onData: (b) => { delivered += b.length; },
        onExit: endWith,
      });
      // Paused, so nothing is acked and everything sent is unacked.
      terminal.pause();
      terminal.write('go');
      const end = await ended;
      assert.equal(end.kind, 'failed');
      assert.equal(end.error.code, 'EPROTO');
      assert.match(end.error.message, new RegExp(`${PTY_WINDOW_BYTES}-byte window`));
      terminal.resume();
      assert.equal(delivered, 0, 'nothing a contract-breaking provider sent is delivered');
      const frames = await settleRecorded(record, (fs_) => fs_.some((f) => f.type === 'close'));
      const id = frames.find((f) => f.type === 'exec' && f.pty).id;
      assert.ok(frames.some((f) => f.type === 'close' && f.id === id), 'a close was sent for the terminal');
      assert.equal(frames.some((f) => f.type === 'ack'), false, 'nothing was acked while paused');
      // The slot is free (cap of one) and the connection still serves.
      const again = await sys.openTerminal({ ...SPEC, cwd }, HANDLERS);
      again.close();
      assert.equal((await sys.exec({ argv: ['true'] }, { cwd })).code, 0);
    } finally {
      sys.dispose();
    }
  });
});
