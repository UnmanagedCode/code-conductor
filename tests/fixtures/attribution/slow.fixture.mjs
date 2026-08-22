// The culprit: the file that actually spends the wall time. Listed FIRST in the
// runner's argv by tests/summary-attribution.test.mjs, which is what makes the
// later-listed files' summaries wait on it.
//
// `*.fixture.mjs`, not `*.test.mjs`, so run.mjs's discover() glob never picks it
// up during a normal suite run — same reason tests/fixtures/hang/ uses the suffix.
import test from 'node:test';

// 1700ms, and PAIRED WITH medium.fixture.mjs's 1200ms — the two sleeps are chosen
// together, so changing one alone weakens an assertion. See the threshold algebra
// at the top of tests/summary-attribution.test.mjs before touching either.
test('slow fixture: occupies ~1700ms of wall', async () => {
  await new Promise(r => setTimeout(r, 1700));
});
