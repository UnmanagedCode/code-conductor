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
// check. `updateAvailable` mirrors library.ts's list() ahead/behind check.
function stubPluginManagerFetch({
  initiallyInstalled = false, updateAvailable = true,
  installResult, installPostClone = null, updateResult, updatePostPull = null, updateRestarted = null,
} = {}) {
  const calls = [];
  let installed = initiallyInstalled;
  globalThis.fetch = (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/plugins') return Promise.resolve({ ok: true, json: async () => ({ rows: [], notices: [] }) });
    if (url === '/api/projects') return Promise.resolve({ ok: true, json: async () => [] });
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
        { type: 'result', ok: true, result: { id: 'code-share', name: 'code-share', postPull: updatePostPull, restarted: updateRestarted } },
      ]));
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
  return calls;
}

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
        entries: [], skipped: [{ file: 'broken.json', reason: 'unexpected token' }],
      }) });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  };
  const { installPluginManager } = await freshImport('pluginManager.js');
  await installPluginManager().load();

  assert.match(dom.libStatus.textContent, /broken\.json/, 'the offending drop-in is named');
  assert.match(dom.libStatus.textContent, /unexpected token/, 'the reason is shown');
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

test('appSwitcher + pluginView: after the hash moves to Commits, close() → onClosed → sync() re-syncs to Conductor, not the stale plugin', async () => {
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
