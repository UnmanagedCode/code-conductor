// Direct test of web/public/sw.js's `notificationclick` handler.
//
// sw.js is a classic (non-module) Service Worker script — it must stay that
// way for browser compatibility, so it has no import/export statements and
// registers everything on the ambient `self`. That happens to make it
// trivially importable here too: set `globalThis.self` to a fake before the
// dynamic import runs, and sw.js's top-level `self.addEventListener(...)`
// calls register straight onto it, so the real handler is what's under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.resolve(__dirname, '..', 'web', 'public', 'sw.js');

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

test('notificationclick (web/public/sw.js): openWindow URLs are relative, so they resolve under the base path', async () => {
  const { handlers, opened } = await loadFakeSw({ clients: [] });
  await fireClick(handlers, { instanceId: 'inst-1', sessionId: 'sess-1' });
  await fireClick(handlers, { project: 'p' });
  assert.deepEqual(opened, ['./#session=sess-1', './']);
});
