// Characterization pin for public/unread.js — the per-sessionId unread-count
// store and its localStorage persistence.
//
// Written BEFORE the extraction lands (expand-then-contract): at this commit
// public/unread.js is an unreferenced verbatim copy of the block still live in
// public/app.js, so these assertions describe the CURRENT shipped behaviour.
// The follow-up commit deletes app.js's copy and wires this module; the
// reviewer's check is that `git diff <pin> <wire> -- public/unread.js` is empty.
//
// Invariants pinned here (each one is what a mutation would break):
//   - load filters to Number.isInteger(v) && v > 0
//   - a malformed / non-object / unreadable payload yields an empty Map, no throw
//   - bump increments from absent via `?? 0`
//   - clear on an absent key is a total no-op (no save, no onChange)
//   - saving an EMPTY map calls removeItem, never setItem('{}')
//   - a setItem throw is swallowed
//   - `counts` is the same live Map instance across bump/clear
//   - onChange fires AFTER the save

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNREAD_JS = pathToFileURL(
  path.resolve(__dirname, '..', 'public', 'unread.js'),
).href;

const KEY = 'code-conductor:unread';

// Same shape as installFakeLocalStorage in tests/notifications.test.mjs: the
// backing Map is returned so assertions can read the SERIALIZED value, not the
// store's in-memory Map. `throwOn` lets a test force the private-mode/quota path.
function installFakeLocalStorage(seed = {}, { throwOn = null } = {}) {
  const map = new Map(Object.entries(seed));
  const calls = [];
  globalThis.localStorage = {
    getItem: (k) => {
      calls.push(['getItem', k]);
      if (throwOn === 'getItem') throw new Error('denied');
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      calls.push(['setItem', k, String(v)]);
      if (throwOn === 'setItem') throw new Error('quota');
      map.set(k, String(v));
    },
    removeItem: (k) => {
      calls.push(['removeItem', k]);
      if (throwOn === 'removeItem') throw new Error('denied');
      map.delete(k);
    },
  };
  return { map, calls };
}

async function loadStore(seedRaw, opts) {
  const fake = installFakeLocalStorage(seedRaw == null ? {} : { [KEY]: seedRaw }, opts);
  const { createUnreadStore } = await import(UNREAD_JS);
  const changes = [];
  const store = createUnreadStore({ onChange: (m) => changes.push(new Map(m)) });
  return { ...fake, store, changes };
}

test('load: restores positive integer counts from localStorage', async () => {
  const { store } = await loadStore(JSON.stringify({ a: 3, b: 1 }));
  assert.deepEqual([...store.counts.entries()], [['a', 3], ['b', 1]]);
});

test('load: drops zero, negative, non-integer and NaN entries', async () => {
  const raw = '{"ok":2,"zero":0,"neg":-1,"frac":1.5,"nan":null,"str":"4"}';
  const { store } = await loadStore(raw);
  assert.deepEqual([...store.counts.keys()], ['ok'],
    'only the positive-integer entry survives the Number.isInteger(v) && v > 0 filter');
  assert.equal(store.counts.get('ok'), 2);
});

test('load: malformed JSON yields an empty Map without throwing', async () => {
  const { store } = await loadStore('{not json');
  assert.equal(store.counts.size, 0);
});

test('load: a non-object JSON payload yields an empty Map', async () => {
  for (const raw of ['null', '42', '"str"']) {
    const { store } = await loadStore(raw);
    assert.equal(store.counts.size, 0, `payload ${raw} must yield an empty Map`);
  }
});

test('load: a getItem throw yields an empty Map', async () => {
  const { store } = await loadStore(JSON.stringify({ a: 1 }), { throwOn: 'getItem' });
  assert.equal(store.counts.size, 0);
});

test('load: an absent key yields an empty Map', async () => {
  const { store } = await loadStore(null);
  assert.equal(store.counts.size, 0);
});

test('bump: increments from absent via ?? 0, then from the stored value', async () => {
  const { store, map, changes } = await loadStore(null);
  store.bump('s1');
  assert.equal(store.counts.get('s1'), 1, 'absent → 1, not NaN');
  store.bump('s1');
  assert.equal(store.counts.get('s1'), 2);
  assert.equal(map.get(KEY), JSON.stringify({ s1: 2 }), 'serialized after each bump');
  assert.equal(changes.length, 2, 'onChange fires once per bump');
});

test('bump: a falsy sessionId is ignored entirely', async () => {
  const { store, calls, changes } = await loadStore(null);
  const before = calls.length;
  store.bump(undefined);
  store.bump(null);
  store.bump('');
  assert.equal(store.counts.size, 0);
  assert.equal(calls.length, before, 'no storage writes');
  assert.equal(changes.length, 0, 'no onChange');
});

test('clear: on an absent key is a total no-op — no save, no onChange', async () => {
  const { store, calls, changes } = await loadStore(JSON.stringify({ a: 1 }));
  const before = calls.length;
  store.clear('never-seen');
  assert.equal(calls.length, before,
    'Map.delete returning false must short-circuit before saveUnreadToStorage');
  assert.equal(changes.length, 0, 'and before onChange');
  assert.equal(store.counts.get('a'), 1, 'unrelated entries untouched');
});

test('clear: a falsy sessionId is ignored entirely', async () => {
  const { store, calls, changes } = await loadStore(JSON.stringify({ a: 1 }));
  const before = calls.length;
  store.clear(null);
  assert.equal(calls.length, before);
  assert.equal(changes.length, 0);
});

test('save: emptying the map calls removeItem, never setItem("{}")', async () => {
  const { store, map, calls } = await loadStore(JSON.stringify({ a: 1 }));
  store.clear('a');
  assert.equal(store.counts.size, 0);
  assert.equal(map.has(KEY), false, 'the key is gone, not left holding "{}"');
  const writes = calls.filter(c => c[0] === 'setItem' || c[0] === 'removeItem');
  assert.deepEqual(writes.at(-1), ['removeItem', KEY],
    'the size===0 branch must removeItem, not serialize an empty object');
  assert.ok(!writes.some(c => c[0] === 'setItem' && c[2] === '{}'),
    'setItem("{}") must never be written');
});

test('save: clearing one of two sessions still writes the survivor', async () => {
  const { store, map } = await loadStore(JSON.stringify({ a: 1, b: 2 }));
  store.clear('a');
  assert.equal(map.get(KEY), JSON.stringify({ b: 2 }));
});

test('save: a setItem throw is swallowed and leaves the in-memory count', async () => {
  const { store } = await loadStore(null, { throwOn: 'setItem' });
  assert.doesNotThrow(() => store.bump('s1'));
  assert.equal(store.counts.get('s1'), 1, 'in-memory state survives a failed persist');
});

test('counts is the same live Map instance across bump and clear', async () => {
  const { store } = await loadStore(null);
  const ref = store.counts;
  store.bump('s1');
  store.clear('s1');
  store.bump('s2');
  assert.equal(store.counts, ref, 'identity must be preserved — the sidebar holds this Map');
  assert.equal(ref.get('s2'), 1, 'and the held reference sees the mutations');
});

test('onChange fires AFTER the save, with the live counts Map', async () => {
  const fake = installFakeLocalStorage();
  const { createUnreadStore } = await import(UNREAD_JS);
  const seenAtCallback = [];
  let sawMap = null;
  const store = createUnreadStore({
    onChange: (m) => {
      sawMap = m;
      seenAtCallback.push(fake.map.get(KEY) ?? null);
    },
  });
  store.bump('s1');
  assert.deepEqual(seenAtCallback, [JSON.stringify({ s1: 1 })],
    'localStorage was already written by the time onChange ran');
  assert.equal(sawMap, store.counts, 'onChange receives the live Map, not a copy');
});

test('onChange fires AFTER the save on the CLEAR path too, including the removeItem branch', async () => {
  // Same shape as the bump-path timing test above, for the other mutation path.
  // The clear path is the one that can empty the map, and emptiness is what
  // selects removeItem over setItem — so a consumer that reads persisted state
  // from inside onChange must not see the key still present.
  const fake = installFakeLocalStorage({ [KEY]: JSON.stringify({ a: 1, b: 2 }) });
  const { createUnreadStore } = await import(UNREAD_JS);
  const seenAtCallback = [];
  const store = createUnreadStore({
    onChange: () => { seenAtCallback.push(fake.map.has(KEY) ? fake.map.get(KEY) : null); },
  });

  store.clear('a');
  assert.deepEqual(seenAtCallback, [JSON.stringify({ b: 2 })],
    'clearing one of two: the survivor was already serialized when onChange ran');

  store.clear('b');
  assert.deepEqual(seenAtCallback, [JSON.stringify({ b: 2 }), null],
    'clearing the LAST entry: removeItem had already run when onChange ran — '
    + 'the key must be gone, not still holding the pre-save value');
});
