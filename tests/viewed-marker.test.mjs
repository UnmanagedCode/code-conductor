// public/viewedMarker.js: when the browser tells the server the human saw a
// session's latest turn end (POST /api/sessions/:sid/viewed). Driven against a
// happy-dom window for the hash and a fake document for visibility, with an
// injected fetchJson recording every POST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let counter = 0;
const pub = (f) => pathToFileURL(path.resolve(__dirname, '..', 'public', f)).href;

async function setup({ hash = '#session=s1', visible = true, instances, activeId = 'i1', storage, fetchJson } = {}) {
  const window = new Window({ url: `http://localhost/${hash}` });
  globalThis.window = window;
  const { registerMainView } = await import(pub('mainViews.js'));
  registerMainView({ matches: (h) => h === '#settings', isOpen: () => false, supersede: () => {} });
  const { installViewedMarker } = await import(`${pub('viewedMarker.js')}?t=${++counter}`);
  const doc = new EventTarget();
  doc.visibilityState = visible ? 'visible' : 'hidden';
  const state = { activeId, instances: instances ?? [{ id: 'i1', sessionId: 's1', turnEndSeq: 2, viewedSeq: 1 }] };
  const posts = [];
  const marker = installViewedMarker({
    getActiveInstance: () => state.instances.find(i => i.id === state.activeId) ?? null,
    fetchJson: fetchJson ?? (async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body), method: opts.method }); return {}; }),
    doc,
    win: window,
    storage: storage ?? { removeItem() {} },
  });
  return { window, doc, state, posts, marker };
}

// Invariant: an open, visible pane with an unseen turn end posts that seq once.
test('a visible active session with an unseen turn end posts its turnEndSeq', async () => {
  const { posts, marker } = await setup();
  marker.check();
  assert.deepEqual(posts, [{ url: '/api/sessions/s1/viewed', method: 'POST', body: { seq: 2 } }]);
});

// Invariant: a hidden document never counts as viewed; becoming visible does.
test('a hidden document posts nothing until it becomes visible', async () => {
  const { doc, posts, marker } = await setup({ visible: false });
  marker.check();
  assert.equal(posts.length, 0, 'hidden: no POST');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(posts.map(p => p.body), [{ seq: 2 }], 'visibilitychange to visible posts');
});

// Invariant: a full-page main view covering the pane is not viewing it;
// a view closing back to the session (mainViewClosed, after a replaceState
// anchor restore that fires no hashchange) re-runs the check and posts.
test('a full-page view hash posts nothing until a view closes back to the session', async () => {
  const { window, posts, marker } = await setup({ hash: '#settings' });
  const { mainViewClosed } = await import(pub('mainViews.js'));
  marker.check();
  assert.equal(posts.length, 0, '#settings: no POST');
  window.history.replaceState(null, '', '#session=s1');
  mainViewClosed();
  assert.deepEqual(posts.map(p => p.body), [{ seq: 2 }], 'the view closing posts');
});

// Invariant: a turn that ends while the pane is open and visible is posted on
// the next check (the post-refresh one), not left unread.
test('a higher turnEndSeq arriving on a refresh posts immediately', async () => {
  const { state, posts, marker } = await setup();
  marker.check();
  state.instances = [{ id: 'i1', sessionId: 's1', turnEndSeq: 3, viewedSeq: 2 }];
  marker.check();
  assert.deepEqual(posts.map(p => p.body), [{ seq: 2 }, { seq: 3 }]);
});

// Invariant: repeated checks at one seq post once (also while it is in flight).
test('repeat checks at the same seq post once', async () => {
  const { posts, marker } = await setup();
  marker.check();
  marker.check();
  await new Promise(r => setTimeout(r, 0));
  marker.check();
  assert.equal(posts.length, 1);
});

// Invariant: a failed POST is logged and retried by the next check.
test('a rejected POST is retried on the next check', async () => {
  let calls = 0;
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const { marker } = await setup({ fetchJson: async () => { calls++; if (calls === 1) throw new Error('boom'); return {}; } });
    marker.check();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(warns.some(w => w.includes('boom')), `the failure is logged: ${JSON.stringify(warns)}`);
    marker.check();
    assert.equal(calls, 2, 'the next check posts again');
  } finally {
    console.warn = orig;
  }
});

// Invariant: only the active session is marked, and a read one is not posted.
test('an unread session that is not active is never posted', async () => {
  const { posts, marker } = await setup({ instances: [
    { id: 'i1', sessionId: 's1', turnEndSeq: 2, viewedSeq: 2 },
    { id: 'i2', sessionId: 's2', turnEndSeq: 5, viewedSeq: 0 },
  ] });
  marker.check();
  assert.equal(posts.length, 0);
});

// Invariant: an active instance with no sessionId yet posts nothing.
test('an active instance with no sessionId posts nothing', async () => {
  const { posts, marker } = await setup({ instances: [{ id: 'i1', sessionId: null, turnEndSeq: 2, viewedSeq: 0 }] });
  marker.check();
  assert.equal(posts.length, 0);
});

// Invariant: install drops the retired localStorage unread key, and a storage
// that throws does not break install.
test('install removes the legacy unread key and survives a throwing storage', async () => {
  const removed = [];
  await setup({ storage: { removeItem: (k) => removed.push(k) } });
  assert.deepEqual(removed, ['code-conductor:unread']);
  const { marker } = await setup({ storage: { removeItem: () => { throw new Error('denied'); } } });
  assert.equal(typeof marker.check, 'function', 'install completed');
});
