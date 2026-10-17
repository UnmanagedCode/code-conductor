// src/keyedQueue.ts: calls sharing a key run one at a time in call order;
// different keys run concurrently; a rejection never blocks the key; an idle
// key holds no entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedQueue } from '../src/keyedQueue.ts';

// A promise the test settles by hand, so ordering is decided by the test and
// never by timers.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test('same key: the second call starts only after the first settles, in call order', async () => {
  const run = createKeyedQueue();
  const events = [];
  const a = deferred();
  const first = run('k', async () => { events.push('a:start'); await a.promise; events.push('a:end'); return 'A'; });
  const second = run('k', async () => { events.push('b:start'); return 'B'; });
  await tick();
  assert.deepEqual(events, ['a:start'], 'b has not started while a is pending');
  a.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
});

test('different keys run concurrently', async () => {
  const run = createKeyedQueue();
  const events = [];
  const a = deferred();
  const first = run('x', async () => { events.push('x:start'); await a.promise; });
  const second = run('y', async () => { events.push('y:start'); });
  await second;
  assert.deepEqual(events, ['x:start', 'y:start'], 'y finished while x was still pending');
  a.resolve();
  await first;
});

test('a rejection reaches its own caller and does not block the next call on the key', async () => {
  const run = createKeyedQueue();
  const failing = run('k', async () => { throw new Error('boom'); });
  const next = run('k', async () => 'after');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'after');
});

test('a key\'s entry is cleared once its tail settles, and only then', async () => {
  const run = createKeyedQueue();
  const a = deferred();
  const p = run('k', () => a.promise);
  assert.equal(run.size(), 1);
  a.resolve();
  await p;
  await tick();
  assert.equal(run.size(), 0);
  await assert.rejects(run('k', async () => { throw new Error('x'); }));
  await tick();
  assert.equal(run.size(), 0, 'a rejected tail is cleared too');
});
