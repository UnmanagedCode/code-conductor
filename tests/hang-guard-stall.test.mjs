// Regression suite for the suite hang guard (card 2026-0190), part 5 of 5:
// the STREAM-STALL check — the termination guarantee for a file that reports
// cleanly and still leaves a live process holding our stdio.
//
// Split out of the former tests/hang-guard.test.mjs by card 2026-0198. The
// harness (RUNNER, fixture(), the deadlines, FAST, redactTotals, runGuard) lives
// once in tests/hangGuardCase.mjs — read its header before changing anything
// here.

import test from 'node:test';
import assert from 'node:assert';
import { FAST, HOLDER_LIFETIME, SWEEP, runGuard } from './hangGuardCase.mjs';

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
