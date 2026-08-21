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
import { killDescendants } from './procTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run.mjs');
const fixture = name => path.join(__dirname, 'fixtures', 'hang', `${name}.fixture.mjs`);

// Squeezed deadlines shared by every case except where a test overrides one.
const LEAK_GRACE = 1500;
const FILE_KILL = 8000;   // deliberately >> LEAK_GRACE, so the two are separable
const SWEEP = 1500;
const FAST = {
  CC_TEST_LEAK_GRACE_MS: String(LEAK_GRACE),
  CC_TEST_FILE_KILL_MS: String(FILE_KILL),
  CC_TEST_ORPHAN_SWEEP_MS: String(SWEEP),
  CC_TEST_RUN_CAP_MS: '30000',
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
function runGuard(name, env = FAST, { hardTimeoutMs = 45_000 } = {}) {
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
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
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
  // ran to the absolute cap (600s at production defaults, above code-mutant's
  // 300s ceiling), which is the 2026-0183 outcome all over again.
  //
  // The orphan here is `detached`, so it escapes our process group and is NOT
  // identifiable (see the sweep note in tests/run.mjs for why). Termination and
  // the non-zero exit therefore come from abandoning the stalled stream, not
  // from killing anything — which is exactly the guarantee being pinned.
  const r = await runGuard('detached-orphan');
  assert.notEqual(r.code, 0, `a leaked live process must fail the run, not read as a pass:\n${r.out}`);
  assert.match(r.out, /hang-guard: STREAM STALLED/);
  assert.match(r.out, /hang-guard: 1\/1 files reported.*STREAM STALLED/,
    'the verdict line must record the stall even though the file itself reported');
  assert.ok(r.wallMs < 20_000,
    `run took ${r.wallMs}ms — the stall check did not abandon the wait, so it fell to the cap`);
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
