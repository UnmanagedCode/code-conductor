// CallUsageTracker (src/callUsage.ts): the per-call figures Instance stamps on a
// `call_usage` event — the call's prompt and its growth over the previous
// reading — and the turn's growth endTurn hands to `turn_end`. Pure: the
// instance hands it the latch value read BEFORE each call's message_start
// updates the latch, which is what makes the baseline "null exactly when the
// latch is".

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

// ── the turn's growth (endTurn), stamped on turn_end ──

test('turn growth: the turn-end reading minus the first call\'s baseline, equal to the sum of the turn\'s stamped growths', () => {
  const t = new CallUsageTracker();
  const growths = [];
  t.onMessageStart('m1', 40_000, u(42_500));
  growths.push(stamped(t, 'm1').growthTokens);
  t.onMessageStart('m2', 42_500, u(47_000));
  growths.push(stamped(t, 'm2').growthTokens);
  t.onMessageStart('m3', 47_000, u(46_200));
  growths.push(stamped(t, 'm3').growthTokens);
  assert.deepEqual(growths, [2_500, 4_500, -800], 'premise: distinct growths, one negative');
  const turn = t.endTurn(46_200);
  assert.equal(turn, 46_200 - 40_000);
  assert.equal(turn, growths.reduce((a, b) => a + b, 0));
});

test('turn growth: negative keeps its sign', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', 50_000, u(48_000));
  stamped(t);
  assert.equal(t.endTurn(48_000), -2_000);
});

test('turn growth: null when the turn\'s first call had no baseline', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m', null, u(40_000));
  stamped(t);
  assert.equal(t.endTurn(40_000), null);
});

test('turn growth: null for a turn with no usage-bearing call', async (tt) => {
  await tt.test('no call opened, and the previous turn\'s baseline does not leak', () => {
    const t = new CallUsageTracker();
    t.onMessageStart('m1', 10_000, u(12_000));
    stamped(t, 'm1');
    assert.equal(t.endTurn(12_000), 2_000, 'premise: the previous turn had growth');
    assert.equal(t.endTurn(12_000), null);
  });
  await tt.test('a zero-usage call opened but nothing measured it', () => {
    const t = new CallUsageTracker();
    t.onMessageStart('m', 30_000, null);
    assert.equal(stamped(t).growthTokens, null, 'premise: the line carries no growth');
    assert.equal(t.endTurn(30_000), null, 'not +0');
  });
});

test('turn growth: a reset() mid-turn voids the turn even when later calls have baselines', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m1', 10_000, u(12_000));
  stamped(t, 'm1');
  t.reset();
  t.onMessageStart('m2', 20_000, u(23_000));
  assert.equal(stamped(t, 'm2').growthTokens, 3_000, 'premise: the later call measures its own growth');
  assert.equal(t.endTurn(23_000), null);
});

test('turn growth: a cut-off call that moved the baseline drops the prefix', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m1', 10_000, u(12_000));
  const sum = stamped(t, 'm1').growthTokens;
  t.onMessageStart('m2', 12_000, u(15_000)); // never reaches message_delta: no stamp
  assert.notEqual(15_000 - 10_000, sum, 'premise: ctx-end − baseline differs from the stamped sum');
  assert.equal(t.endTurn(15_000), null);
});

test('turn growth: a cut-off call with zero growth leaves the figures equal, so the prefix stays', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m1', 10_000, u(12_000));
  stamped(t, 'm1');
  t.onMessageStart('m2', 12_000, u(12_000)); // cut off, no stamp, same prompt
  assert.equal(t.endTurn(12_000), 2_000);
});

test('turn growth: a line for a call the tracker never opened adds nothing to the sum', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m1', 10_000, u(12_000));
  stamped(t, 'm1');
  t.onContextUsage('m-next', u(13_000));
  stamped(t, 'm-next');
  assert.equal(t.endTurn(12_000), 2_000);
});

test('turn growth: each turn baselines afresh from its own first call', () => {
  const t = new CallUsageTracker();
  t.onMessageStart('m1', 10_000, u(12_000));
  stamped(t, 'm1');
  assert.equal(t.endTurn(12_000), 2_000, 'premise: turn 1');
  t.onMessageStart('m2', 12_000, u(17_500));
  stamped(t, 'm2');
  assert.equal(t.endTurn(17_500), 17_500 - 12_000);
});

test('turn growth: a reset() mid-turn voids the turn even when the next call\'s baseline continues from the last prompt', async (tt) => {
  const run = (withReset) => {
    const t = new CallUsageTracker();
    t.onMessageStart('m1', 10_000, u(12_000));
    const g1 = stamped(t, 'm1').growthTokens;
    if (withReset) t.reset();
    t.onMessageStart('m2', 12_000, u(13_000));
    const g2 = stamped(t, 'm2').growthTokens;
    return { sum: g1 + g2, turn: t.endTurn(13_000) };
  };
  await tt.test('control: without the reset the two figures are equal and the prefix is published', () => {
    const { sum, turn } = run(false);
    assert.equal(13_000 - 10_000, sum, 'premise: ctx-end − baseline equals the stamped sum');
    assert.equal(turn, 3_000);
  });
  await tt.test('with the reset the turn is voided', () => {
    assert.equal(run(true).turn, null);
  });
});
