// tests/poll.mjs — the one waitFor/sleep: the timeout names why, the deadline
// is exact, helpers.mjs re-exports the same functions, and the leaf stays light.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitFor, sleep } from './poll.mjs';

const flush = () => new Promise((r) => setImmediate(r));

test('waitFor resolves with the first truthy value, not true', async () => {
  const v = { k: 1 };
  let n = 0;
  const got = await waitFor(() => (++n === 2 ? v : false), { interval: 1, timeout: 5000 });
  assert.equal(got, v);
});

test('waitFor retries a throwing predicate instead of propagating the throw', async () => {
  let calls = 0;
  const got = await waitFor(() => { if (++calls <= 2) throw new Error('not yet'); return 'ok'; }, { interval: 1, timeout: 5000 });
  assert.equal(got, 'ok');
  assert.equal(calls, 3);
});

test('timeout names the label and the predicate error, which is also the cause', async () => {
  const err = new TypeError('boom');
  const e = await waitFor(() => { throw err; }, { timeout: 30, interval: 5, label: 'the widget to be ready' }).catch((x) => x);
  assert.match(e.message, /^waitFor: timeout/);
  assert.match(e.message, /the widget to be ready/);
  assert.match(e.message, /TypeError: boom/);
  assert.equal(e.cause, err);
});

test('timeout reports the latest throw, not the first', async () => {
  let n = 0;
  const second = new Error('second');
  const e = await waitFor(() => { throw ++n === 1 ? new Error('first') : second; }, { timeout: 30, interval: 5 }).catch((x) => x);
  assert.match(e.message, /second/);
  assert.doesNotMatch(e.message, /first/);
  assert.equal(e.cause, second);
});

test('a throw is kept when later attempts return falsy, with its attempt index', async () => {
  let n = 0;
  const only = new Error('only');
  const e = await waitFor(() => { if (++n === 1) throw only; return false; }, { timeout: 30, interval: 5 }).catch((x) => x);
  assert.match(e.message, /attempt 1 threw: Error: only/);
  assert.equal(e.cause, only);
});

test('a timeout with no throw and no label has no label text and no cause', async () => {
  const e = await waitFor(() => false, { timeout: 20, interval: 5 }).catch((x) => x);
  assert.match(e.message, /^waitFor: timeout/);
  assert.doesNotMatch(e.message, /undefined|threw/);
  assert.equal('cause' in e, false);
});

test('the deadline is honoured exactly: pending at timeout, rejected at the first check past it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let outcome;
  waitFor(() => false, { timeout: 100, interval: 10 }).then((v) => { outcome = { v }; }, (e) => { outcome = { e }; });
  for (let i = 0; i < 10; i++) { await flush(); t.mock.timers.tick(10); }
  await flush();
  assert.equal(outcome, undefined, 'still waiting at Date.now() === timeout');
  t.mock.timers.tick(10);
  await flush();
  assert.ok(outcome?.e, 'rejected at the first check past the timeout');
  assert.match(outcome.e.message, /\(12 attempts\)/);
});

test('sleep waits exactly ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  sleep(50).then(() => { done = true; });
  t.mock.timers.tick(49);
  await flush();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true);
});

test('helpers.mjs re-exports the leaf waitFor and sleep', async () => {
  const h = await import('./helpers.mjs');
  assert.equal(h.waitFor, waitFor);
  assert.equal(h.sleep, sleep);
});

test('poll.mjs imports nothing but node: builtins, so a light test can take it', () => {
  const src = readFileSync(new URL('./poll.mjs', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const s of specs) assert.ok(s.startsWith('node:'), `non-builtin import ${s}`);
});
