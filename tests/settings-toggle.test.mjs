// Tests for settings panel open/close toggle behavior.
// Uses happy-dom to drive the DOM; settings.js is loaded fresh per test
// (cache-busted URL) so module-level state doesn't leak between tests.
//
// Note: happy-dom fires hashchange asynchronously, so each hash-set is
// followed by `await window.happyDOM.waitUntilComplete()`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildDOM(document) {
  const main = document.createElement('div');
  main.id = 'main';

  const view = document.createElement('section');
  view.id = 'settings-view';
  view.hidden = true;

  const groupSelect = document.createElement('select');
  groupSelect.id = 'settings-group-select';
  for (const val of ['transcribe', 'models', 'tts']) {
    const opt = document.createElement('option');
    opt.value = val;
    groupSelect.appendChild(opt);
  }
  view.appendChild(groupSelect);

  // Group panels — must exist before installSettings() so they're captured in groups[].
  for (const g of ['transcribe', 'models', 'tts']) {
    const panel = document.createElement('div');
    panel.id = `settings-${g}`;
    panel.className = 'settings-group';
    panel.hidden = g !== 'transcribe';
    view.appendChild(panel);
  }

  for (const [id, tag] of [
    ['st-status', 'div'], ['st-model-list', 'ul'],
    ['st-install-btn', 'button'], ['st-action-hint', 'span'], ['st-install-log', 'pre'],
  ]) {
    const el = document.createElement(tag);
    el.id = id;
    if (id === 'st-install-btn' || id === 'st-install-log') el.hidden = true;
    view.appendChild(el);
  }

  // Plugins group DOM — `pl-list` must exist or installPluginManager() no-ops
  // entirely (see public/pluginManager.js). Mirrors buildPluginManagerDom in
  // tests/plugins-frontend.test.mjs.
  for (const [id, tag] of [
    ['pl-status', 'div'], ['pl-list', 'ul'], ['pl-rescan-btn', 'button'],
    ['pll-status', 'div'], ['pll-list', 'ul'],
  ]) {
    const el = document.createElement(tag);
    el.id = id;
    view.appendChild(el);
  }
  const pllTail = document.createElement('details');
  pllTail.id = 'pll-tail';
  pllTail.hidden = true;
  const pllTailPre = document.createElement('pre');
  pllTailPre.id = 'pll-tail-pre';
  pllTail.appendChild(pllTailPre);
  view.appendChild(pllTail);

  main.appendChild(view);

  const sidebar = document.createElement('aside');
  sidebar.id = 'sidebar';
  const settingsBtn = document.createElement('button');
  settingsBtn.id = 'settings-btn';
  sidebar.appendChild(settingsBtn);

  document.body.appendChild(sidebar);
  document.body.appendChild(main);
  return { main, view, groupSelect, settingsBtn, sidebar };
}

let counter = 0;
async function setup(fetchImpl) {
  const window = new Window({ url: 'http://localhost/#' });
  // Stub fetch so load() doesn't throw when the panel opens.
  window.fetch = fetchImpl || (() => Promise.resolve({
    ok: false, status: 503,
    json: () => Promise.resolve({}),
  }));

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  // settings.js calls the ambient `fetch` global (module scope, not
  // window-scoped), so it must be stubbed on globalThis too.
  globalThis.fetch = window.fetch;

  const dom = buildDOM(window.document);

  // Cache-bust to get a fresh module instance per test.
  const url = pathToFileURL(
    path.resolve(__dirname, '..', 'public', 'settings.js'),
  ).href + '?t=' + (++counter);
  const mod = await import(url);
  return { window, mod, ...dom };
}

function click(node, win) {
  node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

// ── basic open / close ────────────────────────────────────────────────────────

test('settings: open() shows panel and adds settings-open class', async () => {
  const { window, mod, main, view } = await setup();
  const s = mod.installSettings({ requestClose: () => {} });

  s.open();
  await window.happyDOM.waitUntilComplete();

  assert.equal(main.classList.contains('settings-open'), true);
  assert.equal(view.hidden, false);
  window.happyDOM.abort();
});

test('settings: close() hides panel and removes settings-open class', async () => {
  const { window, mod, main, view } = await setup();
  let closed = false;
  const s = mod.installSettings({ requestClose: () => { closed = true; } });

  s.open();
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false, 'panel should be open after open()');

  s.close();
  assert.equal(main.classList.contains('settings-open'), false);
  assert.equal(view.hidden, true);
  assert.equal(closed, true, 'requestClose should be called');
  window.happyDOM.abort();
});

test('settings: group select switches visible panel', async () => {
  const { window, mod, groupSelect } = await setup();
  const s = mod.installSettings({ requestClose: () => {} });

  s.open();
  await window.happyDOM.waitUntilComplete();

  groupSelect.value = 'models';
  groupSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.getElementById('settings-models').hidden, false);
  assert.equal(window.document.getElementById('settings-transcribe').hidden, true);
  window.happyDOM.abort();
});

test('settings: Escape key closes panel', async () => {
  const { window, mod, main, view } = await setup();
  const s = mod.installSettings({ requestClose: () => {} });

  s.open();
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false);

  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(main.classList.contains('settings-open'), false);
  assert.equal(view.hidden, true);
  window.happyDOM.abort();
});

// ── hash-drift resilience ────────────────────────────────────────────────────

test('settings: close() hides panel even when hash drifted via replaceState', async () => {
  // When selectInstance() calls writeSessionAnchor() while settings is open,
  // it uses history.replaceState (no hashchange event). The hash drifts from
  // '#settings' to '#session=...' but isOpen remains true. Calling close()
  // must still hide the panel regardless of hash state.
  const { window, mod, main, view } = await setup();
  const s = mod.installSettings({ requestClose: () => {} });

  s.open();
  await window.happyDOM.waitUntilComplete();
  assert.equal(view.hidden, false, 'panel should be open');

  // Simulate selectInstance → writeSessionAnchor via replaceState (no hashchange)
  window.history.replaceState(null, '', '/#session=abc123');
  assert.notEqual(window.location.hash, '#settings', 'hash has drifted');
  assert.equal(view.hidden, false, 'panel still visible after replaceState');

  // close() must hide the panel even though hash is no longer '#settings'
  s.close();
  assert.equal(main.classList.contains('settings-open'), false);
  assert.equal(view.hidden, true, 'panel must close via close()');
  window.happyDOM.abort();
});

// ── sidebar collapse on open ─────────────────────────────────────────────────

// app.js does:
//   dom.settingsBtn.addEventListener('click', () => {
//     ...
//     else { closeSidebarOnMobile(); settings.open(); }
//   });
// where closeSidebarOnMobile() only calls setSidebarOpen(false) when
// `window.matchMedia('(max-width: 720px)').matches` — above that breakpoint
// '.open' has no visual effect (styles.css gates the drawer transform to the
// same query) so the sidebar must be left untouched. These tests mirror that
// exact helper (not the pre-fix unconditional call) to verify both branches.
function closeSidebarOnMobile(window, sidebar) {
  if (window.matchMedia('(max-width: 720px)').matches) sidebar.classList.remove('open');
}

test('settings: opening settings collapses the sidebar on mobile', async () => {
  const { window, mod, main, sidebar } = await setup();
  mod.installSettings({ requestClose: () => {} });
  window.matchMedia = () => ({ matches: true });

  // Sidebar starts open (user tapped the hamburger on mobile)
  sidebar.classList.add('open');
  assert.equal(sidebar.classList.contains('open'), true);

  // Simulate what app.js click handler does: collapse sidebar, then open settings
  closeSidebarOnMobile(window, sidebar);
  window.location.hash = '#settings';        // settings.open()
  await window.happyDOM.waitUntilComplete();

  assert.equal(sidebar.classList.contains('open'), false, 'sidebar must be collapsed');
  assert.equal(main.classList.contains('settings-open'), true, 'settings panel must be open');
  window.happyDOM.abort();
});

test('settings: opening settings on desktop leaves the always-visible sidebar column alone', async () => {
  const { window, mod, main, sidebar } = await setup();
  mod.installSettings({ requestClose: () => {} });
  window.matchMedia = () => ({ matches: false });

  // Desktop sidebar isn't a drawer — '.open' shouldn't even be present, but
  // if it were, closeSidebarOnMobile() must not touch it above the breakpoint.
  sidebar.classList.add('open');

  closeSidebarOnMobile(window, sidebar);
  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();

  assert.equal(sidebar.classList.contains('open'), true, 'desktop sidebar must be untouched');
  assert.equal(main.classList.contains('settings-open'), true, 'settings panel must still open');
  window.happyDOM.abort();
});

// ── plugin catalog change refreshes the conventions panels ──────────────────
// Regression test: enabling a plugin used to leave the Conductor/Workspace/
// Project conventions panels stale until Settings was reopened. Drives the
// real Enable button (not a stubbed shortcut) and asserts the fix by counting
// refetches of each convention endpoint.

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function stubCatalogChangeFetch() {
  const counts = {};
  const bump = (url) => { counts[url] = (counts[url] || 0) + 1; };
  const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const notFound = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });

  const impl = (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'GET') bump(url);
    if (url === '/api/plugins') {
      return ok([{
        id: 'demo', name: 'Demo', project: 'demoproj', state: 'disabled',
        enabled: false, hasBackend: false, conventions: [],
      }]);
    }
    if (url === '/api/projects') return ok([]);
    if (url === '/api/plugins/library') return ok([]);
    if (url === '/api/plugins/demo/enable' && method === 'POST') return ok({});
    if (url === '/api/settings/conductor-modules') return ok({});
    if (url === '/api/settings/workspace-conventions') return ok({});
    if (url === '/api/settings/project-conventions') return ok({});
    return notFound();
  };
  return { impl, counts };
}

test('settings: enabling a plugin refreshes the conductor/workspace/project conventions panels', async () => {
  const { impl, counts } = stubCatalogChangeFetch();
  const { window, mod, view } = await setup(impl);
  let externalCalled = 0;
  mod.installSettings({ requestClose: () => {}, onPluginsChanged: () => { externalCalled++; } });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const before = {
    conductor: counts['/api/settings/conductor-modules'] || 0,
    workspace: counts['/api/settings/workspace-conventions'] || 0,
    project: counts['/api/settings/project-conventions'] || 0,
  };
  assert.equal(before.conductor, 1, 'sanity: conductor panel loaded once on open');
  assert.equal(before.workspace, 1, 'sanity: workspace panel loaded once on open');
  assert.equal(before.project, 1, 'sanity: project panel loaded once on open');

  const enableBtn = [...view.querySelectorAll('#pl-list button')].find(b => b.textContent === 'Enable');
  assert.ok(enableBtn, 'Enable button rendered for the disabled plugin');
  click(enableBtn, window);
  await tick(20);

  assert.equal(counts['/api/settings/conductor-modules'], before.conductor + 1, 'conductor panel refetched after enable');
  assert.equal(counts['/api/settings/workspace-conventions'], before.workspace + 1, 'workspace panel refetched after enable');
  assert.equal(counts['/api/settings/project-conventions'], before.project + 1, 'project panel refetched after enable');
  assert.equal(externalCalled, 1, 'existing onPluginsChanged hook still fires');
  window.happyDOM.abort();
});
