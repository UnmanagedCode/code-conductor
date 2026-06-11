import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneEmanates } from '../public/commits.js';

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
