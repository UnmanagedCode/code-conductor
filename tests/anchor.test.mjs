// Tests for the URL-hash session anchor — the mechanism that survives a
// page refresh by carrying `#session=<sid>` in the URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setup(initialHref = 'http://localhost/') {
  const window = new Window({ url: initialHref });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.URLSearchParams = window.URLSearchParams;
  // Cache-bust the module import so each test gets a fresh evaluation
  // against the current globals (happy-dom's location is per-Window).
  const url = pathToFileURL(path.join(PUB, 'anchor.js')).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return { window, ...mod };
}

test('readSessionAnchor returns null when no hash is set', async () => {
  const { readSessionAnchor } = await setup('http://localhost/');
  assert.equal(readSessionAnchor(), null);
});

test('readSessionAnchor parses #session=<sid>', async () => {
  const { readSessionAnchor } = await setup('http://localhost/#session=abc-123');
  assert.equal(readSessionAnchor(), 'abc-123');
});

test('readSessionAnchor extracts session from a multi-key hash', async () => {
  const { readSessionAnchor } = await setup('http://localhost/#foo=bar&session=xyz&baz=q');
  assert.equal(readSessionAnchor(), 'xyz');
});

test('readSessionAnchor returns null when hash has no session key', async () => {
  const { readSessionAnchor } = await setup('http://localhost/#some-other-anchor');
  assert.equal(readSessionAnchor(), null);
});

test('writeSessionAnchor sets the hash via replaceState', async () => {
  const { window, writeSessionAnchor } = await setup('http://localhost/app');
  writeSessionAnchor('session-id-9');
  assert.equal(window.location.hash, '#session=session-id-9');
  // Path is preserved.
  assert.equal(window.location.pathname, '/app');
});

test('writeSessionAnchor clears the hash when passed null', async () => {
  const { window, writeSessionAnchor } = await setup('http://localhost/app#session=zzz');
  assert.equal(window.location.hash, '#session=zzz');
  writeSessionAnchor(null);
  assert.equal(window.location.hash, '');
});

test('writeSessionAnchor is a no-op when clearing an already-empty hash', async () => {
  // Smoke check that clearing twice doesn't throw or pollute history.
  const { window, writeSessionAnchor } = await setup('http://localhost/');
  writeSessionAnchor(null);
  writeSessionAnchor(null);
  assert.equal(window.location.hash, '');
});

test('round-trip: write then read returns the same session id', async () => {
  const { writeSessionAnchor, readSessionAnchor } = await setup('http://localhost/');
  writeSessionAnchor('uuid-round-trip');
  assert.equal(readSessionAnchor(), 'uuid-round-trip');
});

test('writeSessionAnchor URL-encodes session ids with special characters', async () => {
  const { window, writeSessionAnchor, readSessionAnchor } = await setup('http://localhost/');
  writeSessionAnchor('a b/c?d');
  // The raw hash should be encoded.
  assert.ok(window.location.hash.includes('a%20b%2Fc%3Fd'));
  // ...but URLSearchParams decodes back to the original on read.
  assert.equal(readSessionAnchor(), 'a b/c?d');
});

function memStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _dump() { return Object.fromEntries(m); },
  };
}

test('stashCurrentAnchorForRelaunch persists the current anchor to storage', async () => {
  const { stashCurrentAnchorForRelaunch } = await setup('http://localhost/#session=abc-1');
  const storage = memStorage();
  stashCurrentAnchorForRelaunch(storage);
  assert.equal(storage.getItem('cc:session-stash'), 'abc-1');
});

test('stashCurrentAnchorForRelaunch clears the stash when there is no current anchor', async () => {
  const { stashCurrentAnchorForRelaunch } = await setup('http://localhost/');
  const storage = memStorage();
  storage.setItem('cc:session-stash', 'leftover');
  stashCurrentAnchorForRelaunch(storage);
  assert.equal(storage.getItem('cc:session-stash'), null);
});

test('consumeStashedAnchor returns and clears the stash (one-shot)', async () => {
  const { consumeStashedAnchor } = await setup('http://localhost/');
  const storage = memStorage();
  storage.setItem('cc:session-stash', 'sess-9');
  assert.equal(consumeStashedAnchor(storage), 'sess-9');
  assert.equal(storage.getItem('cc:session-stash'), null);
  // Second consume is empty — no silent resurrection on future relaunches.
  assert.equal(consumeStashedAnchor(storage), null);
});

test('consumeStashedAnchor returns null when nothing is stashed', async () => {
  const { consumeStashedAnchor } = await setup('http://localhost/');
  assert.equal(consumeStashedAnchor(memStorage()), null);
});

test('stash + consume round-trip preserves session ids with special characters', async () => {
  const { stashCurrentAnchorForRelaunch, consumeStashedAnchor } =
    await setup('http://localhost/#session=' + encodeURIComponent('a b/c?d'));
  const storage = memStorage();
  stashCurrentAnchorForRelaunch(storage);
  assert.equal(consumeStashedAnchor(storage), 'a b/c?d');
});
