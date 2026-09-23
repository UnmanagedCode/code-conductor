// lineageSteps (src/lineagePager.ts): which older segments a lineage
// scroll-back walks, oldest last, and which markers sit below each — a pure
// function over a lineage row's FULL chain, tombstones included.
//
// Chain notation in the subtest titles: `r` renew, `p` prune, `†` tombstoned,
// `✗` file missing (which the chain cannot see). The current segment is last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newExport } from './segmentChain.mjs';

// `spec` like 'A B·r C†·p' → chain entries; `A` is always `initial` unless a
// reason is given.
function chain(spec) {
  return spec.split(/\s+/).map((tok) => {
    const m = /^([A-Z])(†)?(✗)?(?:·([rp]))?$/.exec(tok);
    assert.ok(m, `bad token ${tok}`);
    const reason = m[4] === 'r' ? 'renew' : m[4] === 'p' ? 'prune' : 'initial';
    return { id: m[1], reason, at: '', ...(m[2] ? { dropped: true } : {}) };
  });
}
const step = (id, markersBelow, dropped = false) => ({ id, dropped, markersBelow });
const SEAM = ['seam'];
const SEAM_GAP = ['seam', 'gap'];

// [title, chain spec, fromId (default: the last entry), expected]
const ROWS = [
  ['#1 A', 'A', null, { steps: [], top: [] }],
  ['#2 A B·r C·r', 'A B·r C·r', null, { steps: [step('B', SEAM), step('A', SEAM)], top: [] }],
  ['#3 A B·p', 'A B·p', null, { steps: [], top: [] }],
  ['#4 A B·r C·p', 'A B·r C·p', null, { steps: [step('A', SEAM)], top: [] }],
  ['#5 A B·r C·p D·p', 'A B·r C·p D·p', null, { steps: [step('A', SEAM)], top: [] }],
  ['#6 A B·r C·p D·r', 'A B·r C·p D·r', null, { steps: [step('C', SEAM), step('A', SEAM)], top: [] }],
  ['#7 A B·p C·r', 'A B·p C·r', null, { steps: [step('B', SEAM)], top: [] }],
  ['#8 A✗ B·r', 'A✗ B·r', null, { steps: [step('A', SEAM)], top: [] }],
  ['#9 A B✗·r C·r', 'A B✗·r C·r', null, { steps: [step('B', SEAM), step('A', SEAM)], top: [] }],
  ['#10 A✗ B·p', 'A✗ B·p', null, { steps: [], top: [] }],
  ['#11 A B✗·r (current file missing)', 'A B✗·r', null, { steps: [step('A', SEAM)], top: [] }],
  ['#12 A† B·r', 'A† B·r', null, { steps: [step('A', SEAM, true)], top: [] }],
  ['#13 A B†·r C·r', 'A B†·r C·r', null, { steps: [step('B', SEAM, true), step('A', SEAM)], top: [] }],
  ['#14 A B†·r C·p', 'A B†·r C·p', null, { steps: [step('A', SEAM_GAP)], top: [] }],
  ['#15 A B·r C†·p D·p', 'A B·r C†·p D·p', null, { steps: [step('A', SEAM_GAP)], top: [] }],
  ['#16 A† B·p', 'A† B·p', null, { steps: [], top: ['gap'] }],
  ['#17 A B·r C†·p D·r', 'A B·r C†·p D·r', null, { steps: [step('C', SEAM, true), step('A', SEAM)], top: [] }],
  ['#18 L1 B·r C·r', 'B·r C·r', null, { steps: [step('B', SEAM)], top: ['gap'] }],
  ['#19 L3 A C·p', 'A C·p', null, { steps: [], top: [] }],
  ['#20 L2 A C·r', 'A C·r', null, { steps: [step('A', SEAM)], top: [] }],
  ["#29′ B·r C·r from B", 'B·r C·r', 'B', { steps: [], top: ['gap'] }],
  ['#30 A B·p C·p', 'A B·p C·p', null, { steps: [], top: [] }],
  ['#31 L1 B·r alone', 'B·r', null, { steps: [], top: ['gap'] }],
];

test('LW1 lineageSteps over every lineage shape', async (t) => {
  const lineageSteps = await newExport('src/lineagePager.ts', 'lineageSteps');
  for (const [title, spec, from, expected] of ROWS) {
    await t.test(title, () => {
      const c = chain(spec);
      assert.deepEqual(lineageSteps(c, from ?? c[c.length - 1].id), expected);
    });
  }
});

test('LW2 (#29) a fromId absent from the chain walks nothing and marks nothing', async () => {
  const lineageSteps = await newExport('src/lineagePager.ts', 'lineageSteps');
  assert.deepEqual(lineageSteps(chain('A B·r C·r'), 'Z'), { steps: [], top: [] });
  assert.deepEqual(lineageSteps([], 'Z'), { steps: [], top: [] });
});
