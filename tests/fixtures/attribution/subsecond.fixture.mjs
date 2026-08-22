// Pairs with medium.fixture.mjs to pin SUB-SECOND RESOLUTION: two files whose true
// walls differ by ~650ms must stay strictly ordered and stay less than a second
// apart in the reported figures.
//
// 550ms is chosen against medium's 1200ms, not freely:
//   * the true gap is ~650ms, so it sits well inside the (0, 1000) band assertion
//     (5) requires, with ~350ms of headroom above and ~650ms below;
//   * both figures land in the SAME round-to-nearest-second bucket ([500, 1500) →
//     1000), so a reporter that quantized to seconds would TIE them;
//   * 550 + spawn cost stays clear of the 500ms bucket floor, so the tie does not
//     accidentally break and let a quantizing reporter pass.
// Do not shrink it toward 460ms: the figure would flirt with rounding to 0 instead
// of 1000, which breaks the tie and turns assertion (5) into a false negative.
//
// It costs almost nothing in wall: at TEST_CONCURRENCY=2 it is dispatched into the
// slot medium vacates and finishes while slow.fixture.mjs is still running.
import test from 'node:test';

test('subsecond fixture: occupies ~550ms of wall', async () => {
  await new Promise(r => setTimeout(r, 550));
});
