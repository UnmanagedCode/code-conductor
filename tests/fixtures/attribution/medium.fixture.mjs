// CHAIN LINK 3 — waits for `subsecond`'s PROCESS TO EXIT, spends 650ms, publishes
// `medium`.
//
// The middle of the ranking: a file whose real wall is neither extreme, so neither
// direction of error can fake it. Listed second in test 1's argv, so its summary is
// held behind slow's under the pre-fix reporter.
//
// Its completion sits 550 + 650 = 1200ms after fast's, which is the lower bound
// assertion (1) `medium - fast >= 1200` states, and it is the FLOOR of assertion
// (2) `slow - medium >= 900`.
//
// The increment is 650, not 1200: the chain is cumulative, so medium's TOTAL
// separation from the chain head is the sum of its own link and subsecond's. The
// old "sleeps are solved together against a shared spawn-cost budget" algebra no
// longer exists — there is no spawn-cost term in any bound now, so this number can
// be changed on its own as long as tests/summary-attribution.test.mjs's (1) and (2)
// move with it.
import test from 'node:test';
import { link } from './chain.mjs';

test('medium fixture: adds 650ms to the chain', async () => {
  await link({ after: 'subsecond', sleepMs: 650, signal: 'medium' });
});
