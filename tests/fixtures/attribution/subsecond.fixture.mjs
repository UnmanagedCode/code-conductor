// CHAIN LINK 2 — waits for `fast`'s PROCESS TO EXIT, spends 550ms, publishes
// `subsecond`.
//
// Its increment is the SMALLEST in the chain and is therefore the resolution floor
// the suite pins: assertion (2b) `sub - fast >= 550` in
// tests/summary-attribution.test.mjs. A reporter that rounded away separations
// below ~1s while preserving the larger ones dies on this one and no other.
//
// 550ms is no longer solved against medium's sleep — the old (0, 1000) band and its
// round-to-nearest-second tie argument are gone, replaced by an explicit
// millisecond-lattice residue check. It is simply the smallest increment still far
// above the chain's 10ms poll granularity.
import test from 'node:test';
import { link } from './chain.mjs';

test('subsecond fixture: adds 550ms to the chain', async () => {
  await link({ after: 'fast', sleepMs: 550, signal: 'subsecond' });
});
