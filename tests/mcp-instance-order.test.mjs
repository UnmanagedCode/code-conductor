// list_instances' row order and its exit-retention bounds.
//
// Pure tests — no server boot, no I/O: the comparator and the tombstone ring are
// both plain functions of their input, so they are exercised directly rather
// than inferred from rendered text (tests/mcp-text-render.test.mjs covers the
// rendering). The order matters because a conductor scans this list; before
// this it was byId Map insertion order, which interleaves projects.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareInstanceRows } from '../src/mcp/handlers.ts';
import { InstanceManager, isDeadStatus } from '../src/instances.ts';

const row = (over) => ({
  project: 'p', worktree: null, createdAt: 0, sessionId: 'z', ...over,
});
const wt = (name) => ({ worktreeName: name, branch: 'b', baseBranch: 'main', baseSha: 'abc', postWorktreeCreate: null });
const order = (rows) => rows.slice().sort(compareInstanceRows).map(r => r.sessionId);

describe('compareInstanceRows', () => {
  test('groups by project, then worktree, then spawn order', () => {
    // Deliberately shuffled: input order must contribute nothing.
    const rows = [
      row({ project: 'zeta', worktree: wt('zeta_wt_2'), createdAt: 50, sessionId: 'f' }),
      row({ project: 'alpha', worktree: wt('alpha_wt_1'), createdAt: 20, sessionId: 'c' }),
      row({ project: '.conduct', worktree: null, createdAt: 99, sessionId: 'a' }),
      row({ project: 'alpha', worktree: wt('alpha_wt_1'), createdAt: 10, sessionId: 'b' }),
      row({ project: 'zeta', worktree: wt('zeta_wt_1'), createdAt: 40, sessionId: 'e' }),
      row({ project: 'alpha', worktree: wt('alpha_wt_2'), createdAt: 5, sessionId: 'd' }),
    ];
    // a: the conductor, first despite being the newest — '.' sorts before any
    // letter, which is what puts the self-identification row at [1].
    // b before c: same worktree, spawn order (an implementer before the reviewer
    // spawned after it). d after both: later worktree name, earlier createdAt —
    // proving worktree outranks time.
    assert.deepEqual(order(rows), ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('a worker with no worktree leads its own project', () => {
    assert.deepEqual(order([
      row({ project: 'p', worktree: wt('p_wt_1'), createdAt: 1, sessionId: 'second' }),
      row({ project: 'p', worktree: null, createdAt: 9, sessionId: 'first' }),
    ]), ['first', 'second']);
  });

  test('sessionId breaks a full tie, so the order is total', () => {
    // Same project, same worktree, same createdAt — without the last key this
    // would fall back to input order and reshuffle between calls.
    const rows = [row({ sessionId: 'b' }), row({ sessionId: 'a' })];
    assert.deepEqual(order(rows), ['a', 'b']);
    assert.deepEqual(order(rows.slice().reverse()), ['a', 'b']);
  });

  test('the sort is stable against re-calling with the same fleet', () => {
    const rows = [
      row({ project: 'b', createdAt: 2, sessionId: 'y' }),
      row({ project: 'a', createdAt: 1, sessionId: 'x' }),
    ];
    assert.deepEqual(order(rows), order(order(rows).map(sid => rows.find(r => r.sessionId === sid))));
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

describe('exit retention', () => {
  const push = (mgr, n, at) => {
    mgr._recentExits.unshift({ id: `i${n}`, project: 'p', status: 'exited', sessionId: `s${n}`, mode: 'code', exitedAt: at });
  };

  test('the count bound caps a burst inside the window', async () => {
    const mgr = new InstanceManager();
    try {
      const now = 1_000_000_000;
      // 60 exits one ms apart, oldest first — all well inside the age window, so
      // only the count bound can stop the ring growing.
      for (let i = 59; i >= 0; i--) push(mgr, i, now - i);
      const kept = mgr.recentExits(now);
      assert.ok(kept.length > 0 && kept.length < 60, `expected a cap between 1 and 60, got ${kept.length}`);
      assert.equal(kept[0].sessionId, 's0', 'the cap must drop the OLDEST, keeping the newest');
    } finally { await mgr.shutdown(); }
  });

  test('the age bound drops a worker that exited long enough ago', async () => {
    const mgr = new InstanceManager();
    try {
      const now = 1_000_000_000;
      push(mgr, 1, now);
      // Walk `now` forward instead of sleeping: the injected clock is the whole
      // reason recentExits takes one.
      assert.equal(mgr.recentExits(now).length, 1, 'still retained a moment after exit');
      assert.equal(mgr.recentExits(now + 60_000).length, 1, 'a minute later, still retained');
      assert.equal(mgr.recentExits(now + 24 * 3600_000).length, 0, 'a day later, aged out');
      assert.equal(mgr._recentExits.length, 0, 'pruning is a real eviction, not a filtered view');
    } finally { await mgr.shutdown(); }
  });
});
