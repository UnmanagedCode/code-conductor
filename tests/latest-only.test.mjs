// Unit tests for latestOnly() — the sequencing guard that stops a
// slower-but-earlier-dispatched async call from clobbering a result already
// applied by a call dispatched later (see public/app.js refreshInstances()).
// Pure JS, no DOM: exercises the guard in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function load() {
  return import(pathToFileURL(path.join(PUB, 'latestOnly.js')).href);
}

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('a slower call dispatched earlier is dropped when a faster later call resolves first', async () => {
  const { latestOnly } = await load();
  const guard = latestOnly();
  const applied = [];

  const p1 = guard(() => delay(50, 'stale'), (v) => applied.push(v));
  const p2 = guard(() => delay(5, 'fresh'), (v) => applied.push(v));

  await Promise.all([p1, p2]);
  assert.deepEqual(applied, ['fresh']);
});

test('a single call always applies', async () => {
  const { latestOnly } = await load();
  const guard = latestOnly();
  const applied = [];
  await guard(() => Promise.resolve('only'), (v) => applied.push(v));
  assert.deepEqual(applied, ['only']);
});

test('three interleaved calls: only the last-dispatched one applies', async () => {
  const { latestOnly } = await load();
  const guard = latestOnly();
  const applied = [];

  const p1 = guard(() => delay(30, 'a'), (v) => applied.push(v));
  const p2 = guard(() => delay(20, 'b'), (v) => applied.push(v));
  const p3 = guard(() => delay(10, 'c'), (v) => applied.push(v));

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(applied, ['c']);
});

test('sequential (non-overlapping) calls all apply', async () => {
  const { latestOnly } = await load();
  const guard = latestOnly();
  const applied = [];
  await guard(() => Promise.resolve('first'), (v) => applied.push(v));
  await guard(() => Promise.resolve('second'), (v) => applied.push(v));
  assert.deepEqual(applied, ['first', 'second']);
});
