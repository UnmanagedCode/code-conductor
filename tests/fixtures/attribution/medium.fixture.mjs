// The middle of the ranking: a file whose real wall is neither extreme, so neither
// direction of error can fake it.
//
// Listed third, at concurrency 2, so it is dispatched into the slot
// fast.fixture.mjs vacates and finishes while slow.fixture.mjs is still running —
// which means its summary is held too, and the pre-fix reporter charged it slow's
// wall rather than its own. It carries three of test 1's assertions: the upper half
// of (1), the lower half of (2), and the larger side of (5)'s pair.
//
// 1200ms, PAIRED WITH slow.fixture.mjs's 2100ms and subsecond.fixture.mjs's 550ms —
// see the threshold algebra at the top of tests/summary-attribution.test.mjs before
// changing it. Raising this sleep alone widens assertion (1)'s tolerance but NARROWS
// assertion (2)'s; the sleeps move in opposite directions and were solved together.
//
// It costs no wall time: it runs inside the window slow.fixture.mjs is already
// holding open.
import test from 'node:test';

test('medium fixture: occupies ~1200ms of wall', async () => {
  await new Promise(r => setTimeout(r, 1200));
});
