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
import { DEFAULT_OP_TIMEOUT_MS, ProviderSystem } from '../src/systems/providerSystem.ts';
import { providerArgv } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fake-provider.mjs');

function fakeSystem(mode, { countFile, code, pidFile, ...opts } = {}) {
  const argv = ['node', FAKE, '--mode', mode];
  if (countFile) argv.push('--count-file', countFile);
  if (code) argv.push('--code', code);
  if (pidFile) argv.push('--pid-file', pidFile);
  return new ProviderSystem({ id: 'fake', launch: { argv }, ...opts });
}

async function tmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-supervision-'));
  try { return await fn(dir); } finally { await rmrf(dir); }
}

// Copied rather than imported from tests/helpers.mjs: that module pulls in
// server.ts, and this suite deliberately boots nothing.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function settle(pred, ms = 5_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

// A pid a command wrote for itself, once the write has landed.
async function pidFrom(file) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    try {
      const pid = Number((await fs.readFile(file, 'utf8')).trim());
      if (pid > 0) return pid;
    } catch { /* not written yet */ }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`no pid appeared in ${file}`);
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

// A LIVE operation at teardown is what the SIGKILL could not reap (card
// 2026-0268 §A): an idle login shell dies with its stdin pipe, but a shell
// running a foreground command is not reading stdin and never sees the close.
// The three pins below are the two halves of that, plus the fallback for a
// provider that ignores EOF entirely.

// PINS: after dispose(), neither the provider's login shell nor a command still
// running inside it survives — cc reaps a BUSY provider, not only an idle one.
// NOT CLAIMING: anything about a provider that ignores stdin EOF (the deaf-mode
// test below owns that), and nothing about grandchildren when processGroupSignal
// is false — that is the advertised descendantsMaySurvive limit.
test('dispose() reaps a shell that is still running a command', async () => {
  await tmp(async (dir) => {
    const sys = new ProviderSystem({ id: 'ref', launch: { argv: providerArgv() } });
    const cwd = await fs.realpath(dir);
    const pidFile = path.join(cwd, 'cmd.pid');
    let running;
    try {
      await sys.connect();
      const sh = sys.shell({ cwd });
      // Braces, not a subshell: `$$` is the login shell the provider launched.
      const shellPid = Number((await sh.run('echo $$')).stdout.trim());
      assert.ok(shellPid > 0, 'the login shell named itself');
      // Deliberately not awaited — and its rejection is swallowed at creation,
      // because the dispose below is what fails it (ESHELLGONE, the documented
      // close-mid-command behaviour) and that is the point of the test.
      running = sh.run(`sleep 30 & echo $! > ${pidFile}; wait`).catch(() => {});
      const cmdPid = await pidFrom(pidFile);
      sys.dispose();
      assert.equal(await settle(() => !alive(shellPid)), true, 'the login shell was reaped');
      assert.equal(await settle(() => !alive(cmdPid)), true, 'and so was the command inside it');
    } finally {
      sys.dispose();
      await running?.catch(() => {});
    }
  });
});

// PINS: the reaping covers an `exec` a caller started directly, not only one a
// redirected shell started — they are different cc-side call sites, and they
// leak independently.
// NOT CLAIMING: anything about how exec's promise settles; it never rejects, by
// design.
test('dispose() reaps an exec that is still in flight', async () => {
  await tmp(async (dir) => {
    const sys = new ProviderSystem({ id: 'ref', launch: { argv: providerArgv() } });
    const cwd = await fs.realpath(dir);
    const pidFile = path.join(cwd, 'cmd.pid');
    let running;
    try {
      await sys.connect();
      // Deliberately not awaited. exec never rejects, so nothing to swallow.
      running = sys.exec({ shell: `sleep 30 & echo $! > ${pidFile}; wait` }, { cwd });
      const cmdPid = await pidFrom(pidFile);
      sys.dispose();
      assert.equal(await settle(() => !alive(cmdPid)), true, 'the in-flight command was reaped');
    } finally {
      sys.dispose();
      await running?.catch(() => {});
    }
  });
});

// TWO graces, not one, and their windows are DISJOINT — that is the whole
// instrument. A single grace can only pin "somewhere between a bit and a lot":
// with the deadline hardwired to its 2000ms default and the injected value
// ignored, a lone `>= 200ms` assertion still passes at 2081ms. No single
// hardwired constant can sit inside both [200,750] and [950,1500], so the pair
// excludes every FIXED deadline — which one bound cannot — rather than merely
// showing that some wait happened. That, exactly, is what it establishes.
//
// The windows come from the failure they have to catch, the way the 2000ms
// default itself was chosen. FLOOR = grace-50ms: the timer cannot fire early,
// so this tolerates only clock coarseness. CEILING = grace+500ms: the overhead
// above the grace measured 8-31ms under 12 CPU spinners, and up to ~130ms in a
// loaded whole-suite run, so the ceiling is ~4x the worst healthy tail observed
// and still 581ms clear of the 2081ms a hardwired default produces.
const REAP_GRACES = [
  { graceMs: 250, floorMs: 200, ceilingMs: 750 },
  { graceMs: 1_000, floorMs: 950, ceilingMs: 1_500 },
];

// PINS: BOTH branches of the reap — a provider in breach of the EOF-exit MUST is
// still terminated, AND the graceful attempt genuinely happens rather than being
// decorative. The floor makes the two branches distinguishable (without it an
// unconditional SIGKILL passes); the disjoint pair makes the deadline DEPEND on
// the injected value, by ruling out every hardwired constant (without it one
// passes).
// NOT CLAIMING: that a deaf provider's children are reaped. They cannot be —
// that is precisely the loss the EOF-exit MUST exists to prevent. Nor that the
// DEFAULT grace is any particular length: these are injected values, and the
// default is a judgement call, not an invariant. Nor that cc waits EXACTLY the
// grace it was given: the windows carry deliberate load tolerance, so a
// transform of the injected value that lands inside both is not excluded —
// `max(grace, 500ms)` is the measured example. Tightening them to catch it
// would collide with the ~130ms loaded overhead above, trading a contrived
// transform for a real flake, and the option has no caller but this test.
test('a provider that ignores stdin EOF is still SIGKILLed, on the grace it was given', async () => {
  for (const { graceMs, floorMs, ceilingMs } of REAP_GRACES) {
    await tmp(async (dir) => {
      const pidFile = path.join(dir, 'provider.pid');
      const sys = fakeSystem('deaf', { pidFile, shutdownGraceMs: graceMs });
      try {
        await sys.connect();
        const pid = await pidFrom(pidFile);
        const t0 = Date.now();
        sys.dispose();
        assert.equal(await settle(() => !alive(pid)), true,
          `grace ${graceMs}ms: the fallback fired — a deaf provider is still terminated`);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= floorMs,
          `grace ${graceMs}ms: it was given its chance to exit first, not SIGKILLed on the spot (${elapsed}ms < ${floorMs}ms)`);
        assert.ok(elapsed <= ceilingMs,
          `grace ${graceMs}ms: cc waited THE INJECTED grace, not some other one (${elapsed}ms > ${ceilingMs}ms)`);
      } finally { sys.dispose(); }
    });
  }
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

// T8 — THE INVERSE OF A REFUSAL THIS FILE USED TO CARRY, and the reason it is
// this rather than an inversion. The hello once REQUIRED a `system` object whose
// `shell` was an absolute path, refused EPROTO at the handshake; card 2026-0312
// deleted the whole descriptor, because `shell` was the only field cc ever acted
// on (it opened the long-lived shell) and the other three had zero readers
// before that card.
//
// INVERTING the old test would have pinned NOTHING: "a hello without an absolute
// `system.shell` is accepted" passes for a tree that still has the validation,
// as long as the fake sends a valid value — and it would pass trivially for
// ever. So what is asserted is the strictly stronger thing: a hello with NO
// `system` KEY AT ALL connects, and the System it yields WORKS.
//
// RECORDED, because a future reader must not mistake this for a ruling: it says
// nothing reads the descriptor today, NOT that cc has decided it never will. An
// unknown key is ignored by contract, so a future consumer simply re-adds the
// field it needs at no compatibility cost.
// THE OTHER DIRECTION, and it is what C5's deletion actually rests on: a
// provider that STILL SENDS the descriptor must connect unchanged. Every
// provider written before card 2026-0312 does, so refusing one — or letting a
// stray field reach any decode path that rejects — would break every existing
// third-party provider on upgrade, which is the one thing D12 does not license.
//
// The spec rule this pins is stated separately from the unknown-capability-key
// and unknown-frame-type ones in docs/systems-protocol.md §2, because it IS a
// third rule: an unknown FIELD on a KNOWN frame is ignored.
//
// NOT CLAIMING that cc reads any of it — it reads none, which is the test above.
test('a hello that still carries the deleted system descriptor connects, and is ignored', async () => {
  const sys = fakeSystem('legacy-hello');
  try {
    const hs = await sys.connect();
    assert.equal('system' in hs, false, 'the stray field reaches no recorded handshake');
    assert.deepEqual(hs.capabilities.processGroupSignal, true, 'and the fields cc DOES read still arrive');
  } finally { sys.dispose(); }
});

test('a hello with no system descriptor at all connects', async () => {
  const sys = fakeSystem('ok');
  try {
    const hs = await sys.connect();
    assert.equal('system' in hs, false, 'cc records no descriptor, because it reads none');
    assert.match(hs.provider, /^fake-ok\//);
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

// ── No `exec` operation is unbounded ─────────────────────────────────
//
// SCOPED TO `exec`/`readFile`/`writeFile`, which is what this file exercises.
// There is no longer any exception: the redirected shell's `exec` carries a
// `timeoutMs` like every other, and what supplies it is `ProviderShell`'s
// per-command ceiling, tested in tests/systems-shell-framing.test.mjs
// (card 2026-0305 §6; the `openStream` exception went with card 2026-0312).

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
        // The message reports THIS HANDLE's ceiling, not a literal. That is
        // what lets a surface test read the number back out of an ETIMEDOUT
        // and know which ceiling fired.
        assert.match(e.message, /within 400ms/, e.message);
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

// PINS THE VALUE OF THE FENCE, and nothing else. The fence's EXISTENCE is
// pinned by the test above; that DEFAULT_OP_TIMEOUT_MS is what an unconfigured
// handle actually falls back to, and that ORCH_OP_TIMEOUT_MS is read, are
// pinned at a surface in tests/systems-op-timeout.test.mjs — three claims,
// three killers.
//
// The literal is hardcoded here on purpose: reading it from the module would
// assert the constant equals itself. Do not set ORCH_OP_TIMEOUT_MS for this
// file; the override exists and this is the unoverridden default.
//
// 60 s, not the 10 min it was: the ceiling is what a caller that named no
// deadline waits out against a provider that answers nothing, and cc's own
// project listing pays three of them in sequence (card 2026-0299 §2).
test('the default operation ceiling is 60s', () => {
  assert.equal(DEFAULT_OP_TIMEOUT_MS, 60_000);
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

// PINS: cc bounds what it KEEPS from a readFile, whatever the provider sends.
// The per-file cap validates the length cc ASKS for; it does nothing about a
// provider that over-sends, or a file that grew since the stat — and the file
// bridge's own cap protects the worker, not the orchestrator's heap. The
// accumulation happens in cc, so the fence has to be in cc.
test('a readFile that floods cc is refused by name rather than accumulated', async () => {
  const sys = fakeSystem('flood-read');
  try {
    await assert.rejects(() => sys.readFileBytes('/whatever', { length: 8 }), (e) => {
      assert.equal(e.code, 'EFBIG', `got ${e.code}: ${e.message}`);
      return true;
    });
    // The heap the operation could cost is bounded by the fence, not by how
    // long the provider keeps talking.
    assert.ok(process.memoryUsage().heapUsed < 900 * 1024 * 1024, 'cc did not accumulate without bound');
  } finally { sys.dispose(); }
});
