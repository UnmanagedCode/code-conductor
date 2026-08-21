// Regression suite for the suite hang guard (card 2026-0190).
//
// Each case runs the REAL tests/run.mjs as a subprocess against a fixture under
// tests/fixtures/hang/, with the deadlines squeezed to ~1.5-8s via the CC_TEST_*
// overrides that tests/hangGuardConfig.mjs already exposes. Nothing here
// re-implements the guard's rules: the leaked-handle predicate lives only in
// tests/handleLeakGuard.mjs and every deadline only in hangGuardConfig.mjs, so
// this file sets env and reads output. A copy of the rule here could agree with
// itself while the shipped guard was broken.
//
// Fixtures are `*.fixture.mjs`, so run.mjs's discover() (which globs
// `*.test.mjs`) never picks them up during a normal suite run — several of them
// hang or wedge by design — while an explicit argv path still runs them.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killDescendants, killPids, processesWithMarker } from './procTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run.mjs');
const fixture = name => path.join(__dirname, 'fixtures', 'hang', `${name}.fixture.mjs`);

// Squeezed deadlines shared by every case except where a test overrides one.
const LEAK_GRACE = 1500;
const FILE_KILL = 8000;   // deliberately >> LEAK_GRACE, so the two are separable
const SWEEP = 1500;
// The holder lifetime in detached-orphan.fixture.mjs, single-sourced here
// because that fixture is only valid while SWEEP is far below it.
const HOLDER_LIFETIME = 60_000;
// 12s, NOT 30s. The largest legitimate inner wait is FILE_KILL (8000), so 12s
// leaves headroom while bounding a run whose guard is BROKEN. Measured with a
// broken stall trigger at 30s: three cases fell back to the inner cap, the file
// reached 107.2s, the OUTER 90s per-file watchdog SIGKILLed it, and the report
// truncated to 9 of 12 cases — losing exactly the diagnostics naming which guard
// broke. The regression suite must not be silenceable by the regressions it
// catches.
const FAST = {
  CC_TEST_LEAK_GRACE_MS: String(LEAK_GRACE),
  CC_TEST_FILE_KILL_MS: String(FILE_KILL),
  CC_TEST_ORPHAN_SWEEP_MS: String(SWEEP),
  CC_TEST_RUN_CAP_MS: '12000',
  CC_TEST_HOLDER_LIFETIME_MS: String(HOLDER_LIFETIME),
};

// The inner runner emits a full spec report, including `tests`/`pass`/`fail`
// count lines. Those must never reach OUR stdout: an external count-based parser
// reading this suite's output would fold the inner run's totals into the outer
// run's. This card exists to make the suite legible to exactly such a parser, so
// neutralise the count lines while keeping every diagnostic line intact.
function redactTotals(out) {
  return out.replace(/^[^\S\n]*[ℹi][^\S\n]*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b.*$/gmu,
    '<inner-count-line redacted by hang-guard.test.mjs>');
}

// Runs the real runner against one fixture. Always awaits the child's exit, so
// this file never leaves a ChildProcess handle behind — Layer B is preloaded
// into this very file and would (correctly) fail it if we did.
// hardTimeoutMs is 20s, not 45s: it only fires when an inner runner never arms
// its own cap, and TWO such cases at 45s sum past the outer 90s per-file watchdog
// — which would SIGKILL this file and truncate exactly the diagnostics naming
// which guard broke. 20s keeps two comfortably under the deadline.
function runGuard(name, env = FAST, { hardTimeoutMs = 20_000, stdoutPauseMs = 0, discardStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // NODE_TEST_CONTEXT must not reach the child. node:test sets it in every
    // per-file test child, and a nested run() that sees it prints "run() is
    // being called recursively within a test file. skipping running files" and
    // silently runs NOTHING — the inner runner would report 0 tests and every
    // assertion below would fail for the wrong reason.
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [RUNNER, fixture(name)], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    // stderr is ALWAYS drained, so the guard's own diagnostics reach us even when
    // stdout is deliberately stalled below.
    child.stderr.on('data', d => { out += d; });
    const keep = d => { if (!discardStdout) out += d; };
    if (stdoutPauseMs > 0) {
      // Simulate a slow consumer (a pager, a slow disk) by reading nothing for
      // this long, so the runner's writes hit backpressure once the pipe fills.
      // We must still drain EVENTUALLY, or the child cannot close and we would be
      // testing our own deadlock instead of the guard.
      child.stdout.pause();
      setTimeout(() => { child.stdout.on('data', keep); child.stdout.resume(); },
        stdoutPauseMs).unref?.();
    } else {
      child.stdout.on('data', keep);
    }
    // Backstop so a guard regression surfaces as a failed assertion here rather
    // than as a stalled test. killDescendants FIRST: several fixtures leak a
    // busy-looping or interval-holding process, and SIGKILLing only the nested
    // runner would leave it reparented to init spinning a core forever — this
    // card's own failure class, in this card's own test.
    const bail = setTimeout(() => {
      try { killDescendants(child.pid); } catch { /* best effort */ }
      child.kill('SIGKILL');
    }, hardTimeoutMs);
    child.on('error', err => { clearTimeout(bail); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(bail);
      resolve({ code, signal, out: redactTotals(out), wallMs: Date.now() - startedAt });
    });
  });
}

// --- the leaked-process predicate, table-driven ------------------------------
//
// processesWithMarker is pure over its snapshot argument, so both directions are
// testable with synthesised rows and no real processes. This is the safety-
// critical half: over-firing here means SIGKILLing something that is not ours.

const snapOf = rows => ({
  available: true,
  byPid: new Map(rows.map(r => [r.pid, { ident: '1', argv: [], ...r }])),
  byParent: new Map(),
});
const MARK = 'cc-testrun-Abc123';
const envWith = id => `PATH=/usr/bin\0CC_TEST_RUN_ID=${id}\0HOME=/root\0`;

test('processesWithMarker matches this run\'s descendants and nothing else', () => {
  const rows = [
    { pid: 1, env: envWith(MARK) },                       // init — never, even if marked
    { pid: process.pid, env: envWith(MARK) },             // ourselves — never
    { pid: 4001, env: envWith(MARK) },                    // plain descendant
    { pid: 4002, env: envWith(MARK) },                    // detached descendant, same marker
    { pid: 4003, env: envWith('cc-testrun-Other99') },    // a DIFFERENT concurrent run
    { pid: 4004, env: 'PATH=/usr/bin\0HOME=/root\0' },   // a stranger, no marker at all
    { pid: 4005, env: '' },                               // environ unreadable (not ours)
    { pid: 4006, env: 'CC_TEST_RUN_IDX=' + MARK + '\0' }, // near-miss variable name
    // PREFIX SHARING — the cross-run fratricide case the trailing-NUL anchor
    // exists for. This marker STARTS WITH ours, so an unanchored `includes`
    // matches it and one run's sweep SIGKILLs another run's processes (measured
    // with a truncated marker: an inner runner killed the outer run's).
    { pid: 4007, env: envWith(MARK + 'XY') },
  ];
  const hits = processesWithMarker(MARK, snapOf(rows)).map(h => h.pid).sort((a, b) => a - b);
  assert.deepEqual(hits, [4001, 4002],
    'only pids carrying THIS run\'s marker, never init, ourselves, another run, or a stranger');
});

test('processesWithMarker refuses to match when it cannot see', () => {
  // No marker and no /proc are both "I cannot tell" — and must never be read as
  // "everything matches", which would SIGKILL the box.
  assert.deepEqual(processesWithMarker('', snapOf([{ pid: 4001, env: envWith(MARK) }])), []);
  // The unavailable snapshot is deliberately POPULATED with a row that WOULD
  // match. An empty byPid makes this pass with the `!snap.available` guard
  // deleted, since the loop returns [] either way — and a partially populated
  // unavailable snapshot is exactly what a /proc partial read yields, the one case
  // where that guard is all that stands between "I cannot see" and a kill list.
  assert.deepEqual(
    processesWithMarker(MARK, {
      available: false,
      byPid: new Map([[4001, { pid: 4001, ident: '1', argv: [], env: envWith(MARK) }]]),
      byParent: new Map(),
    }),
    [], 'an unavailable snapshot must yield nothing even when a row would match');
});

test('killPids re-verifies pid identity before signalling', () => {
  // The safety direction: a remembered pid may have been RECYCLED onto an
  // unrelated process by the time we act (Termux runs pid_max 32768, so a long
  // session wraps). starttime cannot collide across incarnations.
  const signalled = [];
  const kill = pid => signalled.push(pid);
  const identOf = pid => ({ 5001: 'same', 5002: 'DIFFERENT-NOW', 5003: null }[pid] ?? null);

  const killed = killPids([
    { pid: 5001, ident: 'same' },           // identity intact -> kill
    { pid: 5002, ident: 'was' },            // pid recycled    -> MUST NOT kill
    { pid: 5003, ident: 'was' },            // vanished        -> MUST NOT kill
    { pid: 5004 },                          // no ident recorded -> kill (best effort)
    { pid: 1, ident: 'same' },              // init            -> never
    { pid: 7777, ident: 'same' },           // "ourselves"     -> never
  ], { identOf, kill, self: 7777 });

  assert.deepEqual(signalled.sort((a, b) => a - b), [5001, 5004]);
  assert.deepEqual(killed.sort((a, b) => a - b), [5001, 5004],
    'the return value must report only what was actually signalled');
});

// --- the control -----------------------------------------------------------

test('a clean file passes, reports, and the guard adds no delay', async () => {
  const r = await runGuard('clean');
  assert.equal(r.code, 0, `clean fixture should exit 0:\n${r.out}`);
  assert.match(r.out, /hang-guard: 1\/1 files reported, 0 killed, 0 leaked process\(es\) swept, stream ended cleanly/);
  assert.doesNotMatch(r.out, /handle-leak-guard:/);
  assert.doesNotMatch(r.out, /NO REPORT/);
  assert.doesNotMatch(r.out, /STREAM STALLED/);
});

test("the guard's own timers cannot outlive the run", async () => {
  // A ref'd cap timer that teardown fails to clear would hang EVERY clean run
  // for the full cap. With the cap set to an hour, a clean run must still finish
  // in seconds.
  const r = await runGuard('clean', { ...FAST, CC_TEST_RUN_CAP_MS: '3600000' });
  assert.equal(r.code, 0, `clean fixture should exit 0:\n${r.out}`);
  assert.ok(r.wallMs < 20_000, `clean run took ${r.wallMs}ms with a 1h cap — the cap timer is not being cleared`);
});

test('the absolute run cap fires, fails the run, and still prints the verdict', async () => {
  // Reaching cap territory needs a file that never settles AND a child the
  // per-file watchdog will not kill first, so FILE_KILL is pushed above the cap.
  // NOTE ON WHAT THIS DOES *NOT* PIN: the cap timer is deliberately ref'd (an
  // unref'd one cannot fire once the loop has otherwise drained, which would let
  // the runner exit 0 naturally and skip the verdict). Here a child is still
  // alive, so the loop is non-empty and an unref'd timer would fire too — this
  // test does not discriminate ref'd from unref'd. See docs/architecture.md.
  const r = await runGuard('busyloop', {
    ...FAST, CC_TEST_FILE_KILL_MS: '60000', CC_TEST_RUN_CAP_MS: '3000',
  });
  assert.notEqual(r.code, 0, `a capped run must fail:\n${r.out}`);
  assert.match(r.out, /hang-guard: RUN CAP TRIPPED/);
  assert.match(r.out, /hang-guard: \d+\/\d+ files reported.*RUN CAP TRIPPED/,
    'the verdict line must still print on the cap path');
  assert.ok(r.wallMs < 20_000, `capped run took ${r.wallMs}ms — the cap did not bound it`);
});

test('a healthy run whose stdout consumer stalls is NOT reported as a stall', async () => {
  // The stall check's false-positive shape, and the one that matters most because
  // it fires on GREEN runs. The ledger settles from SOURCE-stream events (push
  // time); the wait is on the COMPOSED reporter, which cannot end until the
  // runner's stdout drains. With a paused consumer, every file settles while
  // `end` is still blocked on backpressure and the sampler keeps ticking — so an
  // ungated check declares STREAM STALLED, SIGKILL-sweeps, and fails a run with
  // no defect in it. `node tests/run.mjs | less` is enough to trigger it, and
  // raising ORPHAN_SWEEP_MS cannot help because a pager pause is unbounded.
  //
  // THE FIXTURE'S OUTPUT VOLUME IS LOAD-BEARING — see the do-not-shrink note in
  // chatty.fixture.mjs. ~4MB reproduces (writes block ~4030ms); ~200KB provably
  // does NOT (finishes in ~134ms with 0 bytes read), so a trimmed fixture would
  // make this case pass against the broken code. Do not shrink it to speed this
  // file up; split the file instead (card 2026-0198).
  //
  // The gate is `nodeFinished` (node's single run-level test:summary): emitted at
  // push time on a healthy run, never emitted in a genuine wedge.
  // stdout is DISCARDED here, and the assertions are stderr-only on purpose: the
  // runner's closing process.exit() drops whatever the paused consumer had not
  // taken, so the verdict line is not reliably observable in this shape. Every
  // guard diagnostic goes to stderr, which is drained throughout.
  const r = await runGuard('chatty', FAST, { stdoutPauseMs: 4000, discardStdout: true });
  assert.equal(r.code, 0, `a healthy run must stay green behind a slow consumer:\n${r.out}`);
  assert.doesNotMatch(r.out, /STREAM STALLED/,
    'a slow stdout consumer is not a leaked process');
  assert.doesNotMatch(r.out, /SWEPT/, 'nothing may be SIGKILLed on a healthy run');
});

// --- Layer B: the child-side leak detector ---------------------------------

test('a file that leaks a handle on the PASS path fails the run and is named', async () => {
  const r = await runGuard('leak-on-pass');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /handle-leak-guard: the event loop was STILL OPEN/);
  assert.match(r.out, /handle-leak-guard:\s+Server@/, 'the leaked server must be named');
});

test("Layer B's exit is what bounds a leak's cost — LEAK_GRACE_MS, not FILE_KILL_MS", async () => {
  // The claim in tests/handleLeakGuard.mjs's header and in docs/architecture.md
  // is that a leak costs LEAK_GRACE_MS. If Layer B detected the leak but did not
  // EXIT, Layer A's per-file SIGKILL would still end the file and every
  // assertion in the test above would still hold — the cost would just silently
  // become FILE_KILL_MS, a 6x regression at production defaults on precisely the
  // metric this card exists to make believable. FILE_KILL is 8000 here and
  // LEAK_GRACE 1500, so the two outcomes are far apart and this bound separates
  // them.
  const r = await runGuard('leak-on-pass');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.ok(r.wallMs < LEAK_GRACE + 2500,
    `a leaking file took ${r.wallMs}ms; LEAK_GRACE_MS is ${LEAK_GRACE} and FILE_KILL_MS is ${FILE_KILL}. ` +
    'Layer B is no longer exiting the child, so the cost has fallen through to Layer A.');
});

test('a file that leaks on the FAIL path reports BOTH the assertion and the leak', async () => {
  // The exact 2026-0183 ws-deferred-steer shape: cleanup after the assertions,
  // so it runs on the success path only. Pre-fix the run hangs, which means the
  // assertion failure itself is never reported either — the worst outcome.
  const r = await runGuard('leak-on-fail');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /deliberate failure before cleanup/, 'the real assertion failure must still be reported');
  assert.match(r.out, /handle-leak-guard: the event loop was STILL OPEN/);
});

// --- Layer A: the parent-side process guarantee ----------------------------

test('a wedged file is SIGKILLed and reported failed', async () => {
  // A CPU busy-loop never turns the event loop, so the per-test timeout timer
  // cannot fire and no in-child mechanism (including --test-force-exit) can
  // reach it. Only Layer A's SIGKILL from the parent ends this.
  const r = await runGuard('busyloop');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: KILLED .*busyloop\.fixture\.mjs after \d+ms/);
  assert.ok(r.wallMs < FILE_KILL + 7000,
    `busyloop run took ${r.wallMs}ms — the per-file kill watchdog did not bound it`);
});

test('an orphan grandchild holding stdio cannot wedge the run', async () => {
  const r = await runGuard('orphan-grandchild');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: SWEPT \d+ leaked process\(es\)/);
  assert.ok(r.wallMs < 20_000, `orphan run took ${r.wallMs}ms — it fell through to the absolute run cap`);
});

test('a leak from a file too fast to be sampled is still found and killed', async () => {
  // ~30ms file: under one 100ms sampler tick, so the orphan is never recorded by
  // parentage, and its parent exits at once so it is reparented to init and no
  // descendants() walk can reach it. Only the same-process-group check finds it.
  const r = await runGuard('fast-orphan');
  assert.notEqual(r.code, 0, `a leaked live process must fail the run:\n${r.out}`);
  assert.match(r.out, /hang-guard: SWEPT \d+ leaked process\(es\)/,
    'a sub-tick orphan must still be identified and SIGKILLed');
  assert.ok(r.wallMs < 20_000, `run took ${r.wallMs}ms — it fell through to the absolute run cap`);
});

test('a file that REPORTS CLEANLY but leaves an orphan still terminates and fails', async () => {
  // The shape a `reported`-gated sweep switches itself off for: the child exits
  // cleanly, every test passes, the summary ARRIVES — and a detached orphan
  // holding our inherited stdio keeps the stream from ever ending. Pre-fix this
  // ran to the absolute cap, which is the 2026-0183 outcome all over again.
  // (Not reproducible from THIS fixture at production defaults, because the
  // holder self-terminates at 60s and the shape then self-heals; the unbounded
  // version was measured before the holder was given a lifetime.)
  //
  // VALIDITY PRECONDITION, asserted rather than assumed: the holder must outlive
  // the stall grace by a wide margin. If grace ever exceeded the holder's life
  // the holder would die first, the stream would end on its own, and this fixture
  // would pass while proving nothing (demonstrated: it passes at 60.2s that way).
  assert.ok(SWEEP * 4 < HOLDER_LIFETIME,
    `stall grace ${SWEEP}ms must stay far below the holder's ${HOLDER_LIFETIME}ms life, ` +
    'or this fixture self-heals and stops testing anything');
  const r = await runGuard('detached-orphan');
  assert.notEqual(r.code, 0, `a leaked live process must fail the run, not read as a pass:\n${r.out}`);
  assert.match(r.out, /hang-guard: STREAM STALLED/);
  assert.match(r.out, /hang-guard: 1\/1 files reported.*STREAM STALLED/,
    'the verdict line must record the stall even though the file itself reported');
  assert.ok(r.wallMs < 20_000,
    `run took ${r.wallMs}ms — the stall check did not abandon the wait, so it fell to the cap`);
});

test('the stall grace is actually applied, not just present', async () => {
  // `> ORPHAN_SWEEP_MS` -> `> -1` leaves every other case green, yet removing the
  // grace would make the whole suite flaky: a 100ms sampler tick landing in the
  // measured ~4ms window between the last file's summary and the run-level one
  // would declare a stall on a healthy run. This pins the grace by TIMING —
  // with it raised to 5s the stall may not be declared before then, whereas a
  // graceless check declares it on the first tick after settling.
  // 2500ms, not 5000: a graceless check declares the stall on the first tick
  // after settling (~100ms), so this still discriminates by ~6x while recovering
  // ~2.5s from the suite's slowest file. Do not shrink much further — below ~1s
  // the margin over a starved sampler tick stops being comfortable.
  const grace = 2500;
  const r = await runGuard('detached-orphan', { ...FAST, CC_TEST_ORPHAN_SWEEP_MS: String(grace) });
  assert.notEqual(r.code, 0, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: STREAM STALLED/);
  assert.ok(r.wallMs > grace * 0.8,
    `the stall was declared after only ${r.wallMs}ms with a ${grace}ms grace — the grace is not being applied`);
});

test('a file that never reports is never silently absent', async () => {
  // The truncation class: a --test-force-exit scan silently lost a 38-test file
  // while still printing `fail 0` and exiting 0. The ledger must name the file
  // whatever the cause.
  const r = await runGuard('exit-before-report');
  assert.equal(r.code, 1, `a file that produced no report must fail the run:\n${r.out}`);
  assert.match(r.out, /hang-guard: NO REPORT from .*exit-before-report\.fixture\.mjs/);
  assert.match(r.out, /hang-guard: 0\/1 files reported/);
});
