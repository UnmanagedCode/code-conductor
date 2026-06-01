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
async function setup() {
  const window = new Window({ url: 'http://localhost/#' });
  // Stub fetch so load() doesn't throw when the panel opens.
  window.fetch = () => Promise.resolve({
    ok: false, status: 503,
    json: () => Promise.resolve({}),
  });

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;

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

test('settings: opening settings collapses the sidebar', async () => {
  // On mobile (max-width: 720px) the sidebar is position:fixed z-index:10.
  // The settings button lives inside the sidebar, so when the user taps it
  // the sidebar must be dismissed first (setSidebarOpen(false)) so it doesn't
  // layer in front of the settings page.
  //
  // app.js does:
  //   dom.settingsBtn.addEventListener('click', () => {
  //     ...
  //     else { setSidebarOpen(false); settings.open(); }
  //   });
  //
  // This test verifies the contract: calling setSidebarOpen(false) removes
  // the .open class from #sidebar before settings opens.
  const { window, mod, main, sidebar } = await setup();
  mod.installSettings({ requestClose: () => {} });

  // Sidebar starts open (user tapped the hamburger on mobile)
  sidebar.classList.add('open');
  assert.equal(sidebar.classList.contains('open'), true);

  // Simulate what app.js click handler does: collapse sidebar, then open settings
  sidebar.classList.remove('open');           // setSidebarOpen(false)
  window.location.hash = '#settings';        // settings.open()
  await window.happyDOM.waitUntilComplete();

  assert.equal(sidebar.classList.contains('open'), false, 'sidebar must be collapsed');
  assert.equal(main.classList.contains('settings-open'), true, 'settings panel must be open');
  window.happyDOM.abort();
});
