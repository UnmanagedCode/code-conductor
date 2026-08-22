// The middle of the ranking, and the reason a two-fixture version of this test was
// not enough.
//
// Listed LAST, at concurrency 2, so it is dispatched into the slot fast.fixture.mjs
// vacates (~35ms in) and finishes ~640ms in, while slow is still running — so its
// summary is held too. Real dispatch→done ~635ms; the unfixed reporter charged it
// ~1200ms.
//
// It is what gives the middle assertion a TWO-SIDED bound. With only a slow and a
// fast fixture every pre-fix figure collapses to ~1240ms, and the only surviving
// signal is "small vs large" — which a mutant that hard-codes a small duration
// would satisfy. A file whose real wall is neither extreme cannot be faked by
// either direction of error. It also costs no wall time: it runs inside the window
// slow.fixture.mjs is already holding open.
// 1200ms, PAIRED WITH slow.fixture.mjs's 1700ms — see the threshold algebra at the
// top of tests/summary-attribution.test.mjs. Raising this sleep alone widens
// assertion (1)'s tolerance but NARROWS assertion (2)'s; the two move in opposite
// directions and were solved together.
import test from 'node:test';

test('medium fixture: occupies ~1200ms of wall', async () => {
  await new Promise(r => setTimeout(r, 1200));
});
