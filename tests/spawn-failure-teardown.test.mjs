// Card 2026-0286 — teardown of an instance whose subprocess NEVER STARTED.
//
// A child whose spawn FAILED emits 'error' then 'close' and never 'exit'
// (measured: error +10 ms, close +14 ms, no 'exit' ever). Instance keys its one
// terminal path on the launch's TERMINAL LATCH — 'exit' OR 'close', whichever
// arrives first — routed to _handleExit, and kill() awaits that latch. Keying on
// 'exit' alone strands the instance with a live `proc` whose pid is undefined,
// and `proc != null` is this codebase's liveness oracle (liveForSession /
// isSessionLive), so every reaper — kill, remove, shutdown, respawn, the resume
// manifest — reads the corpse as alive.
//
// INVARIANTS PINNED HERE, in TWO KINDS — named as such, because the distinction
// decides what each test can and cannot catch. Once a failure has SETTLED
// (`proc === null`), `kill()`'s `if (!this.proc) return` fires AHEAD of the latch
// await, and `remove()`/`shutdown()` hit the same guard. So a test that waits for
// settle as a precondition asserts the end state and never reaches the await.
//
//   LATCH PINS — entered INSIDE the race window: 'error' delivered (the launch is
//   doomed) but the terminal 'close' NOT yet, so `proc` is still assigned, the
//   early-out cannot fire, and the await is the only way out. This is the state
//   the card measured.
//     T3  InstanceManager.shutdown() returns          ← the card's TITLE behaviour
//     T4  kill() resolves off 'close' alone, leaving no ref'd timer
//     T6  InstanceManager.remove() returns            ← the MCP kill_instance body
//     T5  the normal path: one healthy kill runs _handleExit EXACTLY once though
//         both 'exit' and 'close' fire, and leaves no ref'd timer. Asserted ONE
//         MACROTASK after kill() resolves — kill()'s continuation is a microtask
//         off 'exit', while the fake child's 'close' is a later setImmediate, so
//         asserting immediately would count only the first terminal event and a
//         double-run of _handleExit would go unseen.
//
//   EARLY-OUT / INTEGRATION CHECKS — they pin the settled end state and its
//   consequences, not the await. Each is red on the base tree because `proc` never
//   becomes null there, i.e. they fail at the settle barrier rather than at the
//   operation each is named for.
//     T1  a failed spawn ends with proc null, pid null, status crashed, and the
//         ring carrying spawn_error THEN exit
//     T2  kill() on an ALREADY-settled failure resolves — the early-out itself
//     T7  the liveness oracles read false, so MCP kill_instance soft-refuses
//         SESSION_NOT_LIVE instead of wedging
//     T8  MCP respawn_instance is accepted instead of 409 'instance still running'
//     T9  the real-subprocess arm agrees with the injected one
//     T11 the resume manifest carries NO entry for a session that never ran
//
// Two launchers deliberately. The real-subprocess arm proves the fake models the
// true event shape; the injected arm is REQUIRED, not merely cheaper, because
// the T4 race window is unreachable through CLAUDE_BIN (the real `close` lands
// at +14 ms, well inside create()'s await chain).
//
// Every wait is BOUNDED and rejects on timeout via within() — a regression must
// turn `npm test` red with a named test, never wedge the run. tests/run.mjs's
// hang guard is a backstop, never the assertion.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { killInstance, respawnInstance } from '../src/mcp/handlers.ts';
import { drainToManifest } from '../src/resumeRestart.ts';
import { clearResumeManifest } from '../src/resumeManifest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-no-turn.json');
const QUIET = { warn() {}, log() {}, error() {} };

// A bounded await that FAILS rather than hangs. `finally` clears the timer on
// both paths — leaving it armed on the success path would itself hold the loop
// open and trip the suite's leak guard.
function within(promise, ms, label) {
  let timer;
  const expiry = new Promise((_res, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}: still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// Ref'd Timeout handles held by the event loop right now. Unref'd timers are
// EXCLUDED by getActiveResourcesInfo, so this cannot false-positive on the
// codebase's many unref'd sweeps; a DELTA across an operation is therefore a
// direct read of "did that operation leave a ref'd timer armed".
const refdTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

// A launcher whose every child reproduces a FAILED spawn, verified against real
// `child_process.spawn('/nonexistent/…')`: pid undefined, exitCode -2, stdin
// writable synchronously and dead by the time 'error' lands, stdout/stderr
// present and ended, and the only two events 'error' then 'close' — never 'exit'.
//
// `deferClose` holds the 'close' back so a test can enter kill() while `proc` is
// still assigned (T4's race window). Nothing here spawns an OS process.
class FailSpawnLauncher {
  constructor({ deferClose = false } = {}) {
    this.children = [];
    this.deferClose = deferClose;
  }
  launch() {
    const child = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    // A failed spawn never had a process, so there is nothing to signal.
    child.kill = () => false;
    let closed = false;
    child.deliverClose = () => {
      if (closed) return;
      closed = true;
      child.exitCode = -2;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', -2, null);
    };
    const defer = this.deferClose;
    // Deferred a tick: Instance wires its readline + 'exit'/'error' listeners
    // AFTER launch() returns, so nothing may emit synchronously.
    setImmediate(() => {
      try { child.stdin.destroy(); } catch { /* ignore */ }
      child.emit('error', Object.assign(
        new Error('spawn /nonexistent/definitely-not-claude ENOENT'), { code: 'ENOENT' }));
      if (!defer) child.deliverClose();
    });
    this.children.push(child);
    return child;
  }
  get last() { return this.children[this.children.length - 1]; }
}

const sysOf = (inst, subtype) =>
  inst.ring.toArray().filter(e => e.kind === 'system' && e.subtype === subtype);

// ── injected fail-spawn launcher ─────────────────────────────────────────────
describe('an instance whose spawn failed (injected launcher)', () => {
  let ctx, instances, launcher, home;

  before(async () => {
    launcher = new FailSpawnLauncher();
    ctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
    ({ instances } = ctx);
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    const r = await freshProjectsRoot();
    home = r.home;
    ctx.projectsRoot = r.projectsRoot;
    ctx.claudeProjectsRoot = r.claudeProjectsRoot;
    launcher.deferClose = false;
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  });
  afterEach(async () => {
    // Drop the registry DIRECTLY rather than via shutdown(): a stranded
    // spawn-failure instance is exactly what wedges shutdown() (T3), and
    // bootServer's close() calls it too — so a regression must not be able to
    // hang teardown and turn named failures into "no verdict". Nothing leaks:
    // a failed spawn owns no OS process and no redirect.
    for (const inst of [...instances.byId.values()]) instances.byId.delete(inst.id);
    clearResumeManifest();
    await rmrf(home);
  });

  // The failure is delivered during create(), so the ring — not an 'event'
  // listener attached afterwards — is the only place to read it from.
  const failed = () => instances.create({ project: 'demo', mode: 'bypassPermissions' });

  // Park an instance INSIDE the race window and hand back the trigger that
  // leaves it. 'error' has landed (the launch is doomed, status crashed) but the
  // terminal 'close' has not, so `proc` is still assigned — the state the card
  // measured, and the ONLY state in which a reaper reaches the latch await
  // instead of short-circuiting on `if (!this.proc) return`.
  //
  // Call the reaper FIRST and `deliverClose()` second: reversing them settles
  // the instance ahead of the call and silently degrades the test into the
  // early-out check T2 already owns.
  async function inRaceWindow(label) {
    launcher.deferClose = true;
    const inst = await failed();
    await within(waitFor(() => inst.status === 'crashed'), 3000, `${label} window`);
    assert.ok(inst.proc, `${label}: still inside the race window — proc is assigned`);
    return { inst, deliverClose: launcher.last.deliverClose };
  }

  test('T1 a failed spawn ends proc null, pid null, crashed, ring spawn_error then exit', async () => {
    const inst = await failed();
    await within(waitFor(() => inst.proc === null), 3000, 'T1 proc null');
    assert.equal(inst.pid, null, 'pid cleared');
    assert.equal(inst.status, 'crashed');
    assert.ok(inst.sessionId, 'the session was minted before the spawn failed');
    const ring = inst.ring.toArray().filter(e => e.kind === 'system');
    const iErr = ring.findIndex(e => e.subtype === 'spawn_error');
    const iExit = ring.findIndex(e => e.subtype === 'exit');
    assert.ok(iErr >= 0, 'spawn_error emitted');
    assert.ok(iExit > iErr, `a TERMINAL exit follows it (ring: ${ring.map(e => e.subtype).join(',')})`);
    assert.equal(ring[iExit].data.code, -2);
    assert.equal(ring[iExit].data.signal, null);
  });

  test('T2 kill() on a settled spawn failure resolves', async () => {
    const inst = await failed();
    await within(waitFor(() => inst.proc === null), 3000, 'T2 settle');
    // graceMs is LOAD-BEARING and must stay above tests/hangGuardConfig.mjs's
    // LEAK_GRACE_MS (15 s): a leaked SIGTERM/SIGKILL timer only outlives the
    // suite's leak guard when graceMs > 15_000. Tidying this down to a small
    // number silently disarms half of what T2/T4/T5 pin.
    await within(inst.kill({ graceMs: 30_000 }), 2000, 'T2 kill');
  });

  // The card's TITLE behaviour, and the shape it was filed from: a shutdown()
  // that hangs with `proc` still assigned. It must be driven from inside the
  // window — waiting for settle first makes the instance's own kill() early-out
  // and shutdown() never touches the latch.
  test('T3 InstanceManager.shutdown() returns from inside the race window', async () => {
    const { inst, deliverClose } = await inRaceWindow('T3');
    const done = instances.shutdown();
    deliverClose();
    await within(done, 3000, 'T3 shutdown');
    assert.equal(inst.proc, null, 'the close routed to _handleExit');
  });

  test('T4 kill() inside the race window resolves off close alone, leaking no timer', async () => {
    const { inst, deliverClose } = await inRaceWindow('T4');
    const before = refdTimers();
    // See T2 on why 30_000 and not a small number.
    const killed = inst.kill({ graceMs: 30_000 });
    deliverClose();
    await within(killed, 2000, 'T4 kill');
    assert.equal(inst.proc, null, 'the close routed to _handleExit');
    // A kill that settles via 'close' must not leave its SIGTERM/SIGKILL timers
    // armed — that would hold the loop open in the very path whose job is to let
    // the process go. An 'exit'-keyed clear never runs here; a `finally` does.
    assert.equal(refdTimers() - before, 0, 'no ref\'d timer outlived the settled kill');
  });

  // Same window, and this one is the MCP kill_instance body.
  test('T6 InstanceManager.remove() returns from inside the race window', async () => {
    const { inst, deliverClose } = await inRaceWindow('T6');
    const done = instances.remove(inst.id);
    deliverClose();
    await within(done, 3000, 'T6 remove');
    assert.equal(instances.get(inst.id), undefined, 'forgotten');
    assert.equal(inst.proc, null, 'the close routed to _handleExit');
  });

  test('T7 the liveness oracles read false and MCP kill_instance soft-refuses', async () => {
    const inst = await failed();
    await within(waitFor(() => inst.proc === null), 3000, 'T7 settle');
    assert.equal(instances.isSessionLive(inst.sessionId), false, 'isSessionLive');
    assert.equal(instances.liveForSession(inst.sessionId), null, 'liveForSession');
    // Reclassified, not cured: getInst is LIVE-only and the instance is now
    // correctly not-live, so this is the documented strict-live contract acting
    // on a worker that never started. Recovery is respawn_instance (T8).
    const r = await within(
      killInstance({ sessionId: inst.sessionId }, { instances }), 3000, 'T7 kill_instance');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SESSION_NOT_LIVE');
  });

  test('T8 MCP respawn_instance is accepted, not 409 instance still running', async () => {
    const inst = await failed();
    await within(waitFor(() => inst.proc === null), 3000, 'T8 settle');
    const r = await within(
      respawnInstance({ sessionId: inst.sessionId }, { instances }), 5000, 'T8 respawn');
    assert.equal(r.ok, undefined, `a summary, not a refusal: ${JSON.stringify(r)}`);
    assert.equal(r.sessionId, inst.sessionId);
  });

  test('T11 the resume manifest carries no entry for a session that never ran', async () => {
    const inst = await failed();
    await within(waitFor(() => inst.proc === null), 3000, 'T11 settle');
    const entries = await within(
      drainToManifest({ instances, log: QUIET, graceMs: 50 }), 5000, 'T11 drain');
    assert.equal(
      entries.filter(e => e.sessionId === inst.sessionId).length, 0,
      'a spawn-failed session must not be resurrected on the next boot',
    );
  });
});

// ── the normal path, unchanged ───────────────────────────────────────────────
describe('a healthy instance killed normally', () => {
  let ctx, instances, home;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ instances } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    const r = await freshProjectsRoot();
    home = r.home;
    ctx.projectsRoot = r.projectsRoot;
    ctx.claudeProjectsRoot = r.claudeProjectsRoot;
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  });
  afterEach(async () => { await instances.shutdown(); await rmrf(home); });

  test('T5 one kill runs _handleExit exactly once and leaves no ref\'d timer', async () => {
    const inst = await instances.create({ project: 'demo', mode: 'bypassPermissions' });
    await within(waitFor(() => inst.status === 'idle'), 5000, 'T5 idle');
    const before = refdTimers();
    // See T2 on why the grace is above LEAK_GRACE_MS (15 s) — a small value here
    // would make the timer-delta assertion vacuous.
    await within(inst.kill({ graceMs: 20_000 }), 5000, 'T5 kill');
    // SETTLE ONE MACROTASK, and it MUST be setImmediate — not setTimeout(0).
    // kill()'s continuation is a MICROTASK off the synchronous resolve in the
    // 'exit' handler, while FakeChildProcess._finish
    // (tests/inProcessLauncher.mjs) queues the 'close'-emitting setImmediate
    // INSIDE the 'exit'-emitting one. Check-phase FIFO therefore GUARANTEES
    // 'close' is delivered before this later-queued callback; a setTimeout(0)
    // would rest on loop-phase reasoning instead, which that guarantee does not
    // cover. Assert without any settle and only the FIRST terminal event has
    // landed (measured: ["exit"] at kill()-resolve, ["exit","close"] one
    // setImmediate later) — so a latch that lost its one-shot flag would
    // double-run _handleExit and the count below would still read 1.
    await new Promise((r) => setImmediate(r));
    // The fake child emits BOTH 'exit' and 'close'. The latch is one-shot, so
    // the single terminal path runs once: two exit rows would mean two
    // _handleExit runs (two _redirect.close()s, two temp archives).
    assert.equal(sysOf(inst, 'exit').length, 1, 'exactly one terminal exit');
    assert.equal(inst.proc, null);
    assert.equal(refdTimers() - before, 0, 'no ref\'d timer outlived the settled kill');
  });
});

// ── real subprocess, unresolvable CLAUDE_BIN ─────────────────────────────────
// The honest end-to-end: a real child_process spawn against a path that does not
// exist, proving the injected launcher above models the true event shape rather
// than a shape invented to match the fix.
describe('an instance whose real spawn failed (unresolvable CLAUDE_BIN)', () => {
  let ctx, instances, home, savedBin;

  before(async () => {
    ctx = await bootServer({ realProcess: true, scenarioPath: SCENARIO });
    ({ instances } = ctx);
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    const r = await freshProjectsRoot();
    home = r.home;
    ctx.projectsRoot = r.projectsRoot;
    ctx.claudeProjectsRoot = r.claudeProjectsRoot;
    savedBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = '/nonexistent/definitely-not-claude';
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  });
  afterEach(async () => {
    process.env.CLAUDE_BIN = savedBin;
    // Same reason as the injected arm: teardown must not be able to wedge.
    for (const inst of [...instances.byId.values()]) instances.byId.delete(inst.id);
    await rmrf(home);
  });

  test('T9 a real failed spawn settles terminally and kill() resolves', async () => {
    const inst = await instances.create({ project: 'demo', mode: 'bypassPermissions' });
    await within(waitFor(() => inst.proc === null), 5000, 'T9 settle');
    assert.equal(inst.pid, null);
    assert.equal(inst.status, 'crashed');
    assert.equal(sysOf(inst, 'spawn_error').length, 1, 'the ENOENT reason was surfaced');
    const exits = sysOf(inst, 'exit');
    assert.equal(exits.length, 1, 'exactly one terminal exit');
    assert.equal(exits[0].data.code, -2, 'the real spawn-failure exit code');
    // See T2 on why the grace is above LEAK_GRACE_MS (15 s).
    await within(inst.kill({ graceMs: 30_000 }), 2000, 'T9 kill');
  });
});
