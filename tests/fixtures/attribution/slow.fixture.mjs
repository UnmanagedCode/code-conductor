// The culprit: the file that actually spends the wall time. Listed FIRST in the
// runner's argv by tests/summary-attribution.test.mjs, which is what makes the
// later-listed files' summaries wait on it.
//
// `*.fixture.mjs`, not `*.test.mjs`, so run.mjs's discover() glob never picks it
// up during a normal suite run — same reason tests/fixtures/hang/ uses the suffix.
import test from 'node:test';

// ~1200ms: long enough that a held summary charges the other two fixtures an
// unmistakable ~1.2s, short enough to keep the whole regression file at ~1.3s.
test('slow fixture: occupies ~1200ms of wall', async () => {
  await new Promise(r => setTimeout(r, 1200));
});
