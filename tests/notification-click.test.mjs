// Tests for wsRouter.js's notification-click resolution wiring: a
// `cc-notification-click` event (dispatched either by sw.js's postMessage
// listener or by notifications.js's page-level Notification onclick, both
// funneling through the same `window` custom event in this harness since
// happy-dom doesn't implement navigator.serviceWorker) must select the live
// instance the notification was about, or auto-resume it from disk if it's
// no longer live. Mirrors the harness established in
// tests/anchor-autoresume.test.mjs (happy-dom + injected fakes on the real
// `bus` from ws.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { bus } from '../public/ws.js';
import { readSessionAnchor } from '../public/anchor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

async function waitFor(cond, ms = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

function installDom(hash = '') {
  const window = new Window({ url: `http://localhost/${hash}` });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.URLSearchParams = window.URLSearchParams;
  globalThis.localStorage = window.localStorage;
  globalThis.CustomEvent = window.CustomEvent;
  return window;
}

function baseDeps({ instances = [], resumeSpy, selectSpy } = {}) {
  const noop = () => {};
  const state = { activeId: null, instances };
  return {
    state,
    getTracker: () => ({ reset: noop, seedActive: noop, apply: noop, completedBatches: [] }),
    getUsage: () => ({ reset: noop, apply: noop }),
    globalRLTracker: { apply: noop },
    conversation: { clear: noop, apply: noop },
    headerHandle: { update: noop },
    lazyController: { init: noop },
    sessionActions: { resumeSession: resumeSpy ?? (async () => {}) },
    composer: {}, sidebar: {}, subagentPanel: {},
    bumpUnread: noop,
    refreshProjects: async () => {}, refreshInstances: async () => {},
    // Mirrors the real selectInstance (app.js): sets state.activeId, same as
    // tests/anchor-autoresume.test.mjs's baseDeps — a spy that only records
    // the call without this masks the double-subscribe class of regression
    // (irrelevant to this file's own assertions, but keeping the two
    // baseDeps helpers consistent avoids re-introducing that gap here too).
    selectInstance: (id, opts) => { state.activeId = id; selectSpy?.(id, opts); },
    setSidebarStatus: noop,
  };
}

function dispatchClick(detail) {
  window.dispatchEvent(new window.CustomEvent('cc-notification-click', { detail }));
}

test('notification click selects the live instance matching instanceId', async () => {
  installDom();
  const { installWsRouter } = await load('wsRouter.js');
  const instances = [{ id: 'inst-1', sessionId: 'sess-1' }, { id: 'inst-2', sessionId: 'sess-2' }];
  let selected = null;
  installWsRouter(baseDeps({ instances, selectSpy: (id, opts) => { selected = { id, opts }; } }));

  dispatchClick({ instanceId: 'inst-2', sessionId: 'sess-2' });
  await waitFor(() => selected !== null);
  assert.equal(selected.id, 'inst-2');
  // Same (default, replaceState) history behavior as every other
  // anchor-driven selectInstance call in wsRouter.js (popstate,
  // first-connect) — a notification click is treated as a page-load-style
  // restore, not a forward navigation that should leave a back-button entry.
  assert.equal(selected.opts, undefined, 'notification-driven selection does not push a history entry');
});

test('notification click falls back to sessionId when instanceId is no longer live (respawn)', async () => {
  installDom();
  const { installWsRouter } = await load('wsRouter.js');
  const instances = [{ id: 'inst-2-new', sessionId: 'sess-2' }];
  let selected = null;
  installWsRouter(baseDeps({ instances, selectSpy: (id) => { selected = id; } }));

  dispatchClick({ instanceId: 'inst-2-old', sessionId: 'sess-2' });
  await waitFor(() => selected !== null);
  assert.equal(selected, 'inst-2-new');
});

test('notification click with neither id live locates + auto-resumes the session', async () => {
  installDom();
  const { installWsRouter } = await load('wsRouter.js');

  let resumeArgs = null;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/locate')) {
      return { ok: true, json: async () => ({ project: 'p', worktreeName: 'wt', archived: false }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  installWsRouter(baseDeps({ instances: [], resumeSpy: async (args) => { resumeArgs = args; } }));

  dispatchClick({ instanceId: 'gone', sessionId: 'sess-3' });
  await waitFor(() => resumeArgs !== null);
  assert.equal(resumeArgs.sessionId, 'sess-3');
  assert.equal(resumeArgs.projectName, 'p');
  assert.equal(resumeArgs.silent, true);
});

test('notification click with no sessionId and no live match is a graceful no-op', async () => {
  installDom();
  const { installWsRouter } = await load('wsRouter.js');
  let selected = null;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: false }; };
  installWsRouter(baseDeps({ instances: [], selectSpy: (id) => { selected = id; } }));

  dispatchClick({ instanceId: 'gone' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(selected, null);
  assert.equal(fetched, false, 'no sessionId means nothing to locate');
});

// ── anchor-clobber regression ───────────────────────────────────────────────
//
// Scenario: the user is actively viewing #session=sess-X (a temp session
// pinged, then got archived on a restart while the user moved on); they
// later click the old, now-stale notification for sess-Y. resumeSessionByAnchor
// resolves sess-Y (archived → miss) and must NOT clear the CURRENT anchor —
// sess-Y is not what the hash currently points to, so wiping it would strand
// the user's real session on their next refresh, landing them on the empty
// placeholder instead of back on X. clearAnchorOnMiss:false is what the
// notification-click caller passes specifically to prevent this.

test('notification click for an unrelated archived sessionId does not clobber the current #session= anchor', async () => {
  installDom('#session=sess-X');
  const { installWsRouter } = await load('wsRouter.js');

  globalThis.fetch = async (url) => {
    if (String(url).includes('/locate')) {
      return { ok: true, json: async () => ({ project: 'p', worktreeName: null, archived: true }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  installWsRouter(baseDeps({ instances: [] }));

  dispatchClick({ instanceId: 'inst-gone', sessionId: 'sess-Y' });
  await new Promise(r => setTimeout(r, 20));

  assert.equal(readSessionAnchor(), 'sess-X', 'the current, unrelated anchor must survive an archived notification click');
});

test('notification click for an unrelated 404 sessionId does not clobber the current #session= anchor', async () => {
  installDom('#session=sess-X');
  const { installWsRouter } = await load('wsRouter.js');
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  installWsRouter(baseDeps({ instances: [] }));

  dispatchClick({ instanceId: 'inst-gone', sessionId: 'sess-Y' });
  await new Promise(r => setTimeout(r, 20));

  assert.equal(readSessionAnchor(), 'sess-X', 'a 404 miss on an unrelated notification must not clear the current anchor');
});
