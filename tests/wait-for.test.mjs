// Unit tests for src/waitFor.ts — the one promise shape behind every
// listener-driven waiter in the codebase (see this module's importers).
//
// The real risk the helper exists to remove is teardown that runs on only ONE
// of the settle/timeout paths, so every test here asserts `listenerCount()` on
// a bare node:events EventEmitter — a dropped `off()` is then a hard failure,
// not a slow leak nobody notices. No subprocesses, no network, timeouts in the
// tens of ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitFor } from '../src/waitFor.ts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('initial short-circuits without subscribing', async () => {
  let subscribed = false;
  const result = await waitFor({
    initial: () => ({ value: 'already-there' }),
    subscribe: () => { subscribed = true; return () => {}; },
    timeoutMs: 50,
    onTimeout: () => new Error('should never time out'),
  });
  assert.equal(result, 'already-there');
  assert.equal(subscribed, false, 'the fast path must not attach any listener');
});

test('the resolve path detaches every listener', async () => {
  const em = new EventEmitter();
  const p = waitFor({
    subscribe: (settle) => {
      const fn = (v) => settle(v);
      em.on('x', fn);
      return () => em.off('x', fn);
    },
    timeoutMs: 1000,
    onTimeout: () => new Error('not reached'),
  });
  em.emit('x', 'fired');
  assert.equal(await p, 'fired');
  assert.equal(em.listenerCount('x'), 0, 'teardown must run on the RESOLVE path too');
});

test('the resolve path clears the timer', async () => {
  const em = new EventEmitter();
  let timedOut = false;
  const p = waitFor({
    subscribe: (settle) => {
      const fn = (v) => settle(v);
      em.on('x', fn);
      return () => em.off('x', fn);
    },
    timeoutMs: 50,
    onTimeout: () => { timedOut = true; return 'timeout-value'; },
  });
  em.emit('x', 'fired');
  assert.equal(await p, 'fired');
  await sleep(120);   // well past timeoutMs
  assert.equal(timedOut, false, 'a settled wait must not still fire its timeout');
});

test('a value-returning onTimeout resolves, and detaches', async () => {
  // The waitForIdleOnce / waitAllIdle disposition.
  const em = new EventEmitter();
  const result = await waitFor({
    subscribe: (settle) => {
      const fn = (v) => settle(v);
      em.on('x', fn);
      return () => em.off('x', fn);
    },
    timeoutMs: 20,
    onTimeout: () => 'timeout',
  });
  assert.equal(result, 'timeout');
  assert.equal(em.listenerCount('x'), 0, 'teardown must run on the TIMEOUT path too');
});

test('an Error-returning onTimeout rejects, and detaches', async () => {
  // The Error-returning disposition — no production adopter today; see docs/architecture.md.
  const em = new EventEmitter();
  const boom = new Error('timed out after 20 ms');
  await assert.rejects(
    waitFor({
      subscribe: (settle) => {
        const fn = (v) => settle(v);
        em.on('x', fn);
        return () => em.off('x', fn);
      },
      timeoutMs: 20,
      onTimeout: () => boom,
    }),
    (e) => e === boom,
  );
  assert.equal(em.listenerCount('x'), 0, 'teardown must run on the REJECT path too');
});

test('a listener firing after the timeout cannot settle twice, and teardown runs once', async () => {
  // The `done` guard is NOT observable through the resolved value — resolve() on
  // an already-settled promise is a no-op, so the value is safe either way. What
  // the guard actually protects is the "exactly one cleanup, never twice"
  // contract, so that is what is asserted here.
  const em = new EventEmitter();
  const captured = [];
  let teardowns = 0;
  const p = waitFor({
    subscribe: (settle) => {
      // Deliberately keeps a reference the teardown cannot revoke, so a missing
      // `done` guard would let this re-enter finish() after the fact.
      captured.push(settle);
      const fn = (v) => settle(v);
      em.on('x', fn);
      return () => { teardowns++; em.off('x', fn); };
    },
    timeoutMs: 20,
    onTimeout: () => 'timeout',
  });
  assert.equal(await p, 'timeout');
  assert.equal(teardowns, 1, 'the timeout path tears down exactly once');

  // Fire the retained settle AND the emitter after the fact.
  for (const settle of captured) settle('late');
  em.emit('x', 'late');
  await sleep(20);
  assert.equal(await p, 'timeout', 'the settled value is immutable after the fact');
  assert.equal(teardowns, 1, 'a late settle must not re-run teardown — the `done` guard');
});

test('the resolve path also tears down exactly once', async () => {
  const em = new EventEmitter();
  let teardowns = 0;
  const p = waitFor({
    subscribe: (settle) => {
      const fn = (v) => settle(v);
      em.on('x', fn);
      return () => { teardowns++; em.off('x', fn); };
    },
    timeoutMs: 1000,
    onTimeout: () => 'to',
  });
  em.emit('x', 'first');
  // A second emit BEFORE the teardown detached would re-enter settle().
  em.emit('x', 'second');
  assert.equal(await p, 'first');
  assert.equal(teardowns, 1, 'exactly one cleanup on the resolve path');
});

test('a multi-listener subscribe detaches all of them, on both paths', async () => {
  // The waitAllIdle (N instances) shape.
  const subscribeTwo = (a, b) => (settle, fail) => {
    const onA = (v) => settle(v);
    const onB = () => fail(new Error('aborted'));
    a.on('x', onA);
    b.on('y', onB);
    return () => { a.off('x', onA); b.off('y', onB); };
  };

  // Run 1: resolves.
  const a1 = new EventEmitter(), b1 = new EventEmitter();
  const p1 = waitFor({ subscribe: subscribeTwo(a1, b1), timeoutMs: 1000, onTimeout: () => 'to' });
  a1.emit('x', 'ok');
  assert.equal(await p1, 'ok');
  assert.equal(a1.listenerCount('x'), 0, 'first listener detached on resolve');
  assert.equal(b1.listenerCount('y'), 0, 'SECOND listener detached on resolve');

  // Run 2: times out.
  const a2 = new EventEmitter(), b2 = new EventEmitter();
  const p2 = waitFor({ subscribe: subscribeTwo(a2, b2), timeoutMs: 20, onTimeout: () => 'to' });
  assert.equal(await p2, 'to');
  assert.equal(a2.listenerCount('x'), 0, 'first listener detached on timeout');
  assert.equal(b2.listenerCount('y'), 0, 'SECOND listener detached on timeout');

  // Run 3: the fail() path detaches both too.
  const a3 = new EventEmitter(), b3 = new EventEmitter();
  const p3 = waitFor({ subscribe: subscribeTwo(a3, b3), timeoutMs: 1000, onTimeout: () => 'to' });
  b3.emit('y');
  await assert.rejects(p3, /aborted/);
  assert.equal(a3.listenerCount('x'), 0, 'first listener detached on fail');
  assert.equal(b3.listenerCount('y'), 0, 'SECOND listener detached on fail');
});

test('a synchronous settle inside subscribe still detaches', async () => {
  // finish() runs before `teardown` has been assigned, so the tail
  // `if (done) teardown()` is the only thing that detaches here.
  const em = new EventEmitter();
  const result = await waitFor({
    subscribe: (settle) => {
      const fn = (v) => settle(v);
      em.on('x', fn);
      settle('sync');            // settles BEFORE returning the teardown
      return () => em.off('x', fn);
    },
    timeoutMs: 1000,
    onTimeout: () => new Error('not reached'),
  });
  assert.equal(result, 'sync');
  assert.equal(em.listenerCount('x'), 0,
    'a synchronously-settled wait must not leak the listeners subscribe attached');
});
