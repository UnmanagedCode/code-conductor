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

// ── The handshake MUSTs, enforced rather than assumed ────────────────

test('an id-carrying frame BEFORE the hello is refused, not routed', async () => {
  // MUST: a provider answers the handshake before any other frame. A provider
  // streaming output for an id cc has not opened is not one cc can reason
  // about, so the violation is named rather than silently eaten.
  const sys = fakeSystem('early-frame');
  try {
    await assert.rejects(() => sys.connect(), (e) => {
      assert.equal(e.code, 'EPROTO', e.message);
      assert.match(e.message, /before its hello/);
      return true;
    });
  } finally { sys.dispose(); }
});

test('a SECOND hello is refused — the handshake happens exactly once', async () => {
  // The two hellos usually arrive in ONE chunk, so the violation lands between
  // the handshake resolving and #connect recording it. A connection marked up
  // with no child behind it would accept the operation below and then wait out
  // its whole deadline, so `connect` itself must fail — and must fail with the
  // reason the channel actually went down, not a generic one.
  const sys = fakeSystem('double-hello');
  try {
    await assert.rejects(() => sys.connect(), (e) => {
      assert.equal(e.code, 'EPROTO', e.message);
      assert.match(e.message, /second hello/);
      return true;
    });
    assert.equal(sys.handshake, null, 'a torn-down handshake is not recorded as up');
  } finally { sys.dispose(); }
});

test('a second hello that arrives AFTER the handshake still fails the next operation', async () => {
  // The other ordering of the same violation. Whichever way the frames land,
  // the refusal reaches a caller — it is never swallowed and never a hang.
  const sys = fakeSystem('late-hello');
  try {
    await sys.connect();
    await assert.rejects(() => sys.readFile('/whatever'), (e) => {
      assert.equal(e.code, 'EPROTO', e.message);
      assert.match(e.message, /second hello/);
      return true;
    });
  } finally { sys.dispose(); }
});

test('a hello with no absolute system.shell is refused at the handshake', async () => {
  // `system.shell` is the only descriptor field cc ACTS on. Accepting '' here
  // defers the failure to the first redirected shell, where it surfaces as an
  // obscure spawn error with nothing pointing at the handshake.
  const sys = fakeSystem('bad-shell');
  try {
    await assert.rejects(() => sys.connect(), (e) => {
      assert.equal(e.code, 'EPROTO', e.message);
      assert.match(e.message, /absolute system\.shell/);
      return true;
    });
  } finally { sys.dispose(); }
});

// ── A corrupted payload is a corrupted frame ─────────────────────────

test('a payload that is not valid base64 fails the operation instead of truncating it', async () => {
  // `Buffer.from(s,'base64')` stops at the first unreadable character and
  // returns the prefix. Decoding without a check would report exit 0 with
  // silently truncated stdout — a wrong answer where the taxonomy requires a
  // named refusal.
  for (const mode of ['bad-b64', 'no-datab64']) {
    const sys = fakeSystem(mode);
    try {
      await sys.connect();
      const r = await sys.exec({ argv: ['whatever'] }, { cwd: os.tmpdir() });
      assert.equal(r.code, 1, `${mode}: not a success`);
      assert.match(r.spawnError, /EPROTO|base64|dataB64/, `${mode}: ${r.spawnError}`);
      assert.equal(r.stdout, '', `${mode}: the unreadable prefix is not handed back as output`);
    } finally { sys.dispose(); }
  }
});

// ── No operation is unbounded ────────────────────────────────────────

test('every operation a mute provider accepts is bounded, not just the ones a caller timed', async () => {
  // A provider that completes the handshake and then answers nothing. Before
  // this fence, readFile, writeFile and every derived operation waited for
  // ever — with no ETRANSPORT and no refusal, just a promise that never
  // settled. These run at boot (project listing, git status), so the hang was
  // reachable from a cold start.
  await tmp(async (dir) => {
    const sys = fakeSystem('wedge', { defaultOpTimeoutMs: 400 });
    try {
      await sys.connect();
      const started = Date.now();
      await assert.rejects(() => sys.readFile('/whatever'), (e) => {
        assert.equal(e.code, 'ETIMEDOUT', e.message);
        return true;
      }, 'readFile');
      await assert.rejects(() => sys.writeFile('/whatever', 'x'), (e) => e.code === 'ETIMEDOUT', 'writeFile');
      // A DERIVED operation: it is an exec cc issues with no caller timeout at
      // all, so it is bounded only by the same fence.
      await assert.rejects(() => sys.stat('/whatever'), (e) => e.code === 'ETIMEDOUT', 'stat');
      await assert.rejects(() => sys.readDir('/whatever'), (e) => e.code === 'ETIMEDOUT', 'readDir');
      await assert.rejects(() => sys.realpath('/whatever'), (e) => e.code === 'ETIMEDOUT', 'realpath');
      await assert.rejects(() => sys.mkdir('/whatever'), (e) => e.code === 'ETIMEDOUT', 'mkdir');
      await assert.rejects(() => sys.removeTree('/whatever'), (e) => e.code === 'ETIMEDOUT', 'removeTree');
      await assert.rejects(() => sys.unlink('/whatever'), (e) => e.code === 'ETIMEDOUT', 'unlink');
      await assert.rejects(() => sys.chmod('/whatever', 0o644), (e) => e.code === 'ETIMEDOUT', 'chmod');
      // And a caller `exec` with NO timeout of its own, which is what runGit is.
      const r = await sys.exec({ argv: ['whatever'] }, { cwd: dir });
      assert.equal(r.timedOut, true, 'an untimed exec is bounded by the same fence');
      assert.equal(r.code, 124);
      assert.ok(Date.now() - started < 30_000, 'all of it inside the fence, none of it a hang');
    } finally { sys.dispose(); }
  });
});

test('one failed launch is ONE failure, however many callers were waiting on it', async () => {
  // The backoff window is derived from the failure count, so counting a single
  // failed launch once per waiting caller would shorten nothing and lengthen
  // the window geometrically while reporting attempts that never happened.
  await tmp(async (dir) => {
    const countFile = path.join(dir, 'launches');
    let now = 1_000;
    const sys = fakeSystem('boom', { countFile, clock: { now: () => now }, restartBaseMs: 500 });
    try {
      const settled = await Promise.allSettled([sys.connect(), sys.connect(), sys.connect()]);
      assert.deepEqual(settled.map(r => r.status), ['rejected', 'rejected', 'rejected']);
      assert.equal((await fs.readFile(countFile, 'utf8')).trim(), '1', 'three callers, one launch');
      now += 1;
      await assert.rejects(() => sys.connect(), (e) => {
        assert.match(e.message, /1 failed attempt\(s\), next retry in 499ms/,
          `three waiting callers must not compound into three failures: ${e.message}`);
        return true;
      });
    } finally { sys.dispose(); }
  });
});
