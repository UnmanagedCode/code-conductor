// Frontend plugin modules: hashView's matchHash predicate + pluginView hash
// space (happy-dom), the pluginBridge script (executed against a scripted
// fake window — it must run as a plain classic script), and the appSwitcher
// dropdown. Modules are cache-bust-imported fresh per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { installBrowserHashSemantics } from './browser-hash-semantics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

let counter = 0;
function freshImport(name) {
  return import(pathToFileURL(path.join(PUB, name)).href + '?t=' + (++counter));
}

function makeWindow(url = 'http://localhost/') {
  const window = new Window({ url, settings: { disableIframePageLoading: true } });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  return window;
}

function buildViewDom(document) {
  const main = document.createElement('main');
  main.id = 'main';
  const view = document.createElement('section');
  view.id = 'plugin-view';
  view.hidden = true;
  main.appendChild(view);
  document.body.appendChild(main);
  return { main, view };
}

// ── hashView matchHash ──────────────────────────────────────────────────

test('hashView: matchHash keeps the view open across the hash space, tears down outside it', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  const { installHashView } = await freshImport('hashView.js');
  let toreDown = 0;
  const hv = installHashView({
    name: 'plugin',
    matchHash: h => h.startsWith('#plugin/'),
    navigate: () => {},
    onTeardown: () => { toreDown++; },
  });
  window.location.hash = '#plugin/a/';
  await window.happyDOM.waitUntilComplete();
  hv.open();
  assert.equal(window.document.getElementById('plugin-view').hidden, false);

  // Moving within the space must NOT tear down (exact-match would).
  window.location.hash = '#plugin/a/deeper/path';
  await window.happyDOM.waitUntilComplete();
  assert.equal(window.document.getElementById('plugin-view').hidden, false);
  assert.equal(toreDown, 0);

  window.location.hash = '#costs';
  await window.happyDOM.waitUntilComplete();
  assert.equal(window.document.getElementById('plugin-view').hidden, true);
  assert.equal(toreDown, 1);
});

test('hashView: default exact-hash behavior unchanged without matchHash', async () => {
  const window = makeWindow('http://localhost/#');
  const main = window.document.createElement('main');
  main.id = 'main';
  const view = window.document.createElement('section');
  view.id = 'costs-view';
  view.hidden = true;
  main.appendChild(view);
  window.document.body.appendChild(main);
  const { installHashView } = await freshImport('hashView.js');
  const hv = installHashView({ name: 'costs', navigate: () => { window.location.hash = '#costs'; } });
  hv.open();
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false);
  window.location.hash = '#costs2';
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, true);
});

// ── pluginView ──────────────────────────────────────────────────────────

// Loading is fetch-driven (status → optional start → src), so tests stub
// the REST surface and settle the promise chain with macrotask ticks.
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function stubPluginViewApi({ state = 'ready', startResult } = {}) {
  const calls = [];
  globalThis.fetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    if (String(url).endsWith('/status')) {
      return Promise.resolve({ ok: true, json: async () => ({ state, name: 'Fake' }) });
    }
    if (String(url).endsWith('/start')) {
      if (startResult === 'fail') {
        return Promise.resolve({ ok: false, status: 502, json: async () => ({ error: 'start blew up', tail: 'boom tail' }) });
      }
      if (startResult instanceof Promise) return startResult;
      return Promise.resolve({ ok: true, json: async () => ({ state: 'ready' }) });
    }
    // appSwitcher's own install-time refresh() lands here in the combined
    // appSwitcher+pluginView tests, so this has to be the real /api/plugins
    // envelope (src/plugins/api.ts), not a bare array.
    if (String(url).startsWith('/api/plugins')) {
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], notices: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ([]) });
  };
  return calls;
}

test('pluginView: opens on #plugin hash, swaps plugins, avoids reload on subpath, teardown blanks', async () => {
  const window = makeWindow('http://localhost/#');
  const { view } = buildViewDom(window.document);
  const calls = stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  let closed = 0;
  installPluginView({ onClosed: () => { closed++; } });

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(view.hidden, false);
  const iframe = window.document.getElementById('plugin-frame');
  assert.ok(iframe, 'iframe created on demand');
  assert.match(iframe.getAttribute('src'), /^\/plugins\/fake-plugin\/$/);
  assert.ok(calls.includes('GET /api/plugins/fake-plugin/status'));
  assert.ok(!calls.some(c => c.includes('/start')), 'ready plugin needs no start');
  assertNull(view.querySelector('.plugin-frame-resident'), 'a plain plugin gets no resident frame');

  // Subpath change within the same plugin: steer via bridge, no src reload.
  window.location.hash = '#plugin/fake-plugin/sub';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.match(iframe.getAttribute('src'), /^\/plugins\/fake-plugin\/$/, 'src untouched on subpath change');

  // Different plugin: reload.
  window.location.hash = '#plugin/other/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.match(iframe.getAttribute('src'), /^\/plugins\/other\/$/);

  // Leaving the space: teardown blanks the iframe, hides the view, and
  // notifies onClosed (the switcher re-sync hook).
  window.location.hash = '#';
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, true);
  assert.equal(iframe.getAttribute('src'), 'about:blank');
  assert.ok(closed >= 1, 'onClosed fired on teardown');
});

test('pluginView: boot directly on a plugin hash opens the view', async () => {
  const window = makeWindow('http://localhost/#plugin/fake-plugin/dashboard');
  const { view } = buildViewDom(window.document);
  stubPluginViewApi({ state: 'ready' });
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView();
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(view.hidden, false);
  assert.match(window.document.getElementById('plugin-frame').getAttribute('src'),
    /^\/plugins\/fake-plugin\/dashboard$/);
});

test('pluginView: enabled-but-stopped plugin auto-starts with a visible affordance', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  let resolveStart;
  const startResult = new Promise((res) => {
    resolveStart = () => res({ ok: true, json: async () => ({ state: 'ready' }) });
  });
  const calls = stubPluginViewApi({ state: 'stopped', startResult });
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  // Mid-start: overlay shows the affordance, src not yet set.
  const overlay = window.document.getElementById('plugin-overlay');
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /Starting Fake/);
  const iframe = window.document.getElementById('plugin-frame');
  assert.ok(!iframe.getAttribute('src'), 'iframe not loaded until the child is ready');
  assert.ok(calls.includes('POST /api/plugins/fake-plugin/start'), 'switch triggered the lazy start');

  resolveStart();
  await tick();
  assert.match(iframe.getAttribute('src'), /^\/plugins\/fake-plugin\/$/);
});

test('pluginView: start failure shows the error + tail with a Retry button, not the raw 503', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  stubPluginViewApi({ state: 'crashed', startResult: 'fail' });
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  const overlay = window.document.getElementById('plugin-overlay');
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /start blew up/);
  assert.match(overlay.textContent, /boom tail/);
  assert.ok(overlay.querySelector('button'), 'Retry affordance present');
  assert.ok(!window.document.getElementById('plugin-frame').getAttribute('src'));

  // Retry with a now-ready plugin loads the frame.
  stubPluginViewApi({ state: 'ready' });
  overlay.querySelector('button').click();
  await tick();
  assert.match(window.document.getElementById('plugin-frame').getAttribute('src'), /^\/plugins\/fake-plugin\/$/);
});

// ── pluginView: keep-alive resident frames (frontend.keepAlive) ─────────
// happy-dom never loads a frame document, so survival is asserted as node
// identity + untouched src + no /start; whether the hidden page keeps running
// is measured only by harness/playwright/check-plugin-keepalive.mjs. A frame's
// contentWindow is null here, so tests that need one pin a fake on the node.

const kaRow = (over = {}) => ({ state: 'ready', enabled: true, frontendKeepAlive: true, ...over });

// Per-id rows, mutable between calls. A row may be the number 404 (unknown
// id), 500 (server error), 'network' (fetch rejects) or 'unreadable' (a 200
// whose body does not parse). /start marks the row ready unless `startFails`.
function stubRowsApi(rows, { switcherRows = [], startFails = false, startResult } = {}) {
  const calls = [];
  const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    const m = /^\/api\/plugins\/([^/]+)\/(status|start)$/.exec(String(url));
    if (!m) return json(200, { rows: switcherRows, notices: [] });
    const row = rows[m[1]];
    if (row === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (row === 'unreadable') {
      return Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    }
    if (typeof row === 'number') return json(row, { error: `HTTP ${row}` });
    if (m[2] === 'start') {
      if (startResult) return startResult;
      if (startFails) return json(409, { error: 'plugin is disabled' });
      row.state = 'ready';
      return json(200, { state: 'ready' });
    }
    return json(200, { name: m[1], ...row });
  };
  return calls;
}

async function setupKeepAlive(rows, opts) {
  const window = makeWindow('http://localhost/#');
  installBrowserHashSemantics(window);
  const { view } = buildViewDom(window.document);
  const calls = stubRowsApi(rows, opts);
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  let closed = 0;
  let residentChanges = 0;
  const pv = installPluginView({ onClosed: () => { closed++; }, onResidentChange: () => { residentChanges++; } });
  const go = async (hash) => {
    window.location.hash = hash;
    await window.happyDOM.waitUntilComplete();
    await tick();
  };
  const residentOf = id => window.document.querySelector(`iframe.plugin-frame-resident[data-plugin-id="${id}"]`);
  return { window, view, calls, pv, go, residentOf, closed: () => closed, residentChanges: () => residentChanges };
}

function fakeContentWindow(frame) {
  const win = { posted: [], postMessage(msg) { this.posted.push(msg); } };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  return win;
}

function postRoute(window, source, path) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { cc: 1, type: 'route', path }, origin: 'http://localhost', source,
  }));
}

test('pluginView: a keepAlive plugin\'s frame survives leaving the space — hidden, src intact, not blanked', async () => {
  const { window, view, go, residentOf, closed } = await setupKeepAlive({ ka: kaRow() });
  const { reconcileMainViews } = await import(pathToFileURL(path.join(PUB, 'mainViews.js')).href);

  await go('#plugin/ka/');
  const frame = residentOf('ka');
  assert.ok(frame, 'a resident frame is created on first show');
  assert.equal(frame.getAttribute('src'), '/plugins/ka/');
  assert.equal(window.document.getElementById('plugin-frame').hidden, true, 'the shared frame is hidden behind it');

  // Leave: the hash moves off the space.
  await go('#');
  assert.equal(view.hidden, true);
  assert.equal(closed(), 1, 'onClosed still fires');
  assert.ok(residentOf('ka') === frame && frame.parentElement === view, 'the same node stays mounted under #plugin-view');
  assert.equal(frame.getAttribute('src'), '/plugins/ka/', 'src untouched — not blanked');

  // Supersede: another main view claims #main.
  await go('#plugin/ka/');
  window.history.replaceState(null, '', '/#session=abc');
  reconcileMainViews();
  await tick();
  assert.equal(view.hidden, true);
  assert.equal(closed(), 2);
  assert.ok(residentOf('ka') === frame && frame.isConnected, 'supersede keeps the node too');
  assert.equal(frame.getAttribute('src'), '/plugins/ka/');
});

test('pluginView: re-entering a resident plugin issues no /start and sets no src', async () => {
  const rows = { ka: kaRow() };
  const { window, go, calls, residentOf } = await setupKeepAlive(rows);
  await go('#plugin/ka/');
  const frame = residentOf('ka');
  await go('#');

  // A crashed row keeps the frame; a plain load would POST /start for it.
  rows.ka.state = 'crashed';
  const before = calls.length;
  await go('#plugin/ka/');
  const reentry = calls.slice(before);
  assert.deepEqual(reentry, ['GET /api/plugins/ka/status'], 'one background status read, no /start');
  assert.ok(residentOf('ka') === frame && frame.isConnected);
  assert.equal(frame.hidden, false);
  assert.equal(frame.getAttribute('src'), '/plugins/ka/');
  assert.equal(window.document.getElementById('plugin-overlay').hidden, true, 'no "Starting …" overlay');
});

test('pluginView: re-entry at \'/\' keeps the frame\'s route and rewrites the hash', async () => {
  const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow() });
  await go('#plugin/ka/');
  const win = fakeContentWindow(residentOf('ka'));
  postRoute(window, win, '/call/42');
  assert.equal(window.location.hash, '#plugin/ka/call/42', 'sanity: the showing frame\'s route mirrors into the hash');
  await go('#');

  await go('#plugin/ka/');
  assert.equal(window.location.hash, '#plugin/ka/call/42');
  assert.deepEqual(win.posted, [], 'no navigate posted');
});

test('pluginView: re-entry at a different non-root subpath posts navigate to the resident frame', async () => {
  const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow() });
  await go('#plugin/ka/');
  const frame = residentOf('ka');
  const win = fakeContentWindow(frame);
  postRoute(window, win, '/call/42');
  await go('#');

  await go('#plugin/ka/settings');
  assert.deepEqual(win.posted, [{ cc: 1, type: 'navigate', path: '/settings' }]);
  assert.equal(window.location.hash, '#plugin/ka/settings');
  assert.equal(frame.getAttribute('src'), '/plugins/ka/', 'steered, not reloaded');
});

test('pluginView: re-entry at the frame\'s own tracked non-root route posts no navigate', async () => {
  const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow() });
  await go('#plugin/ka/');
  const frame = residentOf('ka');
  const win = fakeContentWindow(frame);
  postRoute(window, win, '/call/42');
  await go('#');

  await go('#plugin/ka/call/42');
  assert.deepEqual(win.posted, [], 'the frame is already there');
  assert.equal(window.location.hash, '#plugin/ka/call/42');
});

test('pluginView: a route message whose path lacks a leading slash is ignored', async (t) => {
  await t.test('from a hidden frame', async () => {
    const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow() });
    await go('#plugin/ka/');
    const win = fakeContentWindow(residentOf('ka'));
    postRoute(window, win, '/call/1');
    await go('#session=abc');
    postRoute(window, win, 'evil');
    assert.equal(window.location.hash, '#session=abc', 'the hash is untouched while hidden');
    await go('#plugin/ka/');
    assert.equal(window.location.hash, '#plugin/ka/call/1', 'the tracked route is unchanged: re-entry lands on it, not on #plugin/kaevil');
  });
  await t.test('from the showing frame', async () => {
    const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow() });
    await go('#plugin/ka/');
    const win = fakeContentWindow(residentOf('ka'));
    postRoute(window, win, '/call/1');
    postRoute(window, win, 'evil');
    assert.equal(window.location.hash, '#plugin/ka/call/1', 'not mirrored into the hash');
    await go('#');
    await go('#plugin/ka/');
    assert.equal(window.location.hash, '#plugin/ka/call/1', 'not tracked either');
  });
});

test('pluginView: A (keepAlive) → B (plain) → A keeps A\'s frame and blanks B\'s', async () => {
  const { window, view, go, residentOf } = await setupKeepAlive({ a: kaRow(), b: kaRow({ frontendKeepAlive: false }) });
  const visibleFrames = () => [...view.querySelectorAll('iframe')].filter(f => !f.hidden);
  await go('#plugin/a/');
  const a = residentOf('a');

  await go('#plugin/b/');
  const shared = window.document.getElementById('plugin-frame');
  assert.equal(shared.getAttribute('src'), '/plugins/b/');
  assertNull(residentOf('b'), 'a plain plugin gets no resident frame');
  assert.equal(a.hidden, true);
  assert.ok(visibleFrames().length === 1 && visibleFrames()[0] === shared);

  await go('#plugin/a/');
  assert.ok(residentOf('a') === a, 'one resident node for A throughout');
  assert.equal(a.getAttribute('src'), '/plugins/a/');
  assert.equal(shared.getAttribute('src'), 'about:blank', 'B is blanked, as a switch always did');
  assert.ok(visibleFrames().length === 1 && visibleFrames()[0] === a);
});

test('pluginView: two keepAlive plugins get one resident frame each', async () => {
  const { view, go, residentOf, pv } = await setupKeepAlive({ one: kaRow(), two: kaRow() });
  await go('#plugin/one/');
  const one = residentOf('one');
  await go('#plugin/two/');
  const two = residentOf('two');
  await go('#plugin/one/');
  assert.equal(view.querySelectorAll('iframe.plugin-frame-resident').length, 2, 'a revisit adds no frame');
  assert.ok(residentOf('one') === one && residentOf('two') === two);
  assert.equal(one.hidden, false);
  assert.equal(two.hidden, true);
  assert.equal(two.getAttribute('src'), '/plugins/two/', 'the hidden one is not blanked');
  assert.deepEqual(pv.residentIds().sort(), ['one', 'two']);
});

test('pluginView: a hidden resident frame\'s route message updates its record but never the hash', async () => {
  const { window, go, residentOf } = await setupKeepAlive({ ka: kaRow(), b: kaRow({ frontendKeepAlive: false }) });
  await go('#plugin/ka/');
  const win = fakeContentWindow(residentOf('ka'));

  // View closed.
  await go('#session=abc');
  postRoute(window, win, '/call/1');
  assert.equal(window.location.hash, '#session=abc');

  // Another plugin showing.
  await go('#plugin/b/');
  postRoute(window, win, '/call/2');
  assert.equal(window.location.hash, '#plugin/b/');

  // The record did move: re-entry at '/' lands on the tracked route.
  await go('#plugin/ka/');
  assert.equal(window.location.hash, '#plugin/ka/call/2');
});

test('pluginView: reconcile evicts a resident frame whose row no longer qualifies', async (t) => {
  const cases = [
    ['stopped', kaRow({ state: 'stopped' })],
    ['disabled', kaRow({ enabled: false, state: 'disabled' })],
    ['invalid', kaRow({ state: 'invalid' })],
    ['keepAlive dropped', kaRow({ frontendKeepAlive: false })],
    ['404', 404],
  ];
  for (const [label, row] of cases) {
    await t.test(label, async () => {
      const rows = { ka: kaRow() };
      const { go, calls, residentOf, pv, residentChanges } = await setupKeepAlive(rows);
      await go('#plugin/ka/');
      const frame = residentOf('ka');
      await go('#');
      const changes = residentChanges();

      rows.ka = row;
      await pv.reconcile();
      assert.equal(frame.isConnected, false, 'the frame is detached');
      assert.deepEqual(pv.residentIds(), []);
      assert.equal(residentChanges(), changes + 1, 'onResidentChange fires on eviction');

      // Re-entry is a fresh load again: status read, then a new frame.
      rows.ka = kaRow();
      const before = calls.length;
      await go('#plugin/ka/');
      assert.ok(calls.slice(before).includes('GET /api/plugins/ka/status'));
      const fresh = residentOf('ka');
      assert.ok(fresh && fresh !== frame, 'a new resident frame');
      assert.equal(fresh.getAttribute('src'), '/plugins/ka/');
    });
  }
});

test('pluginView: reconcile keeps the frame on crashed / failed / starting / a server, network or unreadable-body error', async (t) => {
  const cases = [
    ['crashed', kaRow({ state: 'crashed' })],
    ['failed', kaRow({ state: 'failed' })],
    ['starting', kaRow({ state: 'starting' })],
    ['500', 500],
    ['network error', 'network'],
    ['a 200 whose body does not parse', 'unreadable'],
  ];
  for (const [label, row] of cases) {
    await t.test(label, async () => {
      const rows = { ka: kaRow() };
      const { go, residentOf, pv } = await setupKeepAlive(rows);
      await go('#plugin/ka/');
      const frame = residentOf('ka');
      await go('#');
      rows.ka = row;
      await pv.reconcile();
      assert.ok(residentOf('ka') === frame && frame.isConnected);
      assert.equal(frame.getAttribute('src'), '/plugins/ka/');
      assert.deepEqual(pv.residentIds(), ['ka']);
    });
  }
});

test('pluginView: reconcile evicts a frame its Settings action put new code under', async (t) => {
  for (const action of ['restart', 'update', 'version']) {
    await t.test(action, async () => {
      const rows = { ka: kaRow() };
      const { go, residentOf, pv } = await setupKeepAlive(rows);
      await go('#plugin/ka/');
      const frame = residentOf('ka');
      await go('#settings');
      // The row still qualifies (a restarted backend reads ready): only the
      // action drives the eviction.
      await pv.reconcile({ action, ids: ['ka'] });
      assert.equal(frame.isConnected, false);
      assert.deepEqual(pv.residentIds(), []);
    });
  }
});

test('pluginView: reconcile keeps a frame through a crash, a lazy restart, and an action it was not named in', async (t) => {
  const cases = [
    ['crash', kaRow({ state: 'crashed' }), undefined],
    ['lazy restart', kaRow({ state: 'starting' }), undefined],
    ['restart of another plugin', kaRow(), { action: 'restart', ids: ['other'] }],
    ['a non-evicting action naming it', kaRow(), { action: 'start', ids: ['ka'] }],
  ];
  for (const [label, row, change] of cases) {
    await t.test(label, async () => {
      const rows = { ka: kaRow() };
      const { go, residentOf, pv } = await setupKeepAlive(rows);
      await go('#plugin/ka/');
      const frame = residentOf('ka');
      await go('#settings');
      rows.ka = row;
      await pv.reconcile(change);
      assert.ok(residentOf('ka') === frame && frame.isConnected);
      assert.equal(frame.getAttribute('src'), '/plugins/ka/');
    });
  }
});

test('pluginView: reconcile evicting the showing frame does not /start or reload it', async () => {
  const rows = { ka: kaRow() };
  const { go, calls, residentOf, pv } = await setupKeepAlive(rows);
  await go('#plugin/ka/');
  const frame = residentOf('ka');
  rows.ka = kaRow({ state: 'stopped' });
  const before = calls.length;
  await pv.reconcile();
  await tick();
  assert.equal(frame.isConnected, false);
  assert.deepEqual(calls.slice(before), ['GET /api/plugins/ka/status'], 'its own status read only: no /start, no fresh load');
  assertNull(residentOf('ka'), 'no replacement frame');
  assert.deepEqual(pv.residentIds(), []);
});

test('pluginView: re-entry\'s background check evicts and reloads when the row is disabled', async () => {
  const rows = { ka: kaRow() };
  const { window, go, calls, residentOf, pv } = await setupKeepAlive(rows, { startFails: true });
  await go('#plugin/ka/');
  const frame = residentOf('ka');
  await go('#');
  rows.ka = kaRow({ enabled: false, state: 'disabled' });
  const before = calls.length;
  await go('#plugin/ka/');
  await tick();
  assert.equal(frame.isConnected, false);
  assert.deepEqual(pv.residentIds(), []);
  assert.ok(calls.slice(before).includes('POST /api/plugins/ka/start'), 'reloaded through the plain path');
  const overlay = window.document.getElementById('plugin-overlay');
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /plugin is disabled/);
});

test('pluginView: teardown mid-start of a keepAlive plugin creates no resident frame', async () => {
  let resolveStart;
  const startResult = new Promise((res) => {
    resolveStart = () => res({ ok: true, status: 200, json: async () => ({ state: 'ready' }) });
  });
  const { window, go, pv } = await setupKeepAlive({ ka: kaRow({ state: 'stopped' }) }, { startResult });
  await go('#plugin/ka/');
  await go('#');
  resolveStart();
  await tick();
  assertNull(window.document.querySelector('iframe.plugin-frame-resident'), 'no resident frame');
  assert.deepEqual(pv.residentIds(), []);
});

// ── pluginManager (Settings → Plugins: installed list + Plugin Library) ──

function buildPluginManagerDom(document) {
  const mk = (tag, id) => { const el = document.createElement(tag); if (id) el.id = id; return el; };
  const group = mk('div', 'settings-plugins');
  const status = mk('div', 'pl-status');
  const list = mk('ul', 'pl-list');
  const rescan = mk('button', 'pl-rescan-btn');
  const libStatus = mk('div', 'pll-status');
  const libList = mk('ul', 'pll-list');
  const tail = mk('details', 'pll-tail');
  tail.hidden = true;
  const tailPre = mk('pre', 'pll-tail-pre');
  tail.appendChild(tailPre);
  const updateAll = mk('button', 'pll-update-all-btn');
  updateAll.disabled = true;
  group.append(status, list, rescan, updateAll, libStatus, libList, tail);
  document.body.appendChild(group);
  return { status, list, rescan, updateAll, libStatus, libList, tail, tailPre };
}

// Fakes a fetch Response whose body streams NDJSON lines (one per `read()`
// call, mirroring how the real chunked server response arrives), with a
// content-type that pluginManager.js's streamAction() checks to decide
// whether to parse the body as a stream vs. a single JSON blob.
function ndjsonResponse(events) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/x-ndjson' : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= events.length) return { done: true, value: undefined };
            const line = `${JSON.stringify(events[i++])}\n`;
            return { done: false, value: new TextEncoder().encode(line) };
          },
        };
      },
    },
  };
}

// Fixed single library entry (code-share); `installed` flips true after a
// successful install call, mirroring the real server's directory-exists
// check. `updateAvailable` mirrors library.ts's list() ahead/behind check.
function stubPluginManagerFetch({
  initiallyInstalled = false, updateAvailable = true,
  installResult, installPostClone = null, updateResult, updatePostPull = null, updateRestarted = null,
  rows = [], projects = [],
} = {}) {
  const calls = [];
  let installed = initiallyInstalled;
  globalThis.fetch = (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/plugins') return Promise.resolve({ ok: true, json: async () => ({ rows, notices: [] }) });
    if (url === '/api/projects') return Promise.resolve({ ok: true, json: async () => projects });
    if (url === '/api/plugins/library') {
      return Promise.resolve({ ok: true, json: async () => ({ entries: [{
        id: 'code-share', name: 'Code Share', description: 'Share code snippets.',
        repo: 'https://github.com/UnmanagedCode/code-share', installed, installedAs: installed ? 'code-share' : null,
        updateAvailable: installed && updateAvailable, behind: installed && updateAvailable ? 1 : 0,
      }], skipped: [] }) });
    }
    if (url === '/api/plugins/library/code-share/install') {
      if (installResult === 'fail') {
        return Promise.resolve(ndjsonResponse([
          { type: 'chunk', phase: 'clone', text: 'Cloning into code-share...\n' },
          { type: 'result', ok: false, error: 'clone failed', tail: 'fatal: boom' },
        ]));
      }
      installed = true;
      return Promise.resolve(ndjsonResponse([
        { type: 'chunk', phase: 'clone', text: 'Cloning into code-share...\n' },
        { type: 'chunk', phase: 'clone', text: 'done.\n' },
        { type: 'result', ok: true, result: { id: 'code-share', name: 'code-share', postClone: installPostClone } },
      ]));
    }
    if (url === '/api/plugins/library/code-share/update') {
      if (updateResult === 'fail') {
        return Promise.resolve(ndjsonResponse([
          { type: 'chunk', phase: 'pull', text: 'Updating code-share...\n' },
          { type: 'result', ok: false, error: 'git pull failed', tail: 'fatal: diverged' },
        ]));
      }
      return Promise.resolve(ndjsonResponse([
        { type: 'chunk', phase: 'pull', text: 'Updating code-share...\n' },
        { type: 'result', ok: true, result: { id: 'code-share', name: 'code-share', project: 'code-share', postPull: updatePostPull, restarted: updateRestarted } },
      ]));
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
  return calls;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Multi-entry library for the Update all tests. `entries` are
// {id, name, installed, updateAvailable}; `updates[id]` is awaited per update
// POST (so a deferred's promise holds that update in flight) and is either
// 'fail' or {postPull?, restarted?}. A successful update clears that entry's
// updateAvailable, as the next list() would. The library GET answers 500
// while `libraryFails()` is true.
function stubLibraryFetch({ entries, updates = {}, libraryFails = () => false, rows = [] }) {
  const calls = [];
  const state = entries.map(e => ({ ...e }));
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/plugins') return { ok: true, json: async () => ({ rows, notices: [] }) };
    if (url === '/api/projects') return { ok: true, json: async () => [] };
    if (url === '/api/plugins/library') {
      if (libraryFails()) return { ok: false, status: 500, json: async () => ({ error: 'library unavailable' }) };
      return { ok: true, json: async () => ({ entries: state.map(e => ({
        ...e, description: `${e.name} plugin.`, repo: `https://example.test/${e.id}`,
        installedAs: e.installed ? e.id : null, behind: e.updateAvailable ? 1 : 0,
      })), skipped: [] }) };
    }
    const m = /^\/api\/plugins\/library\/([^/]+)\/update$/.exec(url);
    if (m && method === 'POST') {
      const id = m[1];
      const spec = await (updates[id] ?? {});
      if (spec === 'fail') {
        return ndjsonResponse([
          { type: 'chunk', phase: 'pull', text: `Updating ${id}...\n` },
          { type: 'result', ok: false, error: 'git pull failed', tail: `fatal: ${id} diverged` },
        ]);
      }
      state.find(e => e.id === id).updateAvailable = false;
      return ndjsonResponse([
        { type: 'chunk', phase: 'pull', text: `Updating ${id}...\n` },
        { type: 'result', ok: true, result: { id, name: id, project: id, postPull: spec.postPull ?? null, restarted: spec.restarted ?? null } },
      ]);
    }
    return { ok: true, json: async () => ({}) };
  };
  return calls;
}

const updatePosts = calls => calls.filter(c => /^POST \/api\/plugins\/library\/[^/]+\/update$/.test(c));

// ── the load-failure notices actually reach the user ─────────────────────────
// These two are the acceptance bar for the F17 (b)/(c) surfacing: the difference
// between "the server recorded it" and "the user was told". A server that
// reports notices nobody renders is the same silent swallow in new clothes.

test('pluginManager: a corrupt-registry notice is surfaced in the plugins status line', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  globalThis.fetch = (url) => {
    if (url === '/api/plugins') {
      return Promise.resolve({ ok: true, json: async () => ({
        rows: [],
        notices: [{ file: 'registry.json', reason: 'bad json', backup: '/x/registry.json.corrupt' }],
      }) });
    }
    if (url === '/api/plugins/library') {
      return Promise.resolve({ ok: true, json: async () => ({ entries: [], skipped: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  };
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  assert.match(dom.status.textContent, /registry\.json/, 'the offending file is named');
  assert.match(dom.status.textContent, /bad json/, 'the reason is shown');
  assert.match(dom.status.textContent, /registry\.json\.corrupt/, 'where the old file went');
  assert.match(dom.status.textContent, /reset/, 'that enable/version state was lost');
});

test('pluginManager: a contributions-only row badges its playbooks beside its roles', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const row = {
    id: 'acme', name: 'Acme', project: 'acme', system: 'local', localOnly: [], version: '1.0.0',
    state: 'enabled', enabled: true, activeVersion: { type: 'main' }, manifestSource: { type: 'main' },
    hasBackend: false, hasFrontend: false, navLabel: null, frontendPath: null, hasMcp: false,
    conventions: [], roles: [{ slug: 'acme/captain', name: 'Captain' }],
    playbooks: [{ slug: 'acme/release' }, { slug: 'acme/hotfix' }],
    port: null, pid: null, startedAt: null, gitHead: null, stale: false, errors: [], crashTail: null,
  };
  globalThis.fetch = (url) => {
    if (url === '/api/plugins') return Promise.resolve({ ok: true, json: async () => ({ rows: [row], notices: [] }) });
    if (url === '/api/plugins/library') return Promise.resolve({ ok: true, json: async () => ({ entries: [], skipped: [] }) });
    return Promise.resolve({ ok: true, json: async () => [] });
  };
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();
  const badges = [...dom.list.querySelectorAll('.pl-contrib')].map(el => el.textContent);
  assert.deepEqual(badges, ['1 role', '2 playbooks']);
});

test('pluginManager: a skipped library drop-in is surfaced in the library status line', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  globalThis.fetch = (url) => {
    if (url === '/api/plugins') {
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], notices: [] }) });
    }
    if (url === '/api/plugins/library') {
      return Promise.resolve({ ok: true, json: async () => ({
        entries: [], skipped: [
          { dir: '/a', file: 'broken.json', reason: 'unexpected token' },
          { dir: '/b', file: 'broken.json', reason: 'unexpected token' },
          { dir: '/mnt/gone', file: null, reason: 'library dir unreadable: ENOENT' },
        ],
      }) });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  };
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  assert.match(dom.libStatus.textContent, /broken\.json/, 'the offending drop-in is named');
  assert.match(dom.libStatus.textContent, /unexpected token/, 'the reason is shown');
  assert.ok(dom.libStatus.textContent.includes('/a/broken.json'), 'identical basenames are told apart by dir');
  assert.ok(dom.libStatus.textContent.includes('/b/broken.json'), 'identical basenames are told apart by dir');
  assert.ok(dom.libStatus.textContent.includes('/mnt/gone (library dir unreadable'), 'a directory-level skip is rendered');
});

test('pluginManager: renders a library entry with an Install button when not installed', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch();
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row, 'library row rendered');
  assert.match(row.querySelector('.pll-name').textContent, /Code Share/);
  const installBtn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Install');
  assert.ok(installBtn, 'Install button present');
  assert.ok(!row.querySelector('.pll-installed-as'));
});

test('pluginManager: Install shows progress, then relabels the entry as installed', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const calls = stubPluginManagerFetch();
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const installBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Install');
  installBtn.click();
  assert.match(dom.libStatus.textContent, /Installing Code Share/);
  assert.equal(installBtn.disabled, true, 'row button disabled while the install streams');
  assert.equal(installBtn.textContent, 'Installing…');
  await tick();

  assert.ok(calls.includes('POST /api/plugins/library/code-share/install'));
  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'), 'now shows installed-as');
  assert.deepEqual([...row.querySelectorAll('button')].map(b => b.textContent), ['Update'], 'Install button replaced by Update once installed');
});

test('pluginManager: install failure surfaces the error and clone-output tail, not a raw exception', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ installResult: 'fail' });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const installBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Install');
  installBtn.click();
  await tick();

  assert.match(dom.libStatus.textContent, /clone failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false);
  assert.match(dom.tailPre.textContent, /fatal: boom/);
  // Entry stays installable — the failed attempt didn't mark it installed —
  // and its button is re-enabled rather than stuck on "Installing…".
  const row = dom.libList.querySelector('.pll-row');
  const restoredBtn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Install');
  assert.ok(restoredBtn);
  assert.equal(restoredBtn.disabled, false);
  // The row's live output box keeps the streamed clone output visible.
  assert.match(row.querySelector('.pll-live').textContent, /Cloning into code-share/);
});

test('pluginManager: an installed entry renders an Update button, not Install', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'));
  const buttons = [...row.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(buttons, ['Update']);
});

test('pluginManager: an installed, up-to-date entry renders no Update button', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true, updateAvailable: false });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const row = dom.libList.querySelector('.pll-row');
  assert.match(row.querySelector('.pll-installed-as').textContent, /up to date/);
  const buttons = [...row.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(buttons, [], 'no Update button when nothing to pull');
});

test('pluginManager: Update shows progress, then refreshes', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const calls = stubPluginManagerFetch({ initiallyInstalled: true });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  assert.match(dom.libStatus.textContent, /Updating Code Share/);
  assert.equal(updateBtn.disabled, true, 'row button disabled while the update streams');
  assert.equal(updateBtn.textContent, 'Updating…');
  await tick();

  assert.ok(calls.includes('POST /api/plugins/library/code-share/update'));
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), false);
  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'), 'still installed after update');
});

// The change pluginView.js evicts keep-alive frames on (onCatalogChange's argument).
const pmRow = (over = {}) => ({
  id: 'ka', name: 'KA', project: 'kaproj', state: 'ready', stale: true, enabled: true,
  hasBackend: true, localOnly: [], conventions: [], roles: [], playbooks: [], errors: [], ...over,
});

test('pluginManager: Restart and a version switch report {action, ids}; Stop reports none', async (t) => {
  const setupMgr = async () => {
    const window = makeWindow();
    const dom = buildPluginManagerDom(window.document);
    stubPluginManagerFetch({ rows: [pmRow()], projects: [{ name: 'kaproj', worktrees: [{ worktreeName: 'wt' }] }] });
    const { installPluginManager } = await freshImport('pluginManager.js');
    const changes = [];
    const mgr = installPluginManager({ onCatalogChange: (c) => { changes.push(c); } });
    await mgr.load();
    const button = label => [...dom.list.querySelectorAll('button')].find(b => b.textContent === label);
    return { window, dom, changes, button };
  };
  await t.test('Restart', async () => {
    const { changes, button } = await setupMgr();
    button('Restart').click();
    await tick();
    assert.deepEqual(changes, [{ action: 'restart', ids: ['ka'] }]);
  });
  await t.test('version switch', async () => {
    const { window, dom, changes } = await setupMgr();
    const sel = dom.list.querySelector('select.pl-version');
    sel.value = 'worktree:wt';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.deepEqual(changes, [{ action: 'version', ids: ['ka'] }]);
  });
  await t.test('Stop', async () => {
    const { changes, button } = await setupMgr();
    button('Stop').click();
    await tick();
    assert.deepEqual(changes, [undefined]);
  });
});

test('pluginManager: Update reports {action:\'update\'} naming every plugin in the updated project', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true, rows: [
    pmRow({ id: 'share-a', project: 'code-share' }),
    pmRow({ id: 'share-b', project: 'code-share' }),
    pmRow({ id: 'elsewhere', project: 'other' }),
  ] });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const changes = [];
  const mgr = installPluginManager({ onCatalogChange: (c) => { changes.push(c); } });
  await mgr.load();
  [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update').click();
  await tick();
  assert.deepEqual(changes, [{ action: 'update', ids: ['share-a', 'share-b'] }]);
});

test('pluginManager: Update all reports {action:\'update\'} naming the plugins of the projects that updated', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubLibraryFetch({
    entries: [
      { id: 'one', name: 'One', installed: true, updateAvailable: true },
      { id: 'two', name: 'Two', installed: true, updateAvailable: true },
    ],
    updates: { two: 'fail' },
    rows: [pmRow({ id: 'p-one', project: 'one' }), pmRow({ id: 'p-two', project: 'two' })],
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const changes = [];
  const mgr = installPluginManager({ onCatalogChange: (c) => { changes.push(c); } });
  await mgr.load();
  dom.updateAll.click();
  await tick(20);
  assert.deepEqual(changes, [{ action: 'update', ids: ['p-one'] }], 'the failed update names nothing');
});

test('pluginManager: Update failure (git pull failed) surfaces the error and tail', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true, updateResult: 'fail' });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  await tick();

  assert.match(dom.libStatus.textContent, /git pull failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false);
  assert.match(dom.tailPre.textContent, /fatal: diverged/);
  const row = dom.libList.querySelector('.pll-row');
  const restoredBtn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Update');
  assert.ok(restoredBtn);
  assert.equal(restoredBtn.disabled, false);
  assert.match(row.querySelector('.pll-live').textContent, /Updating code-share/);
});

test('pluginManager: install succeeds but a failed postClone is surfaced as a warning, not an install failure', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ installPostClone: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' } });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const installBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Install');
  installBtn.click();
  await tick();

  // The install itself succeeded — the entry already shows installed —
  // but the status line carries the post-install warning + tail.
  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'), 'install succeeded despite the postClone failure');
  assert.match(dom.libStatus.textContent, /post-install command failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false);
  assert.match(dom.tailPre.textContent, /npm ERR! boom/);
});

test('pluginManager: update succeeds but a failed postPull is surfaced as a warning, not an update failure', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true, updatePostPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom again' } });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  await tick();

  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'), 'update (pull) itself succeeded');
  assert.match(dom.libStatus.textContent, /post-update command failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.match(dom.tailPre.textContent, /npm ERR! boom again/);
  // restarted is null here (nothing was running) — must read exactly like
  // the plain hook-failure case, never claim a backend was left on old code.
  assert.doesNotMatch(dom.libStatus.textContent, /left running the old code/i);
});

test('pluginManager: update succeeds but a failed auto-restart is surfaced as a warning, not an update failure', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({ initiallyInstalled: true, updateRestarted: { ids: ['code-share'], ok: false, error: 'boom' } });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  await tick();

  const row = dom.libList.querySelector('.pll-row');
  assert.ok(row.querySelector('.pll-installed-as'), 'update (pull) itself succeeded');
  assert.match(dom.libStatus.textContent, /restart.*failed/i);
  assert.match(dom.libStatus.textContent, /boom/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
});

test('pluginManager: update — a failed post-update hook wins the status line over a failed auto-restart', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({
    initiallyInstalled: true,
    updatePostPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' },
    updateRestarted: { ids: [], ok: false, error: 'restart boom' },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  await tick();

  assert.match(dom.libStatus.textContent, /post-update command failed/);
  assert.doesNotMatch(dom.libStatus.textContent, /restart boom/, 'the hook warning wins the single status line');
});

test('pluginManager: update — a skipped restart (failed postPull) tells the user the backend was left running the old code', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubPluginManagerFetch({
    initiallyInstalled: true,
    updatePostPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' },
    updateRestarted: { skipped: 'postPull-failed' },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  const updateBtn = [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update');
  updateBtn.click();
  await tick();

  assert.match(dom.libStatus.textContent, /post-update command failed/);
  assert.match(dom.libStatus.textContent, /left running the old code/i);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false, 'the failed hook output is still shown');
  assert.match(dom.tailPre.textContent, /npm ERR! boom/);
});

// ── Plugin Library: Update all ───────────────────────────────────────────

// Pins: Update all is enabled only by an `installed && updateAvailable` entry.
test('pluginManager: Update all is disabled when no library entry has an update', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubLibraryFetch({ entries: [
    { id: 'a', name: 'a', installed: true, updateAvailable: false },
    { id: 'b', name: 'b', installed: false, updateAvailable: false },
  ] });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  assert.equal(dom.updateAll.disabled, true);
  assert.equal(dom.updateAll.textContent, 'Update all');
});

// Pins: the count equals the rows showing a per-row Update button.
test('pluginManager: Update all is enabled and counts the entries with an update', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubLibraryFetch({ entries: [
    { id: 'a', name: 'a', installed: true, updateAvailable: true },
    { id: 'b', name: 'b', installed: true, updateAvailable: true },
    { id: 'c', name: 'c', installed: true, updateAvailable: false },
  ] });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  assert.equal(dom.updateAll.disabled, false);
  assert.equal(dom.updateAll.textContent, 'Update all (2)');
});

// Pins: updates run sequentially, never in parallel; up-to-date entries are
// skipped; the run refreshes the list exactly once, after its last update,
// and notifies the catalog once.
test('pluginManager: Update all updates each updatable entry one at a time, then refreshes', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const gateA = deferred();
  const calls = stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
      { id: 'c', name: 'c', installed: true, updateAvailable: false },
    ],
    updates: { a: gateA.promise },
  });
  let catalogChanges = 0;
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager({ onCatalogChange: () => { catalogChanges++; } }).load();

  dom.updateAll.click();
  await tick();

  assert.deepEqual(updatePosts(calls), ['POST /api/plugins/library/a/update']);
  assert.equal(dom.updateAll.disabled, true);
  assert.equal(dom.updateAll.textContent, 'Updating 1/2…');
  assert.match(dom.libStatus.textContent, /Updating a \(1\/2\)/);
  const rowButtons = [...dom.libList.querySelectorAll('button')];
  assert.ok(rowButtons.length > 0);
  assert.ok(rowButtons.every(b => b.disabled), 'every library row button is disabled during the run');

  gateA.resolve({});
  await tick(30);

  assert.deepEqual(updatePosts(calls), [
    'POST /api/plugins/library/a/update',
    'POST /api/plugins/library/b/update',
  ]);
  const firstPost = calls.indexOf('POST /api/plugins/library/a/update');
  const lastPost = calls.indexOf('POST /api/plugins/library/b/update');
  const runGets = calls.map((c, i) => [c, i]).filter(([c, i]) => i > firstPost && c === 'GET /api/plugins/library');
  assert.equal(runGets.length, 1, 'the run reloads the list exactly once');
  assert.ok(runGets[0][1] > lastPost, 'the one reload comes after the last update');
  assert.equal(dom.libStatus.textContent, 'Updated 2 of 2 plugins');
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), false);
  assert.equal(dom.updateAll.disabled, true);
  assert.equal(dom.updateAll.textContent, 'Update all');
  assert.equal(catalogChanges, 1);
});

// Pins: one failure does not stop the run; its error and tail are surfaced
// per plugin; the failed entry stays updatable for a retry.
test('pluginManager: Update all continues past a failed update and names it in the summary', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const calls = stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    updates: { a: 'fail' },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  dom.updateAll.click();
  await tick(30);

  assert.deepEqual(updatePosts(calls), [
    'POST /api/plugins/library/a/update',
    'POST /api/plugins/library/b/update',
  ]);
  assert.match(dom.libStatus.textContent, /Updated 1 of 2 plugins/);
  assert.match(dom.libStatus.textContent, /a failed: git pull failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false);
  assert.match(dom.tailPre.textContent, /── a ──/);
  assert.match(dom.tailPre.textContent, /fatal: a diverged/);
  assert.equal(dom.updateAll.disabled, false);
  assert.equal(dom.updateAll.textContent, 'Update all (1)');
});

// Pins: a soft post-update warning uses the single-update wording, is listed
// with its tail, and does not reduce the success count.
test('pluginManager: Update all reports a post-update warning per plugin without counting it as a failure', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    updates: { a: { postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! a' } } },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  dom.updateAll.click();
  await tick(30);

  assert.match(dom.libStatus.textContent, /Updated 2 of 2 plugins/);
  assert.match(dom.libStatus.textContent, /Updated a, but its post-update command failed/);
  assert.equal(dom.libStatus.classList.contains('pl-status-err'), true);
  assert.equal(dom.tail.hidden, false);
  assert.match(dom.tailPre.textContent, /npm ERR! a/);
});

// Pins: the run holds the shared busy guard, so other plugin actions no-op.
test('pluginManager: other plugin actions are blocked while Update all runs', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const gateA = deferred();
  const calls = stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    updates: { a: gateA.promise },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  dom.updateAll.click();
  await tick();
  dom.rescan.click();
  await tick();
  assert.ok(!calls.includes('POST /api/plugins/rescan'), 'Rescan is a no-op during the run');

  gateA.resolve({});
  await tick(30);
});

// Pins: a load() during the run cannot re-arm Update all or any row button.
test('pluginManager: a reload during Update all keeps the button disabled', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const gateA = deferred();
  stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    updates: { a: gateA.promise },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();

  dom.updateAll.click();
  await tick();
  await mgr.load();
  assert.equal(dom.updateAll.disabled, true);
  assert.equal(dom.updateAll.textContent, 'Updating 1/2…');
  const rowButtons = [...dom.libList.querySelectorAll('button')];
  assert.ok(rowButtons.length > 0);
  assert.ok(rowButtons.every(b => b.disabled), 'the re-rendered row buttons stay disabled during the run');

  gateA.resolve({});
  await tick(30);
});

// Pins: Update all starts no update while another plugin action is in flight
// (the button stays clickable then, so the busy guard is what refuses it).
test('pluginManager: Update all starts no update while another plugin action is in flight', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  const gateA = deferred();
  const calls = stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    updates: { a: gateA.promise },
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update').click();
  await tick();
  dom.updateAll.click();
  gateA.resolve({});
  await tick(30);

  assert.deepEqual(updatePosts(calls), ['POST /api/plugins/library/a/update']);
});

// Pins: the run ends with Update all re-armed even when the closing reload fails.
test('pluginManager: Update all re-arms its button when the reload after the run fails', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  let libraryDown = false;
  stubLibraryFetch({
    entries: [
      { id: 'a', name: 'a', installed: true, updateAvailable: true },
      { id: 'b', name: 'b', installed: true, updateAvailable: true },
    ],
    libraryFails: () => libraryDown,
  });
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  libraryDown = true;
  dom.updateAll.click();
  await tick(30);

  assert.equal(dom.updateAll.disabled, false);
  assert.equal(dom.updateAll.textContent, 'Update all (2)');
});

// Pins: a single row Update releases the shared busy guard when it ends,
// whether it succeeded or failed, so later plugin actions still run.
test('pluginManager: a plugin action still runs after a single row Update ends', async (t) => {
  for (const [label, update] of [['succeeded', {}], ['failed', 'fail']]) {
    await t.test(label, async () => {
      const window = makeWindow();
      const dom = buildPluginManagerDom(window.document);
      const calls = stubLibraryFetch({
        entries: [{ id: 'a', name: 'a', installed: true, updateAvailable: true }],
        updates: { a: update },
      });
      const { installPluginManager } = await freshImport('pluginManager.js');
      await installPluginManager().load();

      [...dom.libList.querySelectorAll('button')].find(b => b.textContent === 'Update').click();
      await tick(30);
      assert.deepEqual(updatePosts(calls), ['POST /api/plugins/library/a/update']);
      dom.rescan.click();
      await tick();
      assert.ok(calls.includes('POST /api/plugins/rescan'), 'Rescan runs once the update has ended');
    });
  }
});

// Pins: a reload that empties the library disarms an armed Update all.
test('pluginManager: Update all disarms when a reload finds the library empty', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  stubLibraryFetch({ entries: [
    { id: 'a', name: 'a', installed: true, updateAvailable: true },
    { id: 'b', name: 'b', installed: true, updateAvailable: true },
  ] });
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();
  assert.equal(dom.updateAll.disabled, false);
  assert.equal(dom.updateAll.textContent, 'Update all (2)');

  stubLibraryFetch({ entries: [] });
  await mgr.load();
  assert.equal(dom.updateAll.disabled, true);
  assert.equal(dom.updateAll.textContent, 'Update all');
});

test('pluginManager: empty library renders the empty-state message', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  globalThis.fetch = (url) => {
    if (url === '/api/plugins/library') return Promise.resolve({ ok: true, json: async () => ({ entries: [], skipped: [] }) });
    if (url === '/api/plugins') return Promise.resolve({ ok: true, json: async () => ({ rows: [], notices: [] }) });
    return Promise.resolve({ ok: true, json: async () => [] });
  };
  const { installPluginManager } = await freshImport('pluginManager.js');
  const mgr = installPluginManager();
  await mgr.load();
  assert.match(dom.libStatus.textContent, /No library entries/);
  assert.equal(dom.libList.children.length, 0);
});

// ── pluginBridge (scripted fake window — proves classic-script semantics) ──

async function runBridge({ pathname = '/plugins/fake-plugin/', embedded = true, readyState = 'complete' } = {}) {
  const src = await fs.readFile(path.join(PUB, 'pluginBridge.js'), 'utf8');
  const posted = [];
  const dispatched = [];
  const listeners = new Map();
  const historyCalls = [];
  const win = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    dispatchEvent: (ev) => dispatched.push(ev),
    parent: { postMessage: (data, origin) => posted.push({ data, origin }) },
    location: { pathname, search: '', hash: '', origin: 'http://localhost' },
  };
  win.self = win;
  win.top = embedded ? {} : win;
  const history = {
    replaceState: (state, title, url) => {
      historyCalls.push(url);
      if (typeof url === 'string' && url.startsWith('/')) win.location.pathname = url;
    },
    pushState: undefined,
  };
  const doc = { readyState, addEventListener: (t, fn) => listeners.set(`doc:${t}`, fn) };
  class PopStateEvent { constructor(type, init) { this.type = type; this.state = init?.state ?? null; } }
  new Function('window', 'document', 'history', 'PopStateEvent', src)(win, doc, history, PopStateEvent);
  return { win, history, posted, dispatched, listeners, historyCalls };
}

test('pluginBridge: no-op standalone and outside a /plugins mount', async () => {
  const standalone = await runBridge({ embedded: false });
  assert.equal(standalone.posted.length, 0);
  assert.equal(standalone.history.pushState, undefined, 'history untouched');

  const wrongPath = await runBridge({ pathname: '/' });
  assert.equal(wrongPath.posted.length, 0);
  assert.equal(wrongPath.history.pushState, undefined);
});

test('pluginBridge: announces ready + initial route', async () => {
  const { posted } = await runBridge();
  assert.deepEqual(posted[0], { data: { cc: 1, type: 'ready' }, origin: 'http://localhost' });
  assert.deepEqual(posted[1], { data: { cc: 1, type: 'route', path: '/' }, origin: 'http://localhost' });
});

test('pluginBridge: pushState is demoted to replaceState and reports the route', async () => {
  const { history, posted, historyCalls } = await runBridge();
  posted.length = 0;
  history.pushState({ x: 1 }, '', '/plugins/fake-plugin/deep');
  assert.deepEqual(historyCalls, ['/plugins/fake-plugin/deep'], 'exactly one raw replaceState, zero pushState');
  assert.deepEqual(posted, [{ data: { cc: 1, type: 'route', path: '/deep' }, origin: 'http://localhost' }]);
});

test('pluginBridge: navigate message replaces state and synthesizes popstate; foreign origin ignored', async () => {
  const { listeners, posted, dispatched, historyCalls } = await runBridge();
  posted.length = 0;
  const onMessage = listeners.get('message');
  onMessage({ origin: 'http://evil', data: { cc: 1, type: 'navigate', path: '/pwn' } });
  assert.equal(historyCalls.length, 0);
  onMessage({ origin: 'http://localhost', data: { cc: 1, type: 'navigate', path: '/dashboard' } });
  assert.deepEqual(historyCalls, ['/plugins/fake-plugin/dashboard']);
  assert.equal(dispatched[0]?.type, 'popstate', 'SPA routers get a synthetic popstate');
});

// ── appSwitcher ─────────────────────────────────────────────────────────

function buildSwitcherDom(document) {
  const wrap = document.createElement('div');
  wrap.id = 'app-switcher';
  const h1 = document.createElement('h1');
  h1.textContent = 'CodeConductor';
  const select = document.createElement('select');
  select.id = 'app-switcher-select';
  select.hidden = true;
  wrap.append(h1, select);
  document.body.appendChild(wrap);
  return { h1, select };
}

function stubPluginsFetch(rows) {
  // GET /api/plugins returns the {rows, notices} envelope (src/plugins/api.ts).
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ rows, notices: [] }) });
}

test('appSwitcher: zero frontend plugins keeps the plain <h1>', async () => {
  const window = makeWindow();
  const { h1, select } = buildSwitcherDom(window.document);
  stubPluginsFetch([{ id: 'x', name: 'X', enabled: true, hasFrontend: false }]);
  const { installAppSwitcher } = await freshImport('appSwitcher.js');
  installAppSwitcher();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(select.hidden, true);
  assert.equal(h1.hidden, false);
});

test('appSwitcher: renders Conductor + plugins, navigates into the hash space, syncs on hashchange', async () => {
  const window = makeWindow('http://localhost/#');
  const { h1, select } = buildSwitcherDom(window.document);
  stubPluginsFetch([
    { id: 'fake-plugin', name: 'Fake Plugin', navLabel: 'Fake', enabled: true, hasFrontend: true },
    { id: 'disabled-one', name: 'Off', enabled: false, hasFrontend: true },
  ]);
  const { installAppSwitcher } = await freshImport('appSwitcher.js');
  let exits = 0;
  const switcher = installAppSwitcher({ onExitToConductor: () => { exits++; } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(select.hidden, false);
  assert.equal(h1.hidden, true);
  assert.deepEqual([...select.options].map(o => o.value), ['conductor', 'fake-plugin']);
  assert.equal([...select.options][1].textContent, 'Fake');

  select.value = 'fake-plugin';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.location.hash, '#plugin/fake-plugin/');

  window.location.hash = '#';
  await window.happyDOM.waitUntilComplete();
  assert.equal(select.value, 'conductor');
  window.location.hash = '#plugin/fake-plugin/sub';
  await window.happyDOM.waitUntilComplete();
  assert.equal(select.value, 'fake-plugin');

  // Selecting Conductor while inside a plugin view delegates to the exit
  // callback (deterministic — never history.back()).
  select.value = 'conductor';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(exits, 1);
  // Outside the plugin space it's a no-op.
  window.location.hash = '#';
  await window.happyDOM.waitUntilComplete();
  select.value = 'conductor';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(exits, 1);

  // refresh() drops entries that lost their frontend/enabled bit.
  stubPluginsFetch([]);
  await switcher.refresh();
  assert.equal(select.hidden, true);
  assert.equal(h1.hidden, false);
});

test('appSwitcher: a resident plugin\'s option carries the running marker, re-read on render()', async () => {
  const window = makeWindow('http://localhost/#');
  const { select } = buildSwitcherDom(window.document);
  stubPluginsFetch([
    { id: 'live', name: 'Live', navLabel: 'Live', enabled: true, hasFrontend: true },
    { id: 'plain', name: 'Plain', navLabel: 'Plain', enabled: true, hasFrontend: true },
  ]);
  const { installAppSwitcher, RESIDENT_SUFFIX } = await freshImport('appSwitcher.js');
  let ids = ['live'];
  const switcher = installAppSwitcher({ residentIds: () => ids });
  await new Promise(r => setTimeout(r, 0));
  const labels = () => [...select.options].map(o => o.textContent);
  assert.deepEqual(labels(), ['Conductor', `Live${RESIDENT_SUFFIX}`, 'Plain']);
  assert.match(RESIDENT_SUFFIX, /\w/, 'the marker is text, not colour alone');

  // Still just an entry: selecting it navigates as before.
  select.value = 'live';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.location.hash, '#plugin/live/');

  ids = [];
  switcher.render();
  assert.deepEqual(labels(), ['Conductor', 'Live', 'Plain']);
});

test('appSwitcher + pluginView: the marker appears on first entry and clears when reconcile evicts', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  const { select } = buildSwitcherDom(window.document);
  const rows = { ka: kaRow() };
  stubRowsApi(rows, { switcherRows: [{ id: 'ka', name: 'Keep', navLabel: 'Keep', enabled: true, hasFrontend: true }] });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  const { installAppSwitcher, RESIDENT_SUFFIX } = await freshImport('appSwitcher.js');

  // app.js's wiring, authored here (app.js itself cannot be loaded).
  let appSwitcher = null;
  const pluginView = installPluginView({
    onClosed: () => appSwitcher?.sync(),
    onResidentChange: () => appSwitcher?.render(),
  });
  appSwitcher = installAppSwitcher({ residentIds: () => pluginView.residentIds() });
  await appSwitcher.refresh();
  const label = () => select.querySelector('option[value="ka"]').textContent;
  assert.equal(label(), 'Keep');

  window.location.hash = '#plugin/ka/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(label(), `Keep${RESIDENT_SUFFIX}`, 'marked once the frame is resident');

  window.location.hash = '#';
  await window.happyDOM.waitUntilComplete();
  assert.equal(label(), `Keep${RESIDENT_SUFFIX}`, 'still marked while hidden');

  rows.ka = kaRow({ enabled: false, state: 'disabled' });
  await pluginView.reconcile();
  assert.equal(label(), 'Keep', 'eviction clears the marker');
});

// ── app.js wiring: onPluginsChanged, lifted from the real source ──────────
// app.js cannot be imported (it wires the whole page at load), so its
// `onPluginsChanged:` handler — the one installSettings calls after every
// Settings → Plugins action — is sliced out of the source and run against the
// REAL pluginView + appSwitcher, as tests/app-refresh-projects-wiring.test.mjs
// does for refreshProjects().
async function loadAppOnPluginsChanged() {
  const src = await fs.readFile(path.join(PUB, 'app.js'), 'utf8');
  const hits = [...src.matchAll(/^\s*onPluginsChanged:\s*(.+?),\s*$/gm)];
  assert.equal(hits.length, 1, 'app.js\'s single-line `onPluginsChanged:` handler was renamed, reshaped or duplicated; update this slice');
  return new Function('appSwitcher', 'pluginView', `return (${hits[0][1]});`);
}

test('app.js onPluginsChanged: a Settings action\'s change reaches reconcile and evicts only the plugin it names', async (t) => {
  for (const [label, ids, evicted] of [['naming ka', ['ka'], true], ['naming another plugin', ['other'], false]]) {
    await t.test(label, async () => {
      const { go, residentOf, pv, window } = await setupKeepAlive({ ka: kaRow() });
      buildSwitcherDom(window.document);
      const { installAppSwitcher } = await freshImport('appSwitcher.js');
      const appSwitcher = installAppSwitcher({ residentIds: () => pv.residentIds() });
      const onPluginsChanged = (await loadAppOnPluginsChanged())(appSwitcher, pv);
      await go('#plugin/ka/');
      const frame = residentOf('ka');
      await go('#settings');

      onPluginsChanged({ action: 'restart', ids });
      await tick();
      assert.equal(frame.isConnected, !evicted);
      assert.deepEqual(pv.residentIds(), evicted ? [] : ['ka']);
    });
  }
});

// ── app.js wiring: switcher selection after a round-trip ──────────────────
// app.js wires `installPluginView({ onClosed: () => appSwitcher.sync() })`.
// Extracting that bootstrap into a testable module is out of scope, so these
// tests wire the two REAL modules together and pin the contract app.js's
// callbacks rely on: close() fires onClosed, onClosed runs sync(), and
// sync() re-selects from whatever location.hash is LIVE at that moment — so
// a caller that has already moved the hash off '#plugin/…' lands on
// Conductor. The tests author their own callbacks, which means app.js's
// statement order at each call site (hash write before close()) is NOT
// exercised here.

test('appSwitcher + pluginView: after the hash moves to a session anchor, close() → onClosed → sync() re-syncs to Conductor, not the stale plugin', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  const { select } = buildSwitcherDom(window.document);
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  const { installAppSwitcher } = await freshImport('appSwitcher.js');

  let appSwitcher = null;
  const pluginView = installPluginView({ onClosed: () => appSwitcher?.sync() });
  appSwitcher = installAppSwitcher({
    onExitToConductor: () => {
      // Test-authored callback: the hash write before close() is this test's
      // setup, not app.js's statement order (which stays unexercised here).
      // What runs for real is the module chain — close() → onClosed →
      // sync(), with sync() reading the live hash.
      window.history.replaceState(null, '', '/#session=abc123');
      pluginView.close();
    },
  });
  stubPluginsFetch([
    { id: 'fake-plugin', name: 'Fake Plugin', navLabel: 'Fake', enabled: true, hasFrontend: true },
  ]);
  await appSwitcher.refresh();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(select.value, 'fake-plugin', 'sanity: plugin selected while its view is open');

  select.value = 'conductor';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.location.hash, '#session=abc123', 'hash moved off the plugin space before close()');
  assert.equal(select.value, 'conductor', 'switcher reflects Conductor, not the torn-down plugin');
});

test('appSwitcher + pluginView: close() after the hash names Commits re-syncs the switcher to Conductor, not the stale plugin', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  const { select } = buildSwitcherDom(window.document);
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  const { installAppSwitcher } = await freshImport('appSwitcher.js');

  let appSwitcher = null;
  const pluginView = installPluginView({ onClosed: () => appSwitcher?.sync() });
  appSwitcher = installAppSwitcher({ onExitToConductor: () => pluginView.close() });
  stubPluginsFetch([
    { id: 'fake-plugin', name: 'Fake Plugin', navLabel: 'Fake', enabled: true, hasFrontend: true },
  ]);
  await appSwitcher.refresh();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(select.value, 'fake-plugin');

  // Test-authored order (hash write, then close()): app.js's statement order
  // is not what's under test — the real chain close() → onClosed → sync()
  // reading the live hash is.
  window.history.pushState(null, '', '/#commits');
  pluginView.close();
  assert.equal(select.value, 'conductor', 'switcher reflects Conductor once Commits owns the hash');
});

// ── app.js wiring: mobile sidebar collapse on plugin enter/exit ───────────
// app.js routes these navigations through sidebarChrome's REAL
// closeSidebarOnMobile() (public/sidebarChrome.js), which gates
// setSidebarOpen(false) behind the same `(max-width: 720px)` query the CSS
// drawer uses; entering a plugin (pluginView's onShown) and exiting back to
// Conductor (onExitToConductor) are two of its call sites. These tests drive
// that real module — installed via installSidebarChrome exactly as
// tests/sidebar-chrome.test.mjs does, matchMedia pinned the same way — so
// the actual media-query gate and class mutation execute; what they add
// over sidebar-chrome is the trigger timing: plugin entry, a direct
// plugin→plugin switch, and exit to Conductor.
function buildSidebarDom(document) {
  const mk = (tag, id) => { const el = document.createElement(tag); if (id) el.id = id; return el; };
  const dom = {
    sidebar: mk('aside', 'sidebar'),
    sidebarScrim: mk('div', 'sidebar-scrim'),
    sidebarToggle: mk('button', 'sidebar-toggle'),
    sidebarOverflowToggle: mk('button', 'sidebar-overflow-toggle'),
    sidebarOverflowPanel: mk('div', 'sidebar-overflow-panel'),
    // No sidebarResizeHandle: sidebarChrome guards on it, and the drag
    // gesture is explicitly unpinned (see tests/sidebar-chrome.test.mjs).
  };
  document.body.append(dom.sidebar, dom.sidebarScrim, dom.sidebarToggle,
    dom.sidebarOverflowToggle, dom.sidebarOverflowPanel);
  return dom;
}
async function wireSidebarMobileGate(window, dom, { mobile }) {
  window.matchMedia = (q) => ({ matches: mobile && q === '(max-width: 720px)', media: q });
  const { installSidebarChrome } = await freshImport('sidebarChrome.js');
  return installSidebarChrome({ dom });
}

test('appSwitcher + pluginView: entering a plugin collapses the mobile drawer', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  buildSwitcherDom(window.document);
  const dom = buildSidebarDom(window.document);
  const sidebar = dom.sidebar;
  sidebar.classList.add('open'); // drawer open before the switch
  const { closeSidebarOnMobile } = await wireSidebarMobileGate(window, dom, { mobile: true });
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView({ onShown: () => closeSidebarOnMobile() });

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sidebar.classList.contains('open'), false, 'mobile drawer collapses to reveal the plugin');
});

test('appSwitcher + pluginView: entering a plugin leaves the desktop sidebar open', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  buildSwitcherDom(window.document);
  const dom = buildSidebarDom(window.document);
  const sidebar = dom.sidebar;
  sidebar.classList.add('open');
  const { closeSidebarOnMobile } = await wireSidebarMobileGate(window, dom, { mobile: false });
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView({ onShown: () => closeSidebarOnMobile() });

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sidebar.classList.contains('open'), true, 'desktop sidebar is untouched — .open has no visual effect above 720px');
});

test('pluginView: switching directly from one plugin to another collapses the mobile drawer', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  buildSwitcherDom(window.document);
  const dom = buildSidebarDom(window.document);
  const sidebar = dom.sidebar;
  const { closeSidebarOnMobile } = await wireSidebarMobileGate(window, dom, { mobile: true });
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView({ onShown: () => closeSidebarOnMobile() });

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(sidebar.classList.contains('open'), false, 'sanity: drawer collapsed on entry');

  sidebar.classList.add('open'); // simulate the user reopening the drawer while viewing the plugin
  window.location.hash = '#plugin/other/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(sidebar.classList.contains('open'), false, 'mobile drawer collapses on a direct plugin-to-plugin switch too');
});

test('pluginView: switching directly from one plugin to another leaves the desktop sidebar open', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  buildSwitcherDom(window.document);
  const dom = buildSidebarDom(window.document);
  const sidebar = dom.sidebar;
  sidebar.classList.add('open');
  const { closeSidebarOnMobile } = await wireSidebarMobileGate(window, dom, { mobile: false });
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView({ onShown: () => closeSidebarOnMobile() });

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  window.location.hash = '#plugin/other/';
  await window.happyDOM.waitUntilComplete();
  await tick();
  assert.equal(sidebar.classList.contains('open'), true, 'desktop sidebar is untouched on a plugin-to-plugin switch');
});

test('appSwitcher + pluginView: returning to Conductor collapses the mobile drawer too', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  const { select } = buildSwitcherDom(window.document);
  const dom = buildSidebarDom(window.document);
  const sidebar = dom.sidebar;
  const { closeSidebarOnMobile } = await wireSidebarMobileGate(window, dom, { mobile: true });
  stubPluginViewApi({ state: 'ready' });
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  const { installAppSwitcher } = await freshImport('appSwitcher.js');

  let appSwitcher = null;
  const pluginView = installPluginView({
    onClosed: () => appSwitcher?.sync(),
    onShown: () => closeSidebarOnMobile(),
  });
  appSwitcher = installAppSwitcher({
    onExitToConductor: () => {
      window.history.replaceState(null, '', '/#session=abc123');
      pluginView.close();
      closeSidebarOnMobile();
    },
  });
  stubPluginsFetch([
    { id: 'fake-plugin', name: 'Fake Plugin', navLabel: 'Fake', enabled: true, hasFrontend: true },
  ]);
  await appSwitcher.refresh();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  await new Promise(r => setTimeout(r, 0));
  sidebar.classList.add('open'); // simulate the user re-opening the drawer while viewing the plugin

  select.value = 'conductor';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(sidebar.classList.contains('open'), false, 'mobile drawer collapses to reveal the conductor view');
});

// ── new-project dialog: grouped conventions (with optional scaffold facet) ──
function buildNewProjectDom(document) {
  const mk = (tag, id) => { const el = document.createElement(tag); if (id) el.id = id; return el; };
  const dialog = mk('dialog', 'new-project-dialog');
  const form = mk('form', 'np-form');
  const confirm = mk('form', 'np-confirm'); confirm.hidden = true;
  const scaffoldText = mk('textarea', 'np-scaffold-text');
  const contributions = mk('div', 'np-contributions');
  const name = mk('input', 'np-name');
  const preview = mk('code', 'np-preview');
  const error = mk('p', 'np-error');
  const btn = mk('button', 'np-btn');
  form.append(name, preview, contributions, error);
  confirm.append(scaffoldText);
  dialog.append(form, confirm);
  document.body.append(dialog, btn);
  // happy-dom lacks a full modal impl in some versions — make showModal a no-op.
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  return {
    newProjectBtn: btn, newProjectDialog: dialog, npName: name, npError: error,
    npPreview: preview, npContributions: contributions, npForm: form,
    npConfirm: confirm, npScaffoldText: scaffoldText,
  };
}

test('new-project dialog groups core conventions + per-plugin conventions as plain individually-selectable checkboxes', async () => {
  const window = makeWindow();
  const dom = buildNewProjectDom(window.document);
  const created = [];
  const routes = {
    '/api/settings/conventions/project': { conventions: [
      { slug: 'design-guidelines', name: 'Design guidelines', description: 'core', builtin: true },
      // A plugin convention carrying a scaffold facet: catalog entry exposes the
      // resolved directive text under `scaffold`.
      { slug: 'playwright-harness/vis-check', name: 'Visual check', description: 'verify UX', plugin: 'playwright-harness', builtin: false, scaffold: 'Build a harness wrapper' },
      // A plugin convention without a scaffold facet.
      { slug: 'playwright-harness/plain', name: 'Plain', description: 'fragment only', plugin: 'playwright-harness', builtin: false },
    ] },
  };
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/projects' && opts?.method === 'POST') {
      created.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ name: 'x', scaffold: 'Build a harness wrapper' }) };
    }
    return { ok: true, json: async () => routes[url] ?? {} };
  };

  const { installNewProjectDialog } = await freshImport('newProjectDialog.js');
  installNewProjectDialog({ dom, refreshProjects: async () => {}, closeSidebarOverflow: () => {} });

  dom.newProjectBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  // Await the async open handler's fetch.
  for (let i = 0; i < 10 && dom.npContributions.children.length === 0; i++) await new Promise(r => setTimeout(r, 5));

  // Plain text headings only — no interactive master toggle anywhere.
  const labels = [...dom.npContributions.querySelectorAll('.np-rules-label')].map(e => e.textContent);
  assert.ok(labels.some(t => /Project conventions/.test(t)), 'core conventions section rendered');
  assert.ok(labels.some(t => /playwright-harness/.test(t)), 'per-plugin heading rendered for provenance');
  assertNull(dom.npContributions.querySelector('.np-group-master'), 'no master toggle checkbox');
  assertNull(dom.npContributions.querySelector('.np-group-head'), 'no master toggle heading');

  // Core convention checkbox present.
  const core = dom.npContributions.querySelector('input[data-kind="convention"][value="design-guidelines"]');
  assert.ok(core, 'core convention checkbox rendered');
  // One plain checkbox per plugin convention (no separate scaffold kind).
  const pluginConv = dom.npContributions.querySelector('input[data-kind="convention"][value="playwright-harness/vis-check"]');
  const plainConv = dom.npContributions.querySelector('input[data-kind="convention"][value="playwright-harness/plain"]');
  assert.ok(pluginConv, 'plugin convention checkbox rendered');
  assert.ok(plainConv, 'plain plugin convention checkbox rendered');
  assertNull(dom.npContributions.querySelector('input[data-kind="scaffold"]'), 'no separate scaffold checkboxes');

  // No "sets up" tag anywhere — the scaffold facet rides along invisibly.
  assertNull(dom.npContributions.querySelector('.np-rule-tag'), 'no "sets up" tag rendered');
  assert.ok(![...dom.npContributions.querySelectorAll('.np-rule-name')].some(e => /sets up/.test(e.textContent)), 'no "sets up" text anywhere');

  // Each checkbox is independently selectable — no all-or-nothing coupling.
  pluginConv.checked = true;
  assert.equal(plainConv.checked, false, 'selecting one plugin convention does not select its sibling');

  // Submit: only `conventions` is sent (no `scaffolds` param); the picked
  // scaffold-bearing convention still surfaces the returned scaffold panel.
  core.checked = true;
  dom.npName.value = 'myproj';
  dom.newProjectDialog.returnValue = 'create';
  dom.newProjectDialog.dispatchEvent(new window.Event('close', { bubbles: true }));
  for (let i = 0; i < 10 && created.length === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(created.length, 1);
  assert.equal(created[0].scaffolds, undefined, 'no scaffolds param in the POST body');
  assert.deepEqual([...created[0].conventions].sort(), ['design-guidelines', 'playwright-harness/vis-check']);

  // The returned scaffold directive shows in the read-only confirmation panel.
  for (let i = 0; i < 10 && dom.npConfirm.hidden; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(dom.npConfirm.hidden, false, 'confirmation panel shown for a scaffold-bearing pick');
  assert.equal(dom.npScaffoldText.value, 'Build a harness wrapper');
});
