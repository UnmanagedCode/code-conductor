// list_sessions' live-row order.
//
// Pure tests — no server boot, no I/O: the comparator is a plain function of its
// input, so it is exercised directly rather than inferred from rendered text
// (tests/mcp-text-render.test.mjs covers the rendering).
//
// FIXTURE RULE, and the reason this file was rewritten: every sort key must be
// DECORRELATED from every other. The first version's worktree names embedded
// their project names and its createdAt order matched its sessionId order, so
// dropping a key still produced the expected output and the mutant survived.
// Here each key alone would produce a DIFFERENT order than the expected one, so
// a "drop key K" mutant can only be killed by the test named for K.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareInstanceRows } from '../src/mcp/handlers.ts';
import { isDeadStatus } from '../src/instances.ts';

const wt = (name) => (name === null ? null : { worktreeName: name, branch: 'b', baseBranch: 'main', baseSha: 'abc', postWorktreeCreate: null });
const row = (project, worktree, createdAt, sessionId) => ({ project, worktree: wt(worktree), createdAt, sessionId });
const order = (rows) => rows.slice().sort(compareInstanceRows).map(r => r.sessionId);

// Four rows, deliberately adversarial. Expected full order: [x, w, z, y].
// No single key, sorted on its own, reproduces that — each one is wrong in a
// different way, so a "drop key K" mutant always changes the output:
//   project only:   ties within each pair, cannot order at all
//   worktree only:  alpha_wt, alpha_wt, mike, zulu → x, z, y, w  (projects split)
//   createdAt only: 10, 20, 30, 40                 → w, y, x, z  (pairs flipped)
//   sessionId only: w, x, y, z                     → w, x, y, z  (pairs flipped)
// The critical decorrelation: within EACH project the worktree order is the
// reverse of both the createdAt order and the sessionId order, so worktree
// cannot be dropped and masked by whatever runs next.
const ROWS = [
  row('beta', 'mike', 20, 'y'),
  row('alpha', 'zulu', 10, 'w'),
  row('beta', 'alpha_wt', 40, 'z'),
  row('alpha', 'alpha_wt', 30, 'x'),
];

describe('compareInstanceRows', () => {
  test('project is the primary key', () => {
    // Both alpha rows precede both beta rows. If `project` is dropped, worktree
    // leads: alpha_wt rows (x, z) would come first, splitting the projects.
    const got = order(ROWS);
    assert.deepEqual(got.slice(0, 2).sort(), ['w', 'x'], 'the alpha rows come first, as a block');
    assert.deepEqual(got.slice(2).sort(), ['y', 'z'], 'the beta rows come second, as a block');
  });

  test('worktree is the secondary key, outranking spawn time', () => {
    // Within alpha: alpha_wt (x, createdAt 30) must precede zulu (w, createdAt
    // 10) — the LATER-spawned row wins because its worktree name sorts first.
    // Drop `worktree` and createdAt decides, putting w before x (and y before z).
    assert.deepEqual(order(ROWS), ['x', 'w', 'z', 'y']);
  });

  test('createdAt orders within one worktree, and sessionId does not', () => {
    // Same project, same worktree: only createdAt can separate these, and it is
    // deliberately anti-correlated with sessionId — 'early' spawned first but
    // sorts LAST alphabetically. Drop createdAt and the sessionId tiebreak
    // reverses the pair.
    assert.deepEqual(order([
      row('p', 'p_wt', 200, 'aaa-later'),
      row('p', 'p_wt', 100, 'zzz-early'),
    ]), ['zzz-early', 'aaa-later']);
  });

  test('a worker with no worktree leads its own project', () => {
    // '' sorts before any name — and again the createdAt is anti-correlated, so
    // this can only pass on the worktree key.
    assert.deepEqual(order([
      row('p', 'aaa_wt', 1, 'second'),
      row('p', null, 999, 'first'),
    ]), ['first', 'second']);
  });

  test('sessionId breaks a full tie, so the order is total', () => {
    // Everything else identical: without the last key this falls back to input
    // order and reshuffles between calls.
    const tied = [row('p', 'p_wt', 5, 'b'), row('p', 'p_wt', 5, 'a')];
    assert.deepEqual(order(tied), ['a', 'b']);
    assert.deepEqual(order(tied.slice().reverse()), ['a', 'b']);
  });

  test('the order does not depend on input order', () => {
    const expected = order(ROWS);
    assert.deepEqual(order(ROWS.slice().reverse()), expected);
    assert.deepEqual(order([ROWS[2], ROWS[0], ROWS[3], ROWS[1]]), expected);
  });

  test('.conduct sorts to the top — the conductor finds itself at [1]', () => {
    assert.equal(order([
      row('zzz', null, 1, 'other'),
      row('.conduct', null, 2, 'self'),
    ])[0], 'self');
  });
});

describe('isDeadStatus', () => {
  test('exactly the two terminal statuses', () => {
    for (const s of ['exited', 'crashed']) assert.equal(isDeadStatus(s), true, s);
    for (const s of ['idle', 'turn', 'spawning', 'running', null, undefined]) {
      assert.equal(isDeadStatus(s), false, String(s));
    }
  });
});
