// CHAIN TAIL — waits for `medium`'s PROCESS TO EXIT, spends 900ms, publishes
// nothing.
//
// The culprit: the file that actually spends the wall time. Listed FIRST in the
// runner's argv by tests/summary-attribution.test.mjs, which is what makes the
// later-listed files' summaries wait on it under the pre-fix reporter.
//
// Its increment is the lower bound of assertion (2) `slow - medium >= 900`, and its
// cumulative position (0 + 550 + 650 + 900) is what assertion (4) `slow >= 2100`
// controls against — an absolute floor that load can only inflate.
//
// `*.fixture.mjs`, not `*.test.mjs`, so run.mjs's discover() glob never picks it
// up during a normal suite run — same reason tests/fixtures/hang/ uses the suffix.
import test from 'node:test';
import { link } from './chain.mjs';

test('slow fixture: adds 900ms to the chain', async () => {
  await link({ after: 'medium', sleepMs: 900 });
});
