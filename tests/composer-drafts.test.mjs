// Per-session composer drafts: the real attachComposer wired to the real
// createDraftStore / installComposerDrafts (public/drafts.js) in happy-dom,
// over a Map-backed fake localStorage, fake timers and a fake clock.
//
// Invariants pinned (one per test title below):
//   - a draft is per sessionId and restores byte-exact, and the Send button follows it
//   - switching to the session already showing is a no-op (resume / respawn)
//   - saves are debounced; switch-away / pagehide / tab-hidden save immediately
//   - a reload (new page over the same storage) restores the draft and its <transcribed> flag
//   - sending clears the stored draft at once and cancels a pending save
//   - prefill (fork / rewind) becomes the session's draft
//   - restoring never writes back and never focuses
//   - text the browser restores before the first switch is not saved under any session
//   - prune drops expired and malformed draft keys and nothing else
//   - a missing / throwing storage degrades to in-memory per-session drafts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const { createDraftStore, installComposerDrafts, DRAFT_KEY_PREFIX, DRAFT_MAX_AGE_MS } =
  await import(pathToFileURL(path.join(PUB, 'drafts.js')).href);

const keyOf = (sid) => DRAFT_KEY_PREFIX + sid;
const NOW = 1_700_000_000_000;

// Map-backed Storage with length/key(i). `throwOn` forces the quota /
// private-mode path for one method.
function fakeStorage(seed = {}, { throwOn = null } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (throwOn === 'setItem') throw new Error('quota'); map.set(k, String(v)); },
    removeItem: (k) => { if (throwOn === 'removeItem') throw new Error('denied'); map.delete(k); },
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    get count() { return pending.size; },
    fireAll() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
  };
}

// A fresh page: new DOM + composer + drafts wiring over the given store.
async function setupPage({ store, timers = fakeTimers() }) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Blob = window.Blob;
  const document = window.document;

  document.body.innerHTML = `
    <form id="composer">
      <div id="composer-attachments" hidden></div>
      <div class="composer-row">
        <textarea id="composer-input"></textarea>
        <input id="composer-file" type="file" hidden />
        <button id="composer-attach" type="button"></button>
        <button id="composer-send" type="button" disabled>
          <span class="cs-label">Send</span>
          <svg class="cs-mic"></svg>
        </button>
      </div>
    </form>`;
  const form = document.getElementById('composer');
  const textarea = document.getElementById('composer-input');
  const sendBtn = document.getElementById('composer-send');
  form.requestSubmit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const url = pathToFileURL(path.join(PUB, 'composer.js')).href + `?t=${Math.floor(performance.now() * 1000)}-${Math.random()}`;
  const { attachComposer } = await import(url);
  const submits = [];
  let drafts = null;
  const composer = attachComposer({
    form,
    textarea,
    sendBtn,
    attachBtn: document.getElementById('composer-attach'),
    fileInput: document.getElementById('composer-file'),
    chipsContainer: document.getElementById('composer-attachments'),
    onSubmit: (p) => submits.push(p),
    onDraftChange: (d) => drafts.noteChange(d),
  });
  composer.set({ canType: true, canSend: true });

  // A plain EventTarget doc so a test controls `hidden`.
  const doc = Object.assign(new EventTarget(), { hidden: false });
  drafts = installComposerDrafts({ composer, store, timers, win: window, doc });

  const type = (v) => { textarea.value = v; textarea.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = () => form.requestSubmit();
  return { window, doc, textarea, sendBtn, composer, drafts, timers, submits, type, submit };
}

const newStore = (storage, now = () => NOW) => createDraftStore({ storage, now });
const stored = (storage, sid) => JSON.parse(storage.map.get(keyOf(sid)));

test('a draft is per session and restores byte-exact, and the Send button follows it', async () => {
  const storage = fakeStorage();
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('A');
  p.type('half typed\n  ');
  p.drafts.switchTo('B');
  assert.equal(p.textarea.value, '');
  assert.ok(!p.sendBtn.classList.contains('mode-send'), 'empty box is not in send mode');
  p.type('other');
  p.drafts.switchTo('A');
  assert.equal(p.textarea.value, 'half typed\n  ');
  assert.ok(p.sendBtn.classList.contains('mode-send'));
  p.drafts.switchTo('B');
  assert.equal(p.textarea.value, 'other');
});

test('switching to the session already showing leaves the text alone', async () => {
  const p = await setupPage({ store: newStore(fakeStorage()) });
  p.drafts.switchTo('A');
  p.type('keep me');
  p.drafts.switchTo('A');
  assert.equal(p.textarea.value, 'keep me');
});

test('switching to no session saves the outgoing draft and empties the box', async () => {
  const storage = fakeStorage();
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('A');
  p.type('bye');
  p.drafts.switchTo(null);
  assert.equal(p.textarea.value, '');
  assert.equal(stored(storage, 'A').text, 'bye');
});

test('saves are debounced; switching away saves without waiting for the timer', async (t) => {
  await t.test('nothing is stored until the debounce fires', async () => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage) });
    p.drafts.switchTo('A');
    p.type('abc');
    assert.equal(storage.map.has(keyOf('A')), false);
    p.timers.fireAll();
    assert.deepEqual(stored(storage, 'A'), { text: 'abc', transcribed: false, savedAt: NOW });
  });
  await t.test('further typing reschedules rather than stacking timers', async () => {
    const p = await setupPage({ store: newStore(fakeStorage()) });
    p.drafts.switchTo('A');
    p.type('a');
    p.type('ab');
    assert.equal(p.timers.count, 1);
  });
  await t.test('switch-away writes immediately and leaves no timer behind', async () => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage) });
    p.drafts.switchTo('A');
    p.type('abc');
    p.drafts.switchTo('B');
    assert.equal(stored(storage, 'A').text, 'abc');
    assert.equal(p.timers.count, 0);
  });
});

test('pagehide and a tab going hidden flush the pending text; a tab becoming visible does not', async (t) => {
  await t.test('pagehide', async () => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage) });
    p.drafts.switchTo('A');
    p.type('pending');
    p.window.dispatchEvent(new p.window.Event('pagehide'));
    assert.equal(stored(storage, 'A').text, 'pending');
  });
  await t.test('visibilitychange with hidden = true', async () => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage) });
    p.drafts.switchTo('A');
    p.type('pending');
    p.doc.hidden = true;
    p.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(stored(storage, 'A').text, 'pending');
  });
  await t.test('visibilitychange with hidden = false', async () => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage) });
    p.drafts.switchTo('A');
    p.type('pending');
    p.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(storage.map.has(keyOf('A')), false);
  });
});

test('a reload restores the stored draft, and its transcribed flag reaches the sent text', async () => {
  const storage = fakeStorage({
    [keyOf('A')]: JSON.stringify({ text: 'dictated words', transcribed: true, savedAt: NOW }),
  });
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('A');
  assert.equal(p.textarea.value, 'dictated words');
  p.submit();
  assert.equal(p.submits.length, 1);
  assert.equal(p.submits[0].text, '<transcribed>\ndictated words');
});

test('the transcribed flag belongs to its own session\'s draft', async () => {
  const storage = fakeStorage({
    [keyOf('A')]: JSON.stringify({ text: 'spoken', transcribed: true, savedAt: NOW }),
  });
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('A');
  p.drafts.switchTo('B');
  p.type('typed');
  p.submit();
  assert.equal(p.submits[0].text, 'typed', 'B must not inherit A\'s flag');
  p.drafts.switchTo('A');
  p.submit();
  assert.equal(p.submits[1].text, '<transcribed>\nspoken');
});

test('sending clears the stored draft at once, and a pending save cannot bring it back', async () => {
  const storage = fakeStorage();
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('A');
  p.type('ship it');
  p.drafts.flush();
  assert.equal(stored(storage, 'A').text, 'ship it');
  p.type('ship it!');
  assert.equal(p.timers.count, 1, 'an edit after the flush leaves a save pending');
  p.submit();
  assert.deepEqual(p.submits.map((s) => s.text), ['ship it!']);
  assert.equal(storage.map.has(keyOf('A')), false);
  p.timers.fireAll();
  assert.equal(storage.map.has(keyOf('A')), false);
  p.drafts.switchTo('B');
  p.drafts.switchTo('A');
  assert.equal(p.textarea.value, '');
});

test('prefill (fork / rewind) becomes the session\'s draft', async () => {
  const storage = fakeStorage();
  const p = await setupPage({ store: newStore(storage) });
  p.drafts.switchTo('B');
  p.composer.prefill('dropped prompt');
  p.timers.fireAll();
  assert.equal(stored(storage, 'B').text, 'dropped prompt');
});

test('restoring a draft neither writes back nor takes focus', async () => {
  const storage = fakeStorage({
    [keyOf('A')]: JSON.stringify({ text: 'stored', transcribed: false, savedAt: NOW }),
  });
  const p = await setupPage({ store: newStore(storage) });
  const before = JSON.stringify([...storage.map]);
  p.drafts.switchTo('A');
  assert.equal(p.textarea.value, 'stored');
  assert.equal(p.timers.count, 0);
  assert.equal(JSON.stringify([...storage.map]), before);
  assert.notEqual(p.window.document.activeElement, p.textarea);
});

test('text present before the first switch is not saved under any session', async () => {
  const storage = fakeStorage();
  const p = await setupPage({ store: newStore(storage) });
  p.type('browser form-restore');
  assert.equal(p.timers.count, 0);
  p.window.dispatchEvent(new p.window.Event('pagehide'));
  assert.equal(storage.map.size, 0);
});

test('prune drops expired and malformed draft keys and nothing else', async (t) => {
  const rec = (savedAt) => JSON.stringify({ text: 't', transcribed: false, savedAt });
  const seed = () => ({
    [keyOf('old')]: rec(NOW - DRAFT_MAX_AGE_MS - 1),
    [keyOf('edge')]: rec(NOW - DRAFT_MAX_AGE_MS),
    [keyOf('fresh')]: rec(NOW - 1000),
    [keyOf('bad')]: 'not json',
    [keyOf('notext')]: JSON.stringify({ savedAt: NOW }),
    'code-conductor:unread': '{"s":1}',
  });
  const run = () => {
    const storage = fakeStorage(seed());
    newStore(storage).prune();
    return storage;
  };
  await t.test('older than the cap is removed', () => assert.equal(run().map.has(keyOf('old')), false));
  await t.test('exactly at the cap is kept', () => assert.equal(run().map.has(keyOf('edge')), true));
  await t.test('a fresh draft is kept', () => assert.equal(run().map.has(keyOf('fresh')), true));
  await t.test('unparseable JSON is removed', () => assert.equal(run().map.has(keyOf('bad')), false));
  await t.test('a record without string text is removed', () => assert.equal(run().map.has(keyOf('notext')), false));
  await t.test('a key outside the draft prefix is untouched', () =>
    assert.equal(run().map.get('code-conductor:unread'), '{"s":1}'));
  await t.test('installing the drafts module prunes once', async () => {
    const storage = fakeStorage(seed());
    await setupPage({ store: newStore(storage) });
    assert.equal(storage.map.has(keyOf('old')), false);
  });
});

test('with a throwing or missing storage, drafts stay per session in memory', async (t) => {
  const roundTrip = async (store) => {
    const p = await setupPage({ store });
    p.drafts.switchTo('A');
    p.type('in memory');
    p.drafts.switchTo('B');
    assert.equal(p.textarea.value, '');
    p.drafts.switchTo('A');
    assert.equal(p.textarea.value, 'in memory');
    p.submit();
    p.drafts.switchTo('B');
    p.drafts.switchTo('A');
    assert.equal(p.textarea.value, '', 'a cleared draft does not come back');
  };
  await t.test('setItem throws', () => roundTrip(newStore(fakeStorage({}, { throwOn: 'setItem' }))));
  await t.test('removeItem throws', () => roundTrip(newStore(fakeStorage({}, { throwOn: 'removeItem' }))));
  await t.test('no storage at all', () => roundTrip(createDraftStore({ storage: null, now: () => NOW })));
});
