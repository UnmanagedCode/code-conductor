// The victim: trivial work, listed AFTER slow.fixture.mjs, so it finishes while
// slow is still running and its summary is held behind slow's. Real dispatch→done
// is ~35ms; the unfixed reporter charged it ~1240ms.
import test from 'node:test';
import assert from 'node:assert';

test('fast fixture: returns immediately', () => {
  assert.ok(true);
});
