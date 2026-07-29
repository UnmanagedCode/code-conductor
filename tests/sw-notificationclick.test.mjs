// Direct tests for public/sw.js's `notificationclick` handler.
//
// sw.js is a classic (non-module) Service Worker script — it must stay that
// way for browser compatibility, so it has no import/export statements and
// registers everything on the ambient `self`. That happens to make it
// trivially importable here too: set `globalThis.self` to a fake before the
// dynamic import runs, and sw.js's top-level `self.addEventListener(...)`
// calls register straight onto it. No scaffolding beyond that fake is
// needed, so the real handler — not a reimplementation — is what's under
// test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.resolve(__dirname, '..', 'public', 'sw.js');

function makeClient({ id, visible = false, focused = false, focusThrows = false, omitVisibilityState = false }) {
  const client = {
    id,
    focused,
    postedMessages: [],
    async focus() {
      if (focusThrows) throw new Error('focus failed');
      return client;
    },
    postMessage(msg) { client.postedMessages.push(msg); },
  };
  // Real WindowClients always carry visibilityState, but the fallback-to-
  // `focused` branch only matters when it's genuinely absent — set it only
  // when the test isn't specifically exercising that fallback.
  if (!omitVisibilityState) client.visibilityState = visible ? 'visible' : 'hidden';
  return client;
}

async function loadFakeSw({ clients = [] } = {}) {
  const opened = [];
  const handlers = {};
  const fakeSelf = {
    addEventListener(type, fn) { handlers[type] = fn; },
    skipWaiting() {},
    clients: {
      async matchAll() { return clients; },
      async openWindow(url) { opened.push(url); return null; },
    },
  };
  globalThis.self = fakeSelf;
  await import(pathToFileURL(SW_PATH).href + `?t=${Math.random()}`);
  return { handlers, opened };
}

async function fireClick(handlers, data) {
  let closed = false;
  const event = {
    notification: { data, close: () => { closed = true; } },
    waitUntil(p) { event._p = p; },
  };
  handlers.notificationclick(event);
  await event._p;
  return { closed };
}

test('notificationclick: postMessages the resolved client with instanceId/sessionId', async () => {
  const client = makeClient({ id: 'c1', visible: true });
  const { handlers } = await loadFakeSw({ clients: [client] });
  const { closed } = await fireClick(handlers, { project: 'p', instanceId: 'inst-1', sessionId: 'sess-1' });
  assert.equal(closed, true, 'notification closed');
  assert.deepEqual(client.postedMessages, [{ type: 'cc-notification-click', instanceId: 'inst-1', sessionId: 'sess-1' }]);
});

test('notificationclick: prefers a visible client over the first-listed hidden one', async () => {
  const hidden = makeClient({ id: 'hidden', visible: false });
  const visible = makeClient({ id: 'visible', visible: true });
  // Hidden client listed FIRST — a naive "focus all[0]" would pick it.
  const { handlers } = await loadFakeSw({ clients: [hidden, visible] });
  await fireClick(handlers, { instanceId: 'inst-1', sessionId: 'sess-1' });
  assert.equal(hidden.postedMessages.length, 0, 'hidden background client is left alone');
  assert.equal(visible.postedMessages.length, 1, 'visible client gets the message');
});

test('notificationclick: falls back to a `focused` client when visibilityState is genuinely absent', async () => {
  const other = makeClient({ id: 'other', omitVisibilityState: true });
  const focused = makeClient({ id: 'focused', focused: true, omitVisibilityState: true });
  assert.ok(!('visibilityState' in other) && !('visibilityState' in focused), 'test setup: visibilityState must actually be absent here');
  const { handlers } = await loadFakeSw({ clients: [other, focused] });
  await fireClick(handlers, { instanceId: 'inst-1' });
  assert.equal(other.postedMessages.length, 0);
  assert.equal(focused.postedMessages.length, 1);
});

test('notificationclick: falls through to the next client if the preferred one fails to focus', async () => {
  const visibleButBroken = makeClient({ id: 'broken', visible: true, focusThrows: true });
  const fallback = makeClient({ id: 'fallback', visible: false });
  const { handlers } = await loadFakeSw({ clients: [visibleButBroken, fallback] });
  await fireClick(handlers, { instanceId: 'inst-1' });
  assert.equal(fallback.postedMessages.length, 1, 'falls back to the remaining client');
});

test('notificationclick: no open clients deep-links openWindow to #session=<id>', async () => {
  const { handlers, opened } = await loadFakeSw({ clients: [] });
  await fireClick(handlers, { instanceId: 'inst-1', sessionId: 'sess-1' });
  assert.deepEqual(opened, ['/#session=sess-1']);
});

test('notificationclick: stale data (no instanceId/sessionId) degrades to today\'s behavior without throwing', async () => {
  const client = makeClient({ id: 'c1' });
  const { handlers, opened } = await loadFakeSw({ clients: [client] });
  await assert.doesNotReject(fireClick(handlers, { project: 'p' }));
  assert.deepEqual(client.postedMessages, [{ type: 'cc-notification-click', instanceId: undefined, sessionId: undefined }]);

  // And with no clients at all, openWindow falls back to bare '/'.
  const { handlers: handlers2, opened: opened2 } = await loadFakeSw({ clients: [] });
  await fireClick(handlers2, { project: 'p' });
  assert.deepEqual(opened2, ['/']);
  void opened;
});

test('notificationclick: missing notification.data entirely does not throw', async () => {
  const { handlers, opened } = await loadFakeSw({ clients: [] });
  await assert.doesNotReject(fireClick(handlers, undefined));
  assert.deepEqual(opened, ['/']);
});
