// Client-side tests for the first-connect anchor auto-resume:
//   (1) resumeSession({silent}) degrades gracefully on a duplicate-resume 409
//       (the manifest restore / stop+resume race) instead of alerting; and
//   (2) wsRouter's firstConnect skips + clears the anchor for an ARCHIVED
//       session (so a temp session cleaned up on a plain restart is not
//       silently resurrected), and otherwise resumes with silent:true.
//
// sessionActions.js and wsRouter.js/ws.js have no import-time browser deps
// (ws.js does not auto-connect), so they load cleanly here. Each test builds
// its own injected fakes; the shared ws.js `bus` is harmless because every
// installWsRouter closes over its own state/fakes and stale installs skip the
// auto-resume block (their firstConnect is already spent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
// Canonical ws.js so our `bus` is the SAME EventTarget wsRouter listens on
// (wsRouter imports './ws.js' without a cache-bust query).
import { bus } from '../public/ws.js';

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

// ── resumeSession({silent}) unit tests ──────────────────────────────────────

test('resumeSession({silent}) on a 409 selects the instance already owning the session (no alert)', async () => {
  const { installSessionActions } = await load('sessionActions.js');
  const sid = 'sid-abc';
  let alerted = false, selected = null, refreshed = 0;
  globalThis.alert = () => { alerted = true; };
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'already attached to a running instance' }) });
  const instances = [{ id: 'inst-1', sessionId: sid }];
  const { resumeSession } = installSessionActions({
    getActiveId: () => null, setActiveId: () => {}, getInstances: () => instances,
    refreshProjects: async () => {}, refreshInstances: async () => { refreshed++; },
    selectInstance: (id) => { selected = id; }, sidebar: {}, clearUnread: () => {},
  });
  await resumeSession({ projectName: 'p', worktreeName: null, sessionId: sid, silent: true });
  assert.equal(alerted, false, 'no alert on a silent conflict');
  assert.equal(refreshed, 1, 're-synced instances to observe the winner');
  assert.equal(selected, 'inst-1', 'selected the instance that already owns the session');
});

test('resumeSession (non-silent) still alerts on failure', async () => {
  const { installSessionActions } = await load('sessionActions.js');
  let alerted = null;
  globalThis.alert = (m) => { alerted = m; };
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'boom' }) });
  const { resumeSession } = installSessionActions({
    getActiveId: () => null, setActiveId: () => {}, getInstances: () => [],
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {},
  });
  await resumeSession({ projectName: 'p', sessionId: 'x' });
  assert.match(String(alerted), /resume failed/);
});

// ── wsRouter firstConnect integration ───────────────────────────────────────

function installDom(hash) {
  const window = new Window({ url: `http://localhost/${hash}` });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.URLSearchParams = window.URLSearchParams;
  globalThis.localStorage = window.localStorage;
  return window;
}

function baseDeps({ instances = [], resumeSpy }) {
  const noop = () => {};
  return {
    state: { activeId: null, instances },
    getTracker: () => ({ reset: noop, seedActive: noop, apply: noop, completedBatches: [] }),
    getUsage: () => ({ reset: noop, apply: noop }),
    globalRLTracker: { apply: noop },
    conversation: { clear: noop, apply: noop },
    headerHandle: { update: noop },
    lazyController: { init: noop },
    sessionActions: { resumeSession: resumeSpy },
    composer: {}, sidebar: {}, subagentPanel: {},
    bumpUnread: noop, flushPendingAnswers: noop,
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: noop, setSidebarStatus: noop,
  };
}

test('firstConnect skips + clears the anchor for an ARCHIVED session', async () => {
  const sid = 'aaaa-bbbb';
  installDom(`#session=${sid}`);
  const { installWsRouter } = await load('wsRouter.js');
  const { readSessionAnchor } = await load('anchor.js');

  let resumeCalled = false;
  let located = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/locate')) {
      located = true;
      return { ok: true, json: async () => ({ project: 'p', worktreeName: null, archived: true }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  installWsRouter(baseDeps({ resumeSpy: async () => { resumeCalled = true; } }));
  bus.dispatchEvent(new Event('open'));

  await waitFor(() => located);
  await new Promise(r => setTimeout(r, 20)); // let the post-locate branch settle
  assert.equal(resumeCalled, false, 'archived session is NOT auto-resumed');
  assert.equal(readSessionAnchor(), null, 'stale anchor cleared');
});

test('firstConnect auto-resumes a non-archived anchored session with silent:true', async () => {
  const sid = 'cccc-dddd';
  installDom(`#session=${sid}`);
  const { installWsRouter } = await load('wsRouter.js');

  let resumeArgs = null;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/locate')) {
      return { ok: true, json: async () => ({ project: 'p', worktreeName: 'wt', archived: false }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  installWsRouter(baseDeps({ resumeSpy: async (args) => { resumeArgs = args; } }));
  bus.dispatchEvent(new Event('open'));

  await waitFor(() => resumeArgs !== null);
  assert.equal(resumeArgs.sessionId, sid);
  assert.equal(resumeArgs.projectName, 'p');
  assert.equal(resumeArgs.worktreeName, 'wt');
  assert.equal(resumeArgs.silent, true, 'anchor auto-resume passes silent:true');
});

// ── wsRouter popstate anchor-restore ────────────────────────────────────────
//
// Regression test for: switching from an active session into the sidebar
// app-switcher's plugin space fired a real-browser `popstate` (in addition to
// `hashchange`) for the `location.hash =` assignment in appSwitcher.js. The
// popstate handler read the *new* `#plugin/<id>/` hash, found no `session=`
// key in it, and — since state.activeId was still the active instance —
// called selectInstance(null), which cleared the session anchor out from
// under the plugin navigation. See public/wsRouter.js's popstate handler.

test('popstate while hash is in the #plugin/ space does not deselect the active instance', async () => {
  installDom('#plugin/fake-plugin/');
  const { installWsRouter } = await load('wsRouter.js');

  const instances = [{ id: 'inst-1', sessionId: 'sid-1' }];
  let selectedWith = 'never called';
  installWsRouter({
    ...baseDeps({ instances, resumeSpy: async () => {} }),
    state: { activeId: 'inst-1', instances },
    selectInstance: (id) => { selectedWith = id; },
  });

  window.dispatchEvent(new window.Event('popstate'));
  await new Promise(r => setTimeout(r, 20));

  assert.equal(selectedWith, 'never called', 'selectInstance must not fire while leaving/within the plugin hash space');
});

test('popstate back to a live session anchor still restores it (guard does not break the legit case)', async () => {
  const sid = 'sid-2';
  installDom(`#session=${sid}`);
  const { installWsRouter } = await load('wsRouter.js');

  const instances = [{ id: 'inst-2', sessionId: sid }];
  let selectedWith = 'never called';
  installWsRouter({
    ...baseDeps({ instances, resumeSpy: async () => {} }),
    state: { activeId: null, instances },
    selectInstance: (id) => { selectedWith = id; },
  });

  window.dispatchEvent(new window.Event('popstate'));
  await new Promise(r => setTimeout(r, 20));

  assert.equal(selectedWith, 'inst-2', 'a genuine back-navigation onto a live session anchor still selects it');
});
