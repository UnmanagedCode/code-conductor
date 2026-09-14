import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraph, laneEmanates } from '../public/commits.js';

// 1. Regression: merge dot at col=0, second-parent lane at k=1 where
//    lanesBefore[1] === sha (lane converged into dot, slot freed and reused).
test('converged-then-reused lane emanates from dot', () => {
  const sha = 'abc123';
  const lanesBefore = [sha, sha]; // both lanes were targeting this commit
  assert.equal(laneEmanates(1, 0, lanesBefore, sha), true);
});

// 2. Genuine pass-through: lanesBefore[k] is non-null and !== sha.
test('unrelated pass-through lane does not emanate', () => {
  const sha = 'abc123';
  const lanesBefore = [sha, 'other_sha'];
  assert.equal(laneEmanates(1, 0, lanesBefore, sha), false);
});

// 3a. First-parent continuation (k === col) always emanates.
test('first-parent continuation (k === col) emanates', () => {
  const sha = 'abc123';
  const lanesBefore = [sha, null];
  assert.equal(laneEmanates(0, 0, lanesBefore, sha), true);
});

// 3b. Brand-new fork into a free column (lanesBefore[k] == null) emanates.
test('new fork into free column emanates', () => {
  const sha = 'abc123';
  const lanesBefore = [sha, null];
  assert.equal(laneEmanates(1, 0, lanesBefore, sha), true);
});

// ── computeGraph ────────────────────────────────────────────────────────────
// Topology shared by 3a/3b: M is a merge of B and S2; both lines descend from
// the root A. Readable shas stand in for real ones.
//   M(B,S2)  B(A)  S2(S1)  S1(A)  A()

// 4. Topo-ordered input: the fork opens at the merge row and both lanes bend
//    into a single dot at the commit both branches descend from.
test('topo-ordered merge: both lanes converge at the branch point', () => {
  const input = [
    { sha: 'M', parents: ['B', 'S2'] },
    { sha: 'B', parents: ['A'] },
    { sha: 'S2', parents: ['S1'] },
    { sha: 'S1', parents: ['A'] },
    { sha: 'A', parents: [] },
  ];
  const { rows, maxCols } = computeGraph(input);

  assert.equal(maxCols, 2);
  assert.deepEqual(rows[0].lanesAfter, ['B', 'S2'], 'merge row forks two lanes');
  // rows[4] IS the branch point: both lanes target A and bend into one dot.
  assert.deepEqual(rows[4].lanesBefore, ['A', 'A']);
  assert.equal(rows[4].col, 0);
  assert.deepEqual(rows[4].lanesAfter, [null, null], 'root terminates both lanes');
  for (let i = 0; i < rows.length; i++) {
    assert.ok(rows[i].col < 2, `row ${i} col ${rows[i].col} exceeds the two lanes`);
  }
});

// 5. The `seen` guard: fed the SAME commits in the date order the server used
//    to return, no row may leave a lane aimed at a commit already drawn above
//    it — such a lane can never converge and runs off the bottom of the list.
test('a lane whose parent was already emitted terminates', () => {
  const input = [
    { sha: 'M', parents: ['B', 'S2'] },
    { sha: 'B', parents: ['A'] },
    { sha: 'A', parents: [] },
    { sha: 'S2', parents: ['S1'] },
    { sha: 'S1', parents: ['A'] },
  ];
  const { rows } = computeGraph(input);

  assert.deepEqual(rows[4].lanesAfter, [null, null]);
  const indexOf = new Map(input.map((c, i) => [c.sha, i]));
  for (let i = 0; i < rows.length; i++) {
    for (const target of rows[i].lanesAfter) {
      if (target == null || !indexOf.has(target)) continue;
      assert.ok(indexOf.get(target) > i,
        `row ${i} routes a lane back to already-drawn ${target} (index ${indexOf.get(target)})`);
    }
  }
});

// 6. The guard is narrow: it kills backward edges only, never the legitimate
//    "history continues past the cap" signal. C0 is absent from the window, so
//    C1's lane must still trail off the bottom.
test('a parent outside the window still trails off the bottom', () => {
  const { rows } = computeGraph([
    { sha: 'C2', parents: ['C1'] },
    { sha: 'C1', parents: ['C0'] },
  ]);
  assert.equal(rows[1].lanesAfter[0], 'C0');
});

// 7. The multi-parent half of the `seen` guard. A merge whose SECOND parent was
//    already emitted must open no lane aimed at it — the first-parent clause
//    cannot cover this, it is a different branch of the routing.
//      B()  M(A,B)  A()   — B is drawn at index 0, above the merge that names it
test('a merge whose non-first parent was already emitted opens no lane at it', () => {
  const { rows, maxCols } = computeGraph([
    { sha: 'B', parents: [] },
    { sha: 'M', parents: ['A', 'B'] },
    { sha: 'A', parents: [] },
  ]);

  assert.deepEqual(rows[1].lanesAfter, ['A'], 'no second lane is opened toward B');
  assert.equal(maxCols, 1, 'and no phantom column is reserved for it');
  assert.deepEqual(rows[2].lanesAfter, [null], 'the root terminates the one lane');
});
