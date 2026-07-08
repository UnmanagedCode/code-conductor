// Frontend plugin modules: hashView's matchHash predicate + pluginView hash
// space (happy-dom), the pluginBridge script (executed against a scripted
// fake window — it must run as a plain classic script), and the appSwitcher
// dropdown. Modules are cache-bust-imported fresh per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

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
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
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

// ── app.js wiring: switcher selection after a round-trip ──────────────────
// app.js wires `installPluginView({ onClosed: () => appSwitcher.sync() })`
// and every explicit `pluginView.close()` call site (the switcher's own
// Conductor entry, sidebar Commits) must update location.hash BEFORE
// calling close() — otherwise sync() reads the still-stale '#plugin/...'
// hash and re-selects the plugin instead of Conductor. These tests wire the
// two real modules together (not app.js itself, which is DOM/fetch-heavy
// bootstrap) and replay each call site's fixed statement order.

test('appSwitcher + pluginView: exiting to Conductor (replaceState-based) re-syncs to conductor, not the stale plugin', async () => {
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
      // Fixed order (app.js onExitToConductor): write the destination hash
      // FIRST, close() second — matches the writeSessionAnchor/pluginView.close()
      // order in public/app.js.
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
  assert.equal(window.location.hash, '#session=abc123', 'exit path already wrote the destination hash');
  assert.equal(select.value, 'conductor', 'switcher reflects Conductor, not the torn-down plugin');
});

test('appSwitcher + pluginView: opening Commits (pushState-based) while a plugin is active re-syncs to conductor', async () => {
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

  // Fixed order (app.js sidebar.onShowCommits): open Commits (pushState)
  // FIRST, close() second.
  window.history.pushState(null, '', '/#commits');
  pluginView.close();
  assert.equal(select.value, 'conductor', 'switcher reflects Conductor once Commits owns the hash');
});
