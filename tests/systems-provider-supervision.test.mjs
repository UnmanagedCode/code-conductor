// Supervision: what happens when the provider is not there, or is there and
// lying.
//
// A remote system is a machine that goes away. The contract this file pins is
// that every failure mode of the CHANNEL becomes a reported failure of an
// OPERATION, promptly — never a hang, never a silent success, and never a
// caller left holding a promise on a pipe that will not answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { providerArgv } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fake-provider.mjs');

function fakeSystem(mode, { countFile, code, ...opts } = {}) {
  const argv = ['node', FAKE, '--mode', mode];
  if (countFile) argv.push('--count-file', countFile);
  if (code) argv.push('--code', code);
  return new ProviderSystem({ id: 'fake', launch: { argv }, ...opts });
}

async function tmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-supervision-'));
  try { return await fn(dir); } finally { await rmrf(dir); }
}

test('a provider speaking a protocol version cc does not is REFUSED, naming both versions', async () => {
  const sys = fakeSystem('bad-version');
  try {
    await assert.rejects(() => sys.connect(), (e) => {
      assert.equal(e.code, 'EPROTO');
      assert.match(e.message, /99/);
      assert.match(e.message, /cc speaks 1/);
      return true;
    });
  } finally { sys.dispose(); }
});

test('a provider that never answers the handshake times out instead of hanging', async () => {
  const sys = fakeSystem('silent', { handshakeTimeoutMs: 150 });
  try {
    const started = Date.now();
    await assert.rejects(() => sys.connect(), (e) => e.code === 'ETIMEDOUT');
    assert.ok(Date.now() - started < 5_000, 'the wait is bounded by the handshake timeout');
  } finally { sys.dispose(); }
});

test('a malformed line kills the channel: in-flight operations fail EPROTO', async () => {
  // Not skipped and not tolerated. A stream that has proved it cannot be framed
  // cannot be trusted for the frames after it either.
  const sys = fakeSystem('garbage');
  try {
    await sys.connect();
    // `wedge`-like: this fake answers nothing, so the operation is still open
    // when the garbage line arrives and the teardown reaches it.
    await assert.rejects(() => sys.readFile('/whatever'), (e) => {
      assert.equal(e.code, 'EPROTO', e.message);
      return true;
    });
  } finally { sys.dispose(); }
});

test('an id-less error frame is CONNECTION-level: it fails everything with its code', async () => {
  const sys = fakeSystem('conn-error', { code: 'ETRANSPORT' });
  try {
    await sys.connect();
    await assert.rejects(() => sys.readFile('/whatever'), (e) => {
      assert.equal(e.code, 'ETRANSPORT', e.message);
      assert.match(e.message, /channel fault/, "the provider's own words reach the caller");
      return true;
    });
  } finally { sys.dispose(); }
});

test('a provider that dies mid-operation fails it at once, then is restarted for the next one', async () => {
  await tmp(async (dir) => {
    const countFile = path.join(dir, 'launches');
    const sys = fakeSystem('crash-once', { countFile });
    try {
      await sys.connect();
      // A rejecting operation reports ETRANSPORT…
      await assert.rejects(() => sys.readFile('/whatever'), (e) => {
        assert.equal(e.code, 'ETRANSPORT', e.message);
        assert.match(e.message, /exited/);
        return true;
      });
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '1');
      // …and the next operation brings the provider back. Supervision is
      // restart-on-demand: nothing reconnects a channel nobody is using.
      const r = await sys.readFile('/whatever');
      assert.equal(r, 'fake launch 2', 'the second launch answered');
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '2');
      assert.equal(sys.handshake.provider, 'fake-crash-once/0.1.0', 'the handshake was redone');
    } finally { sys.dispose(); }
  });
});

test('exec still NEVER rejects when the channel dies under it — the death is a spawnError', async () => {
  // Every caller of System.exec branches on the result; one of the two
  // implementations throwing instead would be a behaviour difference in the
  // primitive itself.
  await tmp(async (dir) => {
    const sys = fakeSystem('crash-once', { countFile: path.join(dir, 'launches') });
    try {
      await sys.connect();
      const r = await sys.exec({ argv: ['whatever'] }, { cwd: dir });
      assert.equal(r.code, 1);
      assert.match(r.spawnError, /exited/);
      assert.equal(r.timedOut, false);
    } finally { sys.dispose(); }
  });
});

test('a restart storm is REFUSED inside its backoff window, and retried after it', async () => {
  await tmp(async (dir) => {
    const countFile = path.join(dir, 'launches');
    let now = 1_000;
    const sys = fakeSystem('boom', {
      countFile,
      clock: { now: () => now },
      restartBaseMs: 500,
      restartMaxMs: 5_000,
    });
    try {
      await assert.rejects(() => sys.connect(), (e) => e.code === 'ETRANSPORT');
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '1');

      // Inside the window: refused WITHOUT another launch. A caller told
      // "unreachable" now beats a caller held open across a restart storm.
      now += 100;
      await assert.rejects(() => sys.connect(), (e) => {
        assert.equal(e.code, 'ETRANSPORT');
        assert.match(e.message, /next retry in 400ms/);
        return true;
      });
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '1', 'no second process was spawned');

      // Past the window: it tries again, and the backoff doubles.
      now += 500;
      await assert.rejects(() => sys.connect(), (e) => e.code === 'ETRANSPORT');
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '2');
      now += 100;
      await assert.rejects(() => sys.connect(), (e) => {
        assert.match(e.message, /next retry in 900ms/, 'the backoff grows: 500 → 1000');
        return true;
      });
    } finally { sys.dispose(); }
  });
});

test('a wedged provider turns a bounded command into a reported timeout, not a hang', async () => {
  // The provider owns the timeout; cc arms a slack backstop only so a provider
  // that answers NOTHING cannot make a bounded command unbounded.
  await tmp(async (dir) => {
    const sys = fakeSystem('wedge');
    try {
      await sys.connect();
      const started = Date.now();
      const r = await sys.exec({ argv: ['whatever'] }, { cwd: dir, timeoutMs: 100 });
      assert.equal(r.timedOut, true);
      assert.equal(r.code, 124);
      const waited = Date.now() - started;
      assert.ok(waited > 100, 'cc gives the provider its own deadline first');
      assert.ok(waited < 20_000, `the backstop fired (waited ${waited}ms)`);
    } finally { sys.dispose(); }
  });
});

test('a duplicate terminal frame for a settled id is dropped, not a crash or a second answer', async () => {
  await tmp(async (dir) => {
    const sys = fakeSystem('double-exit');
    try {
      await sys.connect();
      const r = await sys.exec({ argv: ['whatever'] }, { cwd: dir });
      assert.equal(r.code, 0, 'the FIRST terminal frame is the answer');
      // The channel must still be usable: a late frame for a closed id is a
      // race cc's own `close` creates by design, not a protocol violation.
      const again = await sys.exec({ argv: ['whatever'] }, { cwd: dir });
      assert.equal(again.code, 0);
      assert.equal(again.stdout, 'fake launch 1\n', 'still the same provider process');
    } finally { sys.dispose(); }
  });
});

test('a provider EXITS when its stdin closes — that is the whole of its lifecycle', async () => {
  // The rule that makes provider reaping automatic: cc closes the pipe (or
  // dies) and the provider goes with it.
  const child = spawn(providerArgv()[0], providerArgv().slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdin.write(`${JSON.stringify({ type: 'hello', protocol: 1, client: 'test' })}\n`);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('the provider outlived its stdin')), 5_000))]);
  assert.equal(code, 0);
});

test('dispose() takes the provider process down with it', async () => {
  const sys = new ProviderSystem({ id: 'ref', launch: { argv: providerArgv() } });
  await sys.connect();
  const r = await sys.exec({ argv: ['sh', '-c', 'echo $PPID'] }, { cwd: os.tmpdir() });
  const providerPid = Number(r.stdout.trim());
  assert.ok(providerPid > 0);
  sys.dispose();
  const until = Date.now() + 5_000;
  let live = true;
  while (Date.now() < until && live) {
    try { process.kill(providerPid, 0); await new Promise(r2 => setTimeout(r2, 25)); }
    catch { live = false; }
  }
  assert.equal(live, false, 'the provider process is gone');
});
