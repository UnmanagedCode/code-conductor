// Regression suite for the suite hang guard (card 2026-0190), part 2 of 5:
// the absolute run cap (A3), the guard's own timer teardown, and the stall
// check's false-positive shape.
//
// Split out of the former tests/hang-guard.test.mjs by card 2026-0198. The
// harness (RUNNER, fixture(), the deadlines, FAST, redactTotals, runGuard) lives
// once in tests/hangGuardCase.mjs — read its header before changing anything
// here.

import test from 'node:test';
import assert from 'node:assert';
import { FAST, SWEEP, runGuard } from './hangGuardCase.mjs';

// The diagnostics the slow-consumer case below asserts the ABSENCE of,
// shared with the pin that proves they REACH that case's accumulator — so the
// pattern proved observable is the same object the absence is asserted against
// (the `HOLDER_LINE` idiom, card 2026-0228).
const STALL = /STREAM STALLED/;
const SWEPT = /SWEPT/;
// The slow-consumer case's forcing delay, named so the case can assert on it.
const PAUSE = 4000;

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

test('the discarded-stdout shape carries stderr diagnostics and drops stdout ones', async () => {
  // NON-VACUITY PIN for the slow-consumer case below, which asserts the ABSENCE
  // of STALL and SWEPT against an accumulator that — stdout being discarded —
  // receives stderr only. Absence proves nothing unless presence is reachable,
  // so this runs the SAME discarding shape against a fixture that genuinely
  // trips both and asserts they ARRIVE. detached-orphan is what lets one run
  // cover both: it stalls the stream and is swept for it (~1.7s).
  //
  // WHAT THIS DOES *NOT* BUY: it does not rescue detection. Moving either
  // writer to console.log still reddens the case below via its `code === 0`
  // assertion, because run.mjs does `failed++` on both `streamStalled` and
  // `sweptOrphans > 0`. What the pin protects is (a) diagnostic honesty — that
  // case would otherwise fail with a bare "expected 0, got 1" while its two
  // named assertions silently degraded to decoration — and (b) the one narrow
  // regression the pair alone discriminates: a guard that PRINTS a stall or
  // sweep without punishing it.
  const r = await runGuard('detached-orphan', FAST, { discardStdout: true });
  assert.match(r.out, STALL, 'STREAM STALLED must reach a discarded-stdout accumulator');
  assert.match(r.out, SWEPT, 'SWEPT must reach a discarded-stdout accumulator');
  assert.doesNotMatch(r.out, /files reported/,
    'the verdict line is console.log, so this shape must NOT see it');
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
  // file up; the file was split instead (card 2026-0198).
  //
  // The gate is `nodeFinished` (node's single run-level test:summary): emitted at
  // push time on a healthy run, never emitted in a genuine wedge.
  //
  // stdout is DISCARDED here, so every assertion below that reads `r.out` is
  // consequently STDERR-ONLY. That routing is a PRECONDITION of this shape, not
  // an incidental choice, and it is pinned by the case above rather than
  // asserted here: both patterns are console.error diagnostics of run.mjs, and a
  // console.log one would never arrive at all — see the routing rule at
  // runGuard's stderr handler for which writer sends what where.
  // Capturing stdout instead does not remove the dependency — measured, with the
  // pause in place and no discard, this accumulator is STILL empty, because a
  // failing run's `close` fires at ~1.8s while the consumer stays paused to
  // PAUSE ms, so the parent never resumes and reads nothing.
  assert.ok(PAUSE > SWEEP * 2,
    `the ${PAUSE}ms pause must outlast the ${SWEEP}ms stall grace, or the stream ends before an ` +
    'ungated check could ever declare a stall and this case cannot fail');
  const r = await runGuard('chatty', FAST, { stdoutPauseMs: PAUSE, discardStdout: true });
  assert.equal(r.code, 0, `a healthy run must stay green behind a slow consumer:\n${r.out}`);
  assert.ok(r.wallMs > PAUSE * 0.9,
    `the run finished in ${r.wallMs}ms behind a ${PAUSE}ms pause — backpressure did not defer ` +
    "`end`, so the fixture no longer forces the shape (it was shrunk?)");
  assert.doesNotMatch(r.out, STALL,
    'a slow stdout consumer is not a leaked process');
  assert.doesNotMatch(r.out, SWEPT, 'nothing may be SIGKILLed on a healthy run');
});
