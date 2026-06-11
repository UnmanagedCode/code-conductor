// EventLog ring-cap behavior: bounded drop-oldest eviction, monotonic _seq
// across trims, trimmedBefore tracking, snap-to-turn-boundary, clear()
// resetting the sequence counter (the rewind contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/instances.js';

function pushN(log, n, makeEv = (i) => ({ kind: 'text_delta', text: `e${i}` })) {
  for (let i = 0; i < n; i++) log.push(makeEv(i));
}

test('unbounded behavior below the cap: nothing trimmed, _seq == index', () => {
  const log = new EventLog({ cap: 50 });
  pushN(log, 50);
  const arr = log.toArray();
  assert.equal(arr.length, 50);
  assert.equal(log.trimmedBefore, 0);
  arr.forEach((ev, i) => assert.equal(ev._seq, i));
});

test('drop-oldest eviction keeps _seq monotonic and contiguous', () => {
  const log = new EventLog({ cap: 10 }); // slack scales down to 10 → trim at >20
  pushN(log, 100);
  const arr = log.toArray();
  // Buffer stays within [some retained tail, cap + slack].
  assert.ok(arr.length <= 10 + log.slack, `len ${arr.length} > cap+slack`);
  assert.ok(arr.length >= 10 / 2, 'trim dropped below cap/2');
  // Newest event always retained, with the absolute (never-renumbered) seq.
  assert.equal(arr[arr.length - 1]._seq, 99);
  // Retained seqs are contiguous; trimmedBefore is the first retained seq.
  assert.equal(log.trimmedBefore, arr[0]._seq);
  assert.ok(log.trimmedBefore > 0, 'expected eviction to have happened');
  arr.forEach((ev, i) => assert.equal(ev._seq, arr[0]._seq + i));
  // nextSeq keeps counting past the trim.
  assert.equal(log.nextSeq, 100);
});

test('trim snaps the surviving head to an outer user_echo', () => {
  const log = new EventLog({ cap: 10 });
  // A user_echo every 4th event — there is always a turn boundary within
  // the snappable window, so after any trim the head must be a user_echo.
  pushN(log, 200, (i) => (i % 4 === 0
    ? { kind: 'user_echo', text: `prompt ${i}` }
    : { kind: 'text_delta', text: `e${i}` }));
  const head = log.toArray()[0];
  assert.equal(head.kind, 'user_echo');
});

test('snap ignores sub-agent user_echo (parentToolUseId set)', () => {
  const log = new EventLog({ cap: 10 });
  pushN(log, 200, (i) => (i % 4 === 0
    ? { kind: 'user_echo', text: `sub ${i}`, parentToolUseId: 'tu_1' }
    : { kind: 'text_delta', text: `e${i}` }));
  const head = log.toArray()[0];
  // No outer echo exists → plain cut (head is whatever the cut landed on,
  // never treated as a turn boundary).
  assert.notEqual(head.kind === 'user_echo' && !head.parentToolUseId, true);
  // Resting size stays within the [cap, cap + slack] band (trim is batched).
  assert.ok(log.toArray().length <= 10 + log.slack);
});

test('snap gives up rather than dropping below cap/2 (giant turn)', () => {
  const log = new EventLog({ cap: 10 });
  // No user_echo at all — one giant turn. Trim must fall back to the
  // plain cut instead of eating the buffer down past cap/2.
  pushN(log, 500);
  const arr = log.toArray();
  assert.ok(arr.length >= Math.ceil(10 / 2), 'dropped below cap/2');
  assert.ok(arr.length <= 10 + log.slack, 'exceeded cap + slack');
  assert.equal(arr[arr.length - 1]._seq, 499);
});

test('clear() resets nextSeq so a rewind-replay restarts at seq 0', () => {
  const log = new EventLog({ cap: 10 });
  pushN(log, 50);
  log.clear();
  assert.equal(log.nextSeq, 0);
  assert.equal(log.trimmedBefore, 0);
  log.push({ kind: 'user_echo', text: 'fresh' });
  assert.equal(log.toArray()[0]._seq, 0);
});

test('cap is configurable via ORCH_EVENT_RING_CAP env', () => {
  const prev = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '7';
  try {
    const log = new EventLog();
    assert.equal(log.cap, 7);
    pushN(log, 100);
    assert.ok(log.toArray().length <= 7 + log.slack);
  } finally {
    if (prev === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prev;
  }
});

test('default cap is 2000', () => {
  const prev = process.env.ORCH_EVENT_RING_CAP;
  delete process.env.ORCH_EVENT_RING_CAP;
  try {
    assert.equal(new EventLog().cap, 2000);
  } finally {
    if (prev !== undefined) process.env.ORCH_EVENT_RING_CAP = prev;
  }
});
