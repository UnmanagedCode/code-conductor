// Regression suite for the suite hang guard (card 2026-0190), part 3 of 5:
// Layer B, the child-side leak detector (tests/handleLeakGuard.mjs).
//
// Split out of the former tests/hang-guard.test.mjs by card 2026-0198. The
// harness (RUNNER, fixture(), the deadlines, FAST, redactTotals, runGuard) lives
// once in tests/hangGuardCase.mjs — read its header before changing anything
// here.

import test from 'node:test';
import assert from 'node:assert';
import { FILE_KILL, LEAK_GRACE, runGuard } from './hangGuardCase.mjs';

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
