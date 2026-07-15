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
  group.append(status, list, rescan, libStatus, libList, tail);
  document.body.appendChild(group);
  return { status, list, rescan, libStatus, libList, tail, tailPre };
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
// check. `updateAvailable` mirrors library.js's list() ahead/behind check.
function stubPluginManagerFetch({
  initiallyInstalled = false, updateAvailable = true,
  installResult, installPostClone = null, updateResult, updatePostPull = null,
} = {}) {
  const calls = [];
  let installed = initiallyInstalled;
  globalThis.fetch = (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/plugins') return Promise.resolve({ ok: true, json: async () => [] });
    if (url === '/api/projects') return Promise.resolve({ ok: true, json: async () => [] });
    if (url === '/api/plugins/library') {
      return Promise.resolve({ ok: true, json: async () => ([{
        id: 'code-share', name: 'Code Share', description: 'Share code snippets.',
        repo: 'https://github.com/UnmanagedCode/code-share', installed, installedAs: installed ? 'code-share' : null,
        updateAvailable: installed && updateAvailable, behind: installed && updateAvailable ? 1 : 0,
      }]) });
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
        { type: 'result', ok: true, result: { id: 'code-share', name: 'code-share', postPull: updatePostPull } },
      ]));
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
  return calls;
}

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
});

test('pluginManager: empty library renders the empty-state message', async () => {
  const window = makeWindow();
  const dom = buildPluginManagerDom(window.document);
  globalThis.fetch = (url) => {
    if (url === '/api/plugins/library') return Promise.resolve({ ok: true, json: async () => [] });
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

// ── app.js wiring: mobile sidebar collapse on plugin enter/exit ───────────
// app.js's closeSidebarOnMobile() gates setSidebarOpen(false) behind the
// same `(max-width: 720px)` query the CSS drawer uses; entering a plugin
// (pluginView's onShown) and exiting back to Conductor (onExitToConductor)
// both call it so the drawer reveals the destination view on mobile, while
// leaving the always-visible desktop column untouched. Mirrors app.js's own
// setSidebarOpen/closeSidebarOnMobile exactly (not a divergent stub) so the
// test proves the real contract, not a stand-in for it.
function buildSidebarDom(document) {
  const sidebar = document.createElement('aside');
  sidebar.id = 'sidebar';
  document.body.appendChild(sidebar);
  return sidebar;
}
function wireSidebarMobileGate(window, sidebar, { mobile }) {
  window.matchMedia = () => ({ matches: mobile });
  function setSidebarOpen(open) { sidebar.classList.toggle('open', open); }
  function closeSidebarOnMobile() {
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
  }
  return { setSidebarOpen, closeSidebarOnMobile };
}

test('appSwitcher + pluginView: entering a plugin collapses the mobile drawer', async () => {
  const window = makeWindow('http://localhost/#');
  buildViewDom(window.document);
  buildSwitcherDom(window.document);
  const sidebar = buildSidebarDom(window.document);
  sidebar.classList.add('open'); // drawer open before the switch
  const { closeSidebarOnMobile } = wireSidebarMobileGate(window, sidebar, { mobile: true });
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
  const sidebar = buildSidebarDom(window.document);
  sidebar.classList.add('open');
  const { closeSidebarOnMobile } = wireSidebarMobileGate(window, sidebar, { mobile: false });
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
  const sidebar = buildSidebarDom(window.document);
  const { closeSidebarOnMobile } = wireSidebarMobileGate(window, sidebar, { mobile: true });
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
  const sidebar = buildSidebarDom(window.document);
  sidebar.classList.add('open');
  const { closeSidebarOnMobile } = wireSidebarMobileGate(window, sidebar, { mobile: false });
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
  const sidebar = buildSidebarDom(window.document);
  const { closeSidebarOnMobile } = wireSidebarMobileGate(window, sidebar, { mobile: true });
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
    '/api/settings/project-conventions': { rules: [
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
  assert.equal(dom.npContributions.querySelector('.np-group-master'), null, 'no master toggle checkbox');
  assert.equal(dom.npContributions.querySelector('.np-group-head'), null, 'no master toggle heading');

  // Core convention checkbox present.
  const core = dom.npContributions.querySelector('input[data-kind="convention"][value="design-guidelines"]');
  assert.ok(core, 'core convention checkbox rendered');
  // One plain checkbox per plugin convention (no separate scaffold kind).
  const pluginConv = dom.npContributions.querySelector('input[data-kind="convention"][value="playwright-harness/vis-check"]');
  const plainConv = dom.npContributions.querySelector('input[data-kind="convention"][value="playwright-harness/plain"]');
  assert.ok(pluginConv, 'plugin convention checkbox rendered');
  assert.ok(plainConv, 'plain plugin convention checkbox rendered');
  assert.equal(dom.npContributions.querySelector('input[data-kind="scaffold"]'), null, 'no separate scaffold checkboxes');

  // No "sets up" tag anywhere — the scaffold facet rides along invisibly.
  assert.equal(dom.npContributions.querySelector('.np-rule-tag'), null, 'no "sets up" tag rendered');
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
