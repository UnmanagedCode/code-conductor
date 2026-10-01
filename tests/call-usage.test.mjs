// CallUsageTracker (src/callUsage.ts): the per-call figures Instance stamps on a
// `call_usage` event — the call's prompt and its growth over the previous
// reading. Pure: the instance hands it the latch value read BEFORE each call's
// message_start updates the latch, which is what makes the baseline "null
// exactly when the latch is".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallUsageTracker } from '../src/callUsage.ts';

const u = (prompt, output = 10) => ({
  input_tokens: 2, cache_read_input_tokens: prompt - 2, cache_creation_input_tokens: 0, output_tokens: output,
});
const stamped = (tracker, msgId = 'm') => {
  const ev = { kind: 'call_usage', msgId, outputTokens: 1, thinkingTokens: 0 };
  tracker.stamp(ev);
  return { promptTokens: ev.promptTokens, growthTokens: ev.growthTokens };
};

test('no baseline: the prompt is stamped and growth is null', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', null, u(40_000));
  assert.deepEqual(stamped(t), { promptTokens: 40_000, growthTokens: null });
});

test('growth is this call\'s prompt minus the baseline handed in', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', null, u(40_000));
  stamped(t);
  t.onMessageStart('m', 40_000, u(42_500));
  assert.deepEqual(stamped(t), { promptTokens: 42_500, growthTokens: 2_500 });
});

test('a zero-usage backend takes the prompt from context_usage', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 30_000, null);
  assert.deepEqual(stamped(t), { promptTokens: null, growthTokens: null },
    'premise: message_start carried no reading');
  t.onContextUsage('m', u(31_200));
  assert.deepEqual(stamped(t), { promptTokens: 31_200, growthTokens: 1_200 });
});

test('an interrupted call (no call_usage) still replaces the previous call\'s figures', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 10_000, u(12_000));
  // no stamp: the call never reached message_delta
  t.onMessageStart('m', 12_000, u(15_000));
  assert.deepEqual(stamped(t), { promptTokens: 15_000, growthTokens: 3_000 });
});

test('a line for a call the tracker never opened stamps nothing from the open one', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 10_000, u(12_000));
  assert.deepEqual(stamped(t, 'm-next'), { promptTokens: null, growthTokens: null },
    'a call whose message_start never reached the tracker has an unknown prompt');
  t.onContextUsage('m-next', u(13_000));
  assert.deepEqual(stamped(t, 'm-next'), { promptTokens: null, growthTokens: null },
    'a fallback reading for an unopened call does not open it');
  assert.deepEqual(stamped(t), { promptTokens: 12_000, growthTokens: 2_000 }, 'the open call is untouched');
});

test('reset() forgets the open call', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 10_000, u(12_000));
  t.reset();
  assert.deepEqual(stamped(t), { promptTokens: null, growthTokens: null });
});

test('negative growth keeps its sign', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 50_000, u(48_000));
  assert.deepEqual(stamped(t), { promptTokens: 48_000, growthTokens: -2_000 });
});
