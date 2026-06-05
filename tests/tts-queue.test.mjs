import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TtsQueue } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'tts-queue.js')).href);

// Drain all pending micro/macro tasks.
const flush = () => new Promise(r => setTimeout(r, 0));

// Build a queue whose playFn resolves immediately (synchronous mock).
function makeInstantQueue() {
  const played = [];
  const queue = new TtsQueue(async (text) => { played.push(text); });
  return { queue, played };
}

// Build a queue whose playFn blocks until the caller resolves it manually.
function makeBlockingQueue() {
  const played = [];
  const resolvers = [];
  const queue = new TtsQueue(async (text) => {
    played.push(text);
    await new Promise(r => resolvers.push(r));
  });
  return { queue, played, resolvers };
}

// ── Basic FIFO ordering ───────────────────────────────────────────────────────

test('items played in FIFO order', async () => {
  const { queue, played } = makeInstantQueue();
  queue.enqueue({ text: 'a' });
  queue.enqueue({ text: 'b' });
  queue.enqueue({ text: 'c' });
  await flush();
  assert.deepEqual(played, ['a', 'b', 'c']);
});

test('second segment does not start until first playFn resolves', async () => {
  const { queue, played, resolvers } = makeBlockingQueue();
  queue.enqueue({ text: 'a' });
  queue.enqueue({ text: 'b' });
  await flush();

  assert.equal(played.length, 1, 'only first segment started');
  assert.equal(played[0], 'a');
  assert.equal(queue.size, 1, 'second segment still pending');

  resolvers[0](); // finish 'a'
  await flush();

  assert.equal(played.length, 2, 'second segment now played');
  assert.equal(played[1], 'b');

  resolvers[1]?.(); // clean up
  await flush();
});

test('drain is active while items are playing', async () => {
  const { queue, resolvers } = makeBlockingQueue();
  queue.enqueue({ text: 'x' });
  await flush();

  assert.equal(queue.draining, true);
  resolvers[0]();
  await flush();
  assert.equal(queue.draining, false);
});

// ── flush() ───────────────────────────────────────────────────────────────────

test('flush() clears pending items — current item still plays to completion', async () => {
  const { queue, played, resolvers } = makeBlockingQueue();
  queue.enqueue({ text: 'a' });
  queue.enqueue({ text: 'b' });
  queue.enqueue({ text: 'c' });
  await flush(); // 'a' is now playing, 'b'+'c' pending

  queue.flush(); // clear 'b' and 'c'
  assert.equal(queue.size, 0);

  resolvers[0](); // finish 'a'
  await flush();

  assert.deepEqual(played, ['a'], "'b' and 'c' never played after flush");
  assert.equal(queue.draining, false);
});

test('new item enqueued after flush plays normally', async () => {
  const { queue, played, resolvers } = makeBlockingQueue();
  queue.enqueue({ text: 'a' });
  await flush();

  queue.flush();
  queue.enqueue({ text: 'z' });

  resolvers[0](); // finish 'a' (drain wakes, finds 'z')
  await flush();
  resolvers[1]?.(); // finish 'z'
  await flush();

  assert.ok(played.includes('z'), "'z' played after post-flush enqueue");
});

// ── No competing drains ───────────────────────────────────────────────────────

test('rapid enqueues during drain do not start competing drain loops', async () => {
  const { queue, played, resolvers } = makeBlockingQueue();

  // Enqueue 4 items rapidly while drain is active.
  queue.enqueue({ text: '1' });
  queue.enqueue({ text: '2' });
  queue.enqueue({ text: '3' });
  queue.enqueue({ text: '4' });
  await flush();

  // Only one item should be playing; three pending.
  assert.equal(played.length, 1);

  // Resolve all one by one.
  for (let i = 0; i < 4; i++) {
    resolvers[i]?.();
    await flush();
  }

  assert.deepEqual(played, ['1', '2', '3', '4']);
});

// ── onStart hook ─────────────────────────────────────────────────────────────

test('onStart fires before playFn for the first item', async () => {
  const events = [];
  const queue = new TtsQueue(async (text) => { events.push(`play:${text}`); });
  queue.enqueue({ text: 'a', onStart: () => events.push('start:a') });
  await flush();
  assert.deepEqual(events, ['start:a', 'play:a']);
});

test('onStart fires for each item at the moment it begins (not when enqueued)', async () => {
  const events = [];
  const resolvers = [];
  const queue = new TtsQueue(async (text) => {
    events.push(`play:${text}`);
    await new Promise(r => resolvers.push(r));
  });
  queue.enqueue({ text: 'a', onStart: () => events.push('start:a') });
  queue.enqueue({ text: 'b', onStart: () => events.push('start:b') });
  await flush();

  // 'a' is playing; 'b' hasn't started.
  assert.deepEqual(events, ['start:a', 'play:a']);

  resolvers[0](); // finish 'a' → 'b' starts
  await flush();

  assert.deepEqual(events, ['start:a', 'play:a', 'start:b', 'play:b']);

  resolvers[1]?.();
  await flush();
});

test('item without onStart plays without error', async () => {
  const played = [];
  const queue = new TtsQueue(async (text) => { played.push(text); });
  queue.enqueue({ text: 'no-hook' });
  await flush();
  assert.deepEqual(played, ['no-hook']);
});

// ── interruptDrain() ─────────────────────────────────────────────────────────

test('interruptDrain() lets next enqueue start a fresh drain synchronously', async () => {
  const events = [];
  const resolvers = [];
  const queue = new TtsQueue(async (text) => {
    events.push(`play:${text}`);
    await new Promise(r => resolvers.push(r));
  });

  // Start item 'a'.
  queue.enqueue({ text: 'a' });
  await flush(); // 'a' is playing

  // Simulate requestSpeak: flush pending, interrupt, re-enqueue tap item.
  queue.flush();
  queue.interruptDrain(); // reset _draining
  queue.enqueue({ text: 'tap', onStart: () => events.push('start:tap') });
  // onStart + play:tap should have fired synchronously (within this tick).
  assert.ok(events.includes('start:tap'), 'onStart fired synchronously after interruptDrain');
  assert.ok(events.includes('play:tap'), 'playFn called synchronously after interruptDrain');

  // Resolve 'a' — stale drain wakes but exits without resetting _draining.
  resolvers[0]();
  await flush();
  assert.equal(queue.draining, true, 'new drain still active after stale drain exits');

  resolvers[1]?.();
  await flush();
  assert.equal(queue.draining, false);
});

// ── Queue size tracking ───────────────────────────────────────────────────────

test('size reflects pending items (not counting the currently-playing one)', async () => {
  const { queue, resolvers } = makeBlockingQueue();
  queue.enqueue({ text: 'a' });
  queue.enqueue({ text: 'b' });
  queue.enqueue({ text: 'c' });
  await flush();

  assert.equal(queue.size, 2, '2 items pending after first started playing');

  resolvers[0]();
  await flush();
  assert.equal(queue.size, 1);

  resolvers[1]();
  await flush();
  assert.equal(queue.size, 0);
  resolvers[2]?.();
  await flush();
});
