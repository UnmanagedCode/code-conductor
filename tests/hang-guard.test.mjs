// Regression suite for the suite hang guard (card 2026-0190).
//
// Each case runs the REAL tests/run.mjs as a subprocess against a fixture under
// tests/fixtures/hang/, with the deadlines squeezed to ~1.5-4s via the
// CC_TEST_* overrides that tests/hangGuardConfig.mjs already exposes. Nothing
// here re-implements the guard's rules: the leaked-handle predicate lives only
// in tests/handleLeakGuard.mjs and every deadline only in hangGuardConfig.mjs,
// so this file sets env and reads output. A copy of the rule here could agree
// with itself while the shipped guard was broken.
//
// Fixtures are `*.fixture.mjs`, so run.mjs's discover() (which globs
// `*.test.mjs`) never picks them up during a normal suite run — several of them
// hang or wedge by design — while an explicit argv path still runs them.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run.mjs');
const fixture = name => path.join(__dirname, 'fixtures', 'hang', `${name}.fixture.mjs`);

// Squeezed deadlines shared by every case except the run-cap trap below.
const FAST = {
  CC_TEST_LEAK_GRACE_MS: '1500',
  CC_TEST_FILE_KILL_MS: '4000',
  CC_TEST_ORPHAN_SWEEP_MS: '1500',
  CC_TEST_RUN_CAP_MS: '30000',
};

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
    // Backstop so a guard regression surfaces as a failed assertion in THIS
    // file rather than as a stalled test: if the guard under test stops
    // working, the child would otherwise hang exactly the way the card is about.
    const bail = setTimeout(() => { child.kill('SIGKILL'); }, hardTimeoutMs);
    child.on('error', err => { clearTimeout(bail); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(bail);
      resolve({ code, signal, out, wallMs: Date.now() - startedAt });
    });
  });
}

// --- the control -----------------------------------------------------------

test('a clean file passes, reports, and the guard adds no delay', async () => {
  const r = await runGuard('clean');
  assert.equal(r.code, 0, `clean fixture should exit 0:\n${r.out}`);
  assert.match(r.out, /hang-guard: 1\/1 files reported, 0 killed/);
  assert.doesNotMatch(r.out, /handle-leak-guard:/);
  assert.doesNotMatch(r.out, /NO REPORT/);
});

test("the guard's own timers cannot outlive the run", async () => {
  // The trap this pins: the absolute run cap is a REF'D timer (deliberately —
  // an unref'd one cannot fire when the loop has otherwise drained, which is
  // the silent-green case). A ref'd timer that the teardown fails to clear
  // would hang EVERY clean run for the full cap. With the cap set to an hour,
  // a clean run must still finish in seconds.
  const r = await runGuard('clean', { ...FAST, CC_TEST_RUN_CAP_MS: '3600000' });
  assert.equal(r.code, 0, `clean fixture should exit 0:\n${r.out}`);
  assert.ok(r.wallMs < 20_000, `clean run took ${r.wallMs}ms with a 1h cap — the cap timer is not being cleared`);
});

// --- Layer B: the child-side leak detector ---------------------------------

test('a file that leaks a handle on the PASS path fails the run and is named', async () => {
  // The shape the 60s per-test timeout is structurally blind to: the test body
  // settles, so nothing is ever cancelled — yet the child never exits, and node
  // emits a file's terminal summary only at child exit. Pre-fix: hangs forever.
  const r = await runGuard('leak-on-pass');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /handle-leak-guard: the event loop was STILL OPEN/);
  assert.match(r.out, /handle-leak-guard:\s+Server@/, 'the leaked server must be named');
  assert.match(r.out, /leak-on-pass\.fixture\.mjs/);
});

test('a file that leaks on the FAIL path reports BOTH the assertion and the leak', async () => {
  // The exact 2026-0183 ws-deferred-steer shape: cleanup after the assertions,
  // so it runs on the success path only. Pre-fix the run hangs, which means the
  // assertion failure itself is never reported either — the worst outcome.
  const r = await runGuard('leak-on-fail');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /deliberate failure before cleanup/, 'the real assertion failure must still be reported');
  assert.match(r.out, /handle-leak-guard: the event loop was STILL OPEN/);
  assert.match(r.out, /handle-leak-guard:\s+Server@/);
});

// --- Layer A: the parent-side process guarantee ----------------------------

test('a wedged file is SIGKILLed and reported failed', async () => {
  // A CPU busy-loop never turns the event loop, so the per-test timeout timer
  // cannot fire and no in-child mechanism (including --test-force-exit) can
  // reach it. Only Layer A's SIGKILL from the parent ends this.
  const r = await runGuard('busyloop');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: KILLED .*busyloop\.fixture\.mjs after \d+ms/);
  // Bounded by FILE_KILL_MS (4s here), not by the 30s run cap and not by
  // node's own 60s per-test timeout.
  assert.ok(r.wallMs < 15_000, `busyloop run took ${r.wallMs}ms — the per-file kill watchdog did not bound it`);
});

test('an orphan grandchild holding stdio cannot wedge the run', async () => {
  // The child exits cleanly and its test passes, but a grandchild inherited its
  // stdio and keeps the REPORT PIPE open, so the stream never ends. The orphan
  // is reparented to init the instant its parent dies, so it is only reachable
  // because the sampler recorded it while the parent was alive.
  const r = await runGuard('orphan-grandchild');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: SWEPT \d+ orphan process\(es\)/);
  assert.ok(r.wallMs < 20_000, `orphan run took ${r.wallMs}ms — it fell through to the absolute run cap instead of being swept`);
});

test('a file that never reports is never silently absent', async () => {
  // The truncation class: a --test-force-exit scan silently lost
  // tests/mcp-conductor-view.test.mjs (38 tests) while still printing `fail 0`
  // and exiting 0. The completeness ledger must name the file whatever the cause.
  const r = await runGuard('exit-before-report');
  assert.equal(r.code, 1, `a file that produced no report must fail the run:\n${r.out}`);
  assert.match(r.out, /hang-guard: NO REPORT from .*exit-before-report\.fixture\.mjs/);
  assert.match(r.out, /hang-guard: 0\/1 files reported/);
});
