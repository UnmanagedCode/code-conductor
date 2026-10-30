// The pty host (src/systems/ptyHost.ts + src/systems/ptyHelper.py) below the
// System layer: the node ↔ helper framing, the once-per-process probe, the
// login-shell default, what the helper reports for a program it could not
// exec — and the helper's stdio protocol driven RAW, with no ptyHost, the way a
// provider running a copy of it does (docs/systems-protocol.md §5, "The pty
// helper").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HelperFrameDecoder, PTY_HELPER_PATH, encodeHelperFrame, posixLoginShell, probePtyHelper, spawnPty,
} from '../src/systems/ptyHost.ts';
import { rmrf } from './rmrf.mjs';
import { patternBytes } from './terminalBattery.mjs';
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
      spawnPty({ interpreter: probe.interpreter, cwd, argv: [cwd], env: process.env, programEnv: {}, cols: 80, rows: 24 }, {
        onStarted: () => resolve('started'),
        onData: () => {},
        onExit: () => resolve('exited'),
        onWritten: () => {},
        onFailed: (code, message) => resolve({ code, message }),
      });
    });
    assert.equal(got.code, 'EACCES', JSON.stringify(got));
    assert.ok(got.message.includes(cwd), 'the message names the program');
  } finally {
    await rmrf(dir);
  }
});

// ── The helper's stdio protocol, raw ────────────────────────────────

const WAIT_MS = 10_000;

// The helper under `python3 -I`, in `cwd`, with this process's environment as
// its base — its frames decoded as they arrive.
function driveHelper(cwd, argv) {
  const child = spawn(probe.interpreter, ['-I', PTY_HELPER_PATH, '80', '24', '--', ...argv],
    { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new HelperFrameDecoder();
  const frames = [];
  const waiters = new Set();
  child.stdout.on('data', (chunk) => {
    frames.push(...decoder.push(chunk));
    for (const w of waiters) w();
  });
  child.stdin.on('error', () => {});
  const exited = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
  // Resolves with pred's first truthy answer over the frames so far.
  const waitFor = (pred, what, ms = WAIT_MS) => new Promise((resolve, reject) => {
    const check = () => {
      const v = pred(frames);
      if (!v) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`${what}: not within ${ms}ms; frames so far: ${frames.map((f) => f.type).join('')}`));
    }, ms);
    waiters.add(check);
    check();
  });
  const bounded = (p, what, ms = WAIT_MS) => {
    let timer;
    return Promise.race([p.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms}ms`)), ms); })]);
  };
  return {
    frames, waitFor,
    send: (type, payload = Buffer.alloc(0)) => child.stdin.write(encodeHelperFrame(type, Buffer.from(payload))),
    end: () => child.stdin.end(),
    exited: () => bounded(exited, 'the helper exiting'),
    // A row that failed midway must not leave the helper holding the file open.
    kill: () => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      for (const s of [child.stdin, child.stdout, child.stderr]) s.destroy();
    },
    output: () => Buffer.concat(frames.filter((f) => f.type === 'o').map((f) => f.payload)).toString('latin1'),
  };
}

// A fresh dir, and the helper started in it with `argv`; killed afterwards
// whatever the row did.
async function withHelper(argv, fn) {
  const dir = await mkdtemp('cc-pty-helper-raw-');
  const cwd = await fs.realpath(dir);
  const h = driveHelper(cwd, argv);
  try { return await fn(h, cwd); }
  finally {
    h.kill();
    await rmrf(dir);
  }
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const START_PROBE = ['sh', '-c', 'touch STARTED'];

// PINS: EOF before the `v` frame is the owner closing before the start — the
// helper exits 0 having started nothing and reported nothing.
test('a helper whose stdin ends before the v frame starts nothing and exits 0', { skip: NO_HELPER }, async () => {
  await withHelper(START_PROBE, async (h, cwd) => {
    h.end();
    assert.deepEqual(await h.exited(), { code: 0, signal: null });
    assert.deepEqual(h.frames.map((f) => f.type), [], 'not even S');
    assert.equal(await exists(path.join(cwd, 'STARTED')), false, 'the program never ran');
  });
});

// PINS: anything but a well-formed `v` as the FIRST frame is refused with an
// `e` frame carrying EPROTO, and the program never starts. One test per case:
// the runner's per-test teardown would close a subtest's fixtures under it.
for (const [what, type, payload] of [
  ['a d frame', 'd', 'x'],
  ['a v that is not JSON', 'v', '{'],
  ['a v that is a JSON array', 'v', '[]'],
  ['a v with a non-string value', 'v', '{"A":1}'],
]) {
  test(`a first frame that is not a well-formed v is refused EPROTO and starts nothing: ${what}`, { skip: NO_HELPER }, async () => {
    await withHelper(START_PROBE, async (h, cwd) => {
      h.send(type, payload);
      // The helper's first report decides it: `e`, or `S` / `x` for a start.
      const first = await h.waitFor((fs_) => fs_.find((f) => 'eSx'.includes(f.type)), 'the helper\'s first report');
      assert.equal(first.type, 'e', `the first report is a refusal (got ${first.type})`);
      assert.equal(JSON.parse(first.payload.toString('utf8')).code, 'EPROTO');
      assert.equal(h.frames.some((f) => f.type === 'S'), false, 'nothing started');
      h.end();
      await h.exited();
      assert.equal(await exists(path.join(cwd, 'STARTED')), false, 'the program never ran');
    });
  });
}

// PINS THE DRAIN REPORT as a stdio contract: `w` frames count `d` bytes
// written INTO the terminal, not bytes received — while the program reads
// nothing their sum stays below what was sent; once it reads, the sum reaches
// exactly what was sent, never more — and every `w` carries a u32 n ≥ 1.
test('w frames report d bytes written into the terminal, not received, and every byte is reported', { skip: NO_HELPER }, async () => {
  const N = 256 * 1024;
  const data = patternBytes(N);
  await withHelper(['sh', '-c', `stty raw -echo; echo READY; while [ ! -e GO ]; do sleep 0.01; done; head -c ${N} | sha256sum`], async (h, cwd) => {
    h.send('v', '{}');
    await h.waitFor(() => h.output().includes('READY'), 'READY');
    for (let at = 0; at < N; at += 16 * 1024) h.send('d', data.subarray(at, at + 16 * 1024));
    const reported = () => {
      let sum = 0;
      for (const f of h.frames.filter((x) => x.type === 'w')) {
        assert.equal(f.payload.length, 4, 'a w payload is a u32');
        const n = f.payload.readUInt32BE(0);
        assert.ok(n >= 1, `a w reports at least one byte (got ${n})`);
        sum += n;
        assert.ok(sum <= N, `the reports never exceed the d bytes sent (${sum} > ${N})`);
      }
      return sum;
    };
    // Far more than the terminal can hold was sent, so most of it cannot have
    // been written.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(reported() < N, `while the program reads nothing, less than was sent is reported (${reported()})`);
    await fs.writeFile(path.join(cwd, 'GO'), '');
    // The exit decides it too: once the program has gone, nothing more is written.
    await h.waitFor((fs_) => reported() === N || fs_.some((f) => f.type === 'x'), `w frames totalling ${N}`);
    assert.equal(reported(), N, 'once the program reads, every byte sent is reported');
    await h.waitFor((fs_) => fs_.some((f) => f.type === 'x'), 'the exit');
    assert.equal(reported(), N, 'and not one byte more by the end');
    const digest = /([0-9a-f]{64}) {2}-/.exec(h.output())?.[1];
    assert.equal(digest, createHash('sha256').update(data).digest('hex'), 'the bytes arrived intact');
    h.end();
    await h.exited();
  });
});
