// public/unreadMarks.js: the one unread fact the sidebar reads — the server's
// turn marks, from a live instance or a disk session row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreadCount, unreadBySession } from '../public/unreadMarks.js';

// Invariant: the count is turnEndSeq − viewedSeq, missing counters read 0, and
// a marker past the turn count never reads negative.
test('unreadCount is the turn-mark difference, floored at 0', () => {
  assert.equal(unreadCount({ turnEndSeq: 5, viewedSeq: 2 }), 3);
  assert.equal(unreadCount({ turnEndSeq: 4 }), 4, 'a missing viewedSeq reads 0');
  assert.equal(unreadCount({}), 0, 'missing counters read 0');
  assert.equal(unreadCount({ turnEndSeq: 1, viewedSeq: 3 }), 0, 'viewedSeq > turnEndSeq reads 0');
});

// Invariant: per-session counts, zero counts omitted.
test('unreadBySession maps each unread session and omits read ones', () => {
  const m = unreadBySession({
    instances: [{ sessionId: 'a', turnEndSeq: 2, viewedSeq: 0 }, { sessionId: 'b', turnEndSeq: 1, viewedSeq: 1 }],
    rows: [{ sessionId: 'c', turnEndSeq: 3, viewedSeq: 1 }, { sessionId: 'd' }],
  });
  assert.deepEqual([...m].sort(), [['a', 2], ['c', 2]]);
});

// Invariant: a live instance's marks win over a (cached, possibly stale) disk
// row for the same session, in either direction.
test('a live instance overrides a disk row for the same session', () => {
  const read = unreadBySession({
    instances: [{ sessionId: 'a', turnEndSeq: 3, viewedSeq: 3 }],
    rows: [{ sessionId: 'a', turnEndSeq: 3, viewedSeq: 1 }],
  });
  assert.equal(read.has('a'), false, 'the live read state wins over a stale unread row');
  const unread = unreadBySession({
    rows: [{ sessionId: 'b', turnEndSeq: 1, viewedSeq: 1 }],
    instances: [{ sessionId: 'b', turnEndSeq: 2, viewedSeq: 1 }],
  });
  assert.equal(unread.get('b'), 1, 'the live unread state wins over a stale read row');
});

// Invariant: an instance with no sessionId yet contributes nothing.
test('an instance with no sessionId is skipped', () => {
  assert.equal(unreadBySession({ instances: [{ sessionId: null, turnEndSeq: 2 }] }).size, 0);
});
