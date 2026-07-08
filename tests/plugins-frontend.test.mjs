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

test('pluginView: opens on #plugin hash, swaps plugins, avoids reload on subpath, teardown blanks', async () => {
  const window = makeWindow('http://localhost/#');
  const { view } = buildViewDom(window.document);
  await freshImport('hashView.js');
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView();

  window.location.hash = '#plugin/fake-plugin/';
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false);
  const iframe = window.document.getElementById('plugin-frame');
  assert.ok(iframe, 'iframe created on demand');
  assert.match(iframe.getAttribute('src'), /^\/plugins\/fake-plugin\/$/);

  // Subpath change within the same plugin: steer via bridge, no src reload.
  window.location.hash = '#plugin/fake-plugin/sub';
  await window.happyDOM.waitUntilComplete();
  assert.match(iframe.getAttribute('src'), /^\/plugins\/fake-plugin\/$/, 'src untouched on subpath change');

  // Different plugin: reload.
  window.location.hash = '#plugin/other/';
  await window.happyDOM.waitUntilComplete();
  assert.match(iframe.getAttribute('src'), /^\/plugins\/other\/$/);

  // Leaving the space: teardown blanks the iframe and hides the view.
  window.location.hash = '#';
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, true);
  assert.equal(iframe.getAttribute('src'), 'about:blank');
});

test('pluginView: boot directly on a plugin hash opens the view', async () => {
  const window = makeWindow('http://localhost/#plugin/fake-plugin/dashboard');
  const { view } = buildViewDom(window.document);
  const { installPluginView } = await freshImport('pluginView.js');
  installPluginView();
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false);
  assert.match(window.document.getElementById('plugin-frame').getAttribute('src'),
    /^\/plugins\/fake-plugin\/dashboard$/);
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
  const switcher = installAppSwitcher();
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

  // refresh() drops entries that lost their frontend/enabled bit.
  stubPluginsFetch([]);
  await switcher.refresh();
  assert.equal(select.hidden, true);
  assert.equal(h1.hidden, false);
});
