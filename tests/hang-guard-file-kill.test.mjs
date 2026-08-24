// Regression suite for the suite hang guard (card 2026-0190), part 1 of 5:
// Layer A's per-file SIGKILL, the completeness ledger, and the green control.
//
// Split out of the former tests/hang-guard.test.mjs by card 2026-0198. Each
// case's cost is its squeezed DEADLINE, not work, so one file charged the sum of
// every case's deadline; five files are charged the max instead. The harness
// (RUNNER, fixture(), the deadlines, FAST, redactTotals, runGuard) lives once in
// tests/hangGuardCase.mjs — read its header before changing anything here.

import test from 'node:test';
import assert from 'node:assert';
import { FILE_KILL, runGuard } from './hangGuardCase.mjs';

// --- the control -----------------------------------------------------------

test('a clean file passes, reports, and the guard adds no delay', async () => {
  const r = await runGuard('clean');
  assert.equal(r.code, 0, `clean fixture should exit 0:\n${r.out}`);
  assert.match(r.out, /hang-guard: 1\/1 files reported, 0 killed, 0 leaked process\(es\) swept, stream ended cleanly/);
  assert.doesNotMatch(r.out, /handle-leak-guard:/);
  assert.doesNotMatch(r.out, /NO REPORT/);
  assert.doesNotMatch(r.out, /STREAM STALLED/);
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

test('a file that never reports is never silently absent', async () => {
  // The truncation class: a --test-force-exit scan silently lost a 38-test file
  // while still printing `fail 0` and exiting 0. The ledger must name the file
  // whatever the cause.
  const r = await runGuard('exit-before-report');
  assert.equal(r.code, 1, `a file that produced no report must fail the run:\n${r.out}`);
  assert.match(r.out, /hang-guard: NO REPORT from .*exit-before-report\.fixture\.mjs/);
  assert.match(r.out, /hang-guard: 0\/1 files reported/);
});
