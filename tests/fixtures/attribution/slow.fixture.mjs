// The culprit: the file that actually spends the wall time. Listed FIRST in the
// runner's argv by tests/summary-attribution.test.mjs, which is what makes the
// later-listed files' summaries wait on it.
//
// `*.fixture.mjs`, not `*.test.mjs`, so run.mjs's discover() glob never picks it
// up during a normal suite run — same reason tests/fixtures/hang/ uses the suffix.
import test from 'node:test';

// 2100ms, and PAIRED WITH medium.fixture.mjs's 1200ms — the two sleeps are chosen
// together, so changing one alone weakens an assertion. See the threshold algebra
// at the top of tests/summary-attribution.test.mjs before touching either.
//
// It was 1700ms, which left assertion (2) only 200ms of tolerance and was MEASURED
// FAILING 1 run in 20 under 16-spinner starvation (slow 1788 / medium 1431, margin
// -1ms). The binding quantity is 1.25*C_medium - C_slow, and those two spawn costs
// are NOT interchangeable: this file is dispatched at t=0 into a free slot while
// medium waits for fast's slot, so medium's is systematically the larger.
test('slow fixture: occupies ~2100ms of wall', async () => {
  await new Promise(r => setTimeout(r, 2100));
});
