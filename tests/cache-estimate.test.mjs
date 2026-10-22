// CacheEstimator (src/cacheEstimate.ts): the per-turn cache-read estimate for a
// backend whose calls report no cache read. Pure unit tests over the class; the
// end-to-end path through Instance over real captures lives in
// tests/nonclaude-usage-captures.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheEstimator } from '../src/cacheEstimate.ts';

// One call's final delta figures as the parser's call_usage carries them; a
// null cache field is a key the delta did not send.
const call = (inputTokens, outputTokens, { cacheReadTokens = null, cacheCreationTokens = null } = {}) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });
// A turn's result.usage on a backend that never reports a cache read.
const turnUsage = (input_tokens) => ({ input_tokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

test('the first call has no baseline, so nothing of it counts as cached', () => {
  const e = new CacheEstimator();
  e.onCall(call(1000, 10));
  assert.deepEqual(e.endTurn(turnUsage(1000)), { inputTokens: 1000, cacheReadTokens: 0 });
});

test('a later call counts min(its prompt, the previous prompt + output) as cached', async (t) => {
  await t.test('the context grew: the whole previous prompt + output is cached', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 20));
    assert.deepEqual(e.endTurn(turnUsage(2500)), { inputTokens: 2500 - 1010, cacheReadTokens: 1010 });
  });
  await t.test('the prompt is no larger than the previous prompt + output: all of it is cached', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.onCall(call(1005, 20));
    assert.deepEqual(e.endTurn(turnUsage(2005)), { inputTokens: 2005 - 1005, cacheReadTokens: 1005 });
  });
  await t.test('the baseline carries across a turn boundary', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.endTurn(turnUsage(1000));
    e.onCall(call(1200, 5));
    assert.deepEqual(e.endTurn(turnUsage(1200)), { inputTokens: 190, cacheReadTokens: 1010 });
  });
});

test('a prompt smaller than the previous one counts as uncached', () => {
  const e = new CacheEstimator();
  e.onCall(call(1000, 10));
  e.onCall(call(900, 10));
  assert.deepEqual(e.endTurn(turnUsage(1900)), { inputTokens: 1900, cacheReadTokens: 0 });
});

test('cache creation counts toward a call\'s prompt', () => {
  const e = new CacheEstimator();
  e.onCall(call(600, 10, { cacheCreationTokens: 400 }));
  e.onCall(call(1100, 10));
  assert.deepEqual(e.endTurn(turnUsage(1700)), { inputTokens: 1700 - 1010, cacheReadTokens: 1010 });
});

test('reset() clears the baseline but not what the backend reports', async (t) => {
  await t.test('the next keyless call after a reset counts as uncached', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.reset();
    e.onCall(call(1500, 10));
    assert.deepEqual(e.endTurn(turnUsage(2500)), { inputTokens: 2500, cacheReadTokens: 0 });
  });
  await t.test('a backend that reported a cache read before the reset still estimates nothing after it', () => {
    const e = new CacheEstimator();
    e.onCall(call(10, 10, { cacheReadTokens: 990 }));
    e.reset();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 10));
    assert.equal(e.endTurn(turnUsage(2510)), null);
  });
});

test('resetCapability() forgets that the backend reports cache reads', () => {
  const e = new CacheEstimator();
  e.onCall(call(10, 10, { cacheReadTokens: 990 }));
  e.endTurn(turnUsage(10));
  e.resetCapability();
  e.onCall(call(1000, 10));
  assert.deepEqual(e.endTurn(turnUsage(1000)), { inputTokens: 1000, cacheReadTokens: 0 });
});

test('resetCapability() clears an in-flight turn\'s estimated sum', async (t) => {
  await t.test('a turn with no call after it estimates nothing', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 10));
    e.resetCapability();
    assert.equal(e.endTurn(turnUsage(2500)), null);
  });
  await t.test('a call after it counts only its own (uncached) share', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 10));
    e.resetCapability();
    e.onCall(call(2000, 10));
    assert.deepEqual(e.endTurn(turnUsage(2000)), { inputTokens: 2000, cacheReadTokens: 0 });
  });
});

test('abandonTurn() drops the open turn\'s sum and the baseline, and keeps what the backend reports', async (t) => {
  await t.test('the abandoned calls add nothing to the next turn', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 10));
    e.abandonTurn();
    e.onCall(call(1200, 10));
    e.onCall(call(1300, 10));
    assert.deepEqual(e.endTurn(turnUsage(2500)), { inputTokens: 2500 - 1210, cacheReadTokens: 1210 });
  });
  await t.test('a turn with no call after it estimates nothing', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    e.abandonTurn();
    assert.equal(e.endTurn(turnUsage(1000)), null);
  });
  await t.test('a backend that reported a cache read is still not estimated', () => {
    const e = new CacheEstimator();
    e.onCall(call(10, 10, { cacheReadTokens: 990 }));
    e.abandonTurn();
    e.onCall(call(1000, 10));
    e.onCall(call(1500, 10));
    assert.equal(e.endTurn(turnUsage(2500)), null);
  });
});

test('a call with no reported input leaves the next keyless call uncached', () => {
  const e = new CacheEstimator();
  e.onCall(call(1000, 10));
  e.onCall(call(null, 5));
  e.onCall(call(1500, 10));
  assert.deepEqual(e.endTurn(turnUsage(2500)), { inputTokens: 2500, cacheReadTokens: 0 });
});

test('a call that reports a cache read estimates nothing, and makes later keyless calls genuine misses', async (t) => {
  await t.test('a reported read: endTurn is null', () => {
    const e = new CacheEstimator();
    e.onCall(call(16, 10, { cacheReadTokens: 984 }));
    assert.equal(e.endTurn(turnUsage(16)), null);
  });
  await t.test('a reported read of 0 still counts as reporting', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10, { cacheReadTokens: 0 }));
    e.onCall(call(1500, 10));
    assert.equal(e.endTurn(turnUsage(2500)), null);
  });
  await t.test('later keyless calls in later turns are not estimated', () => {
    const e = new CacheEstimator();
    e.onCall(call(16, 10, { cacheReadTokens: 984 }));
    e.endTurn(turnUsage(16));
    e.onCall(call(1500, 10));
    assert.equal(e.endTurn(turnUsage(1500)), null);
  });
});

test('seed() sets the baseline to the seeded prompt + output', () => {
  const e = new CacheEstimator();
  e.seed({ input_tokens: 700, cache_read_input_tokens: 300, output_tokens: 10 });
  e.onCall(call(1500, 10));
  assert.deepEqual(e.endTurn(turnUsage(1500)), { inputTokens: 490, cacheReadTokens: 1010 });
});

test('endTurn returns null when there is nothing to re-split', async (t) => {
  await t.test('no call this turn', () => {
    assert.equal(new CacheEstimator().endTurn(turnUsage(1000)), null);
  });
  await t.test('no turn usage', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    assert.equal(e.endTurn(null), null);
  });
  await t.test('the turn usage reports a cache read', () => {
    const e = new CacheEstimator();
    e.onCall(call(1000, 10));
    assert.equal(e.endTurn({ input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 500 }), null);
  });
});

test('endTurn closes the turn: the next turn re-splits only its own calls', () => {
  const e = new CacheEstimator();
  e.onCall(call(1000, 10));
  e.onCall(call(1500, 10));
  e.endTurn(turnUsage(2500));
  assert.equal(e.endTurn(turnUsage(0)), null, 'a turn with no calls estimates nothing');
});

test('an estimated sum above the reported input is refused with a warning, not clamped', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const e = new CacheEstimator();
  e.onCall(call(1000, 10));
  e.onCall(call(1500, 10));
  assert.equal(e.endTurn(turnUsage(1000)), null);
  assert.equal(warn.mock.callCount(), 1);
  const msg = warn.mock.calls[0].arguments.join(' ');
  assert.ok(msg.includes('1010') && msg.includes('1000'), `the warning names both numbers: ${msg}`);
});

test('the estimate re-splits the reported input exactly: input + cacheRead === usage.input_tokens', async (t) => {
  const prompts = [[1000, 10], [1200, 30], [1190, 5], [2000, 40], [2050, 0]];
  for (let n = 1; n <= prompts.length; n++) {
    await t.test(`${n} call(s)`, () => {
      const e = new CacheEstimator();
      let reported = 0;
      for (const [p, o] of prompts.slice(0, n)) { e.onCall(call(p, o)); reported += p; }
      const r = e.endTurn(turnUsage(reported));
      assert.equal(r.inputTokens + r.cacheReadTokens, reported);
    });
  }
});
