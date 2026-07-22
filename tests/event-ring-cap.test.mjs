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

// ── Storage-only coalescing of the ollama thinking flood ─────────────────────

test('system/thinking_tokens is never retained (live-only counter)', () => {
  const log = new EventLog({ cap: 50 });
  log.push({ kind: 'user_echo', text: 'go' });
  const tok = { kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: 42 } };
  log.push(tok);
  const arr = log.toArray();
  assert.equal(arr.length, 1, 'thinking_tokens must not occupy a ring slot');
  assert.equal(arr[0].kind, 'user_echo');
  assert.equal(tok._seq, undefined, 'declined event gets no _seq → emitted seq-less');
  assert.equal(log.nextSeq, 1, 'nextSeq unchanged by a declined event');
});

test('consecutive same-block thinking_delta fold into one slot', () => {
  const log = new EventLog({ cap: 50 });
  const d1 = { kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'Hello' };
  const d2 = { kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: ' world' };
  const d3 = { kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: '!' };
  log.push(d1); log.push(d2); log.push(d3);
  const arr = log.toArray();
  assert.equal(arr.length, 1, 'one ring slot per thinking block');
  assert.equal(arr[0].text, 'Hello world!');
  assert.equal(arr[0]._seq, 0);
  assert.equal(d2._seq, undefined, 'folded delta stays seq-less for the live feed');
  assert.equal(d3._seq, undefined);
  assert.equal(log.nextSeq, 1, 'only the first delta advanced nextSeq');
});

test('coalescing does not span a new block or a non-thinking event', () => {
  const log = new EventLog({ cap: 50 });
  log.push({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'a' });
  // different blockIdx → new slot
  log.push({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 1, text: 'b' });
  // interleaved content → breaks adjacency, next same-block delta opens a slot
  log.push({ kind: 'text_delta', msgId: 'm1', blockIdx: 1, text: 'x' });
  log.push({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 1, text: 'c' });
  const arr = log.toArray();
  assert.deepEqual(arr.map((e) => e.text), ['a', 'b', 'x', 'c']);
  arr.forEach((e, i) => assert.equal(e._seq, i));
});

test('a huge single reasoning turn cannot overflow the ring (no eviction)', () => {
  const log = new EventLog({ cap: 10 });
  log.push({ kind: 'user_echo', text: 'reason hard' });
  log.push({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
  // ollama-style: one thinking_tokens per thinking_delta, thousands of them.
  for (let i = 0; i < 5000; i++) {
    log.push({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: `t${i} ` });
    log.push({ kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: i } });
  }
  log.push({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0 });
  const arr = log.toArray();
  // user_echo + thinking_start + one coalesced delta + thinking_end = 4 slots.
  assert.equal(arr.length, 4, 'turn footprint is O(blocks), not O(tokens)');
  assert.equal(arr[0].kind, 'user_echo');
  assert.equal(log.trimmedBefore, 0, 'nothing evicted → the turn boundary survives, no mid-turn gap');
  assert.equal(arr[2].kind, 'thinking_delta');
  assert.ok(arr[2].text.startsWith('t0 ') && arr[2].text.endsWith('t4999 '));
});
