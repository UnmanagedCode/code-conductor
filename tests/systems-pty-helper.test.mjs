// The pty host (src/systems/ptyHost.ts + src/systems/ptyHelper.py) below the
// System layer: the node ↔ helper framing, the once-per-process probe, the
// login-shell default, and what the helper reports for a program it could not
// exec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HelperFrameDecoder, encodeHelperFrame, posixLoginShell, probePtyHelper, spawnPty,
} from '../src/systems/ptyHost.ts';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// PINS: frames survive any chunking — one per byte, several per chunk — and an
// empty payload is a frame, not a gap.
test('helper frames round-trip whatever the chunking', () => {
  const frames = [
    ['S', Buffer.alloc(0)],
    ['o', Buffer.from('hello\r\n')],
    ['x', Buffer.from(JSON.stringify({ code: 0, signal: null }))],
    ['o', Buffer.alloc(70_000, 0x78)],
  ];
  const wire = Buffer.concat(frames.map(([t, p]) => encodeHelperFrame(t, p)));
  assert.equal(wire.length, frames.reduce((n, [, p]) => n + 5 + p.length, 0), '1 type byte + u32 length + payload');
  assert.equal(wire.readUInt32BE(1), 0, 'the length is big-endian');
  const expect = frames.map(([type, payload]) => ({ type, payload }));

  const whole = new HelperFrameDecoder().push(wire);
  assert.deepEqual(whole, expect, 'one chunk carrying every frame');

  const dec = new HelperFrameDecoder();
  const split = [];
  for (let i = 0; i < 40; i++) split.push(...dec.push(wire.subarray(i, i + 1)));
  split.push(...dec.push(wire.subarray(40)));
  assert.deepEqual(split, expect, 'a byte at a time, then the rest');
});

// PINS: the probe runs ONCE per interpreter name — the same promise every time
// — and a different name is a different probe.
test('the probe is memoised per interpreter name', () => {
  assert.equal(probePtyHelper(), probePtyHelper());
  assert.equal(probePtyHelper({ python: 'python3' }), probePtyHelper());
  assert.notEqual(probePtyHelper({ python: 'python3-absent-cc-helper-test' }), probePtyHelper());
});

// PINS: an interpreter that is not there is a reason, not a throw, and the
// reason names it.
test('an absent interpreter probes ok:false with a reason naming it', async () => {
  const r = await probePtyHelper({ python: 'python3-absent-cc-helper-test-2' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /python3-absent-cc-helper-test-2 not found on PATH/);
});

const probe = await probePtyHelper();
const NO_HELPER = probe.ok ? false : `this host cannot run the pty helper: ${probe.reason}`;

// PINS: a good probe answers the interpreter's ABSOLUTE path, which is what a
// terminal then spawns.
test('a good probe answers an absolute interpreter path', { skip: NO_HELPER }, () => {
  assert.ok(path.isAbsolute(probe.interpreter), probe.interpreter);
});

// PINS: the default program is the user's shell, as a login shell.
test('the login shell is the user\'s shell with -l', () => {
  const [shell, flag, ...rest] = posixLoginShell();
  assert.ok(path.isAbsolute(shell), shell);
  assert.equal(flag, '-l');
  assert.deepEqual(rest, []);
});

// PINS: the helper reports WHY a program could not be exec'd, by errno name —
// a directory is EACCES, as execvp says — and nothing starts.
test('a program the helper cannot exec fails with its errno name', { skip: NO_HELPER }, async () => {
  const dir = await mkdtemp('cc-pty-helper-');
  try {
    const cwd = await fs.realpath(dir);
    const got = await new Promise((resolve) => {
      spawnPty({ interpreter: probe.interpreter, cwd, argv: [cwd], env: process.env, cols: 80, rows: 24 }, {
        onStarted: () => resolve('started'),
        onData: () => {},
        onExit: () => resolve('exited'),
        onFailed: (code, message) => resolve({ code, message }),
      });
    });
    assert.equal(got.code, 'EACCES', JSON.stringify(got));
    assert.ok(got.message.includes(cwd), 'the message names the program');
  } finally {
    await rmrf(dir);
  }
});
