// CHAIN HEAD — increment 0. Does no work at all: it writes the `fast` marker and
// exits, which is what releases subsecond.fixture.mjs.
//
// The victim of the original bug: trivial work, listed AFTER the files that do the
// real sleeping, so it finishes while they are still running and the pre-fix
// reporter held its summary and charged it slow's wall. Real dispatch→done is
// ~35ms quiet; the unfixed reporter charged it ~1240ms.
//
// It is the SUBTRAHEND of two bounds in tests/summary-attribution.test.mjs's test 1:
//   (1) medium - fast >= 1200   (its successors' increments 550 + 650)
//   (2b) sub - fast >= 550      (subsecond's increment alone)
// Its own increment is 0, so it contributes no lower bound of its own — it is the
// zero of the chain.
import test from 'node:test';
import assert from 'node:assert';
import { link } from './chain.mjs';

test('fast fixture: returns immediately', async () => {
  assert.ok(true);
  await link({ signal: 'fast' });
});
