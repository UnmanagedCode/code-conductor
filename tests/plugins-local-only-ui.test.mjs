// BUCKET 3 ON THE PAGE: a plugin whose project lives on another system.
//
// The server refuses PLUGIN_BACKEND_LOCAL_ONLY and never contributes a
// PLUGIN_DIR_LOCAL_ONLY `--plugin-dir` root. The rule the design states is that
// a clean refusal beats a half-feature, and half of that rule is the UI's: the
// control that can only refuse is HIDDEN, and the row says why instead. A Start
// button that always 501s teaches the user nothing except that cc is broken.
//
// The row's `localOnly` codes are what the page reads — the same codes the
// server returns — so the two cannot drift into disagreeing about which
// capabilities are off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const row = (over = {}) => ({
  id: 'plug', name: 'Plug', project: 'proj', version: '1.0.0',
  state: 'stopped', enabled: true, activeVersion: { type: 'main' },
  manifestSource: { type: 'main' }, hasBackend: true, hasFrontend: false,
  navLabel: null, frontendPath: null, hasMcp: false, conventions: [], roles: [],
  port: null, pid: null, startedAt: null, gitHead: null, stale: false,
  errors: [], crashTail: null, system: 'local', localOnly: [],
  ...over,
});

// Renders the Plugins group against a stubbed GET /api/plugins, and hands back
// the list element the page built.
async function renderPlugins(rows) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  globalThis.fetch = async (url) => {
    const body = url.includes('/api/plugins/library') ? { rows: [] }
      : url.includes('/api/plugins') ? { rows, notices: [] }
      : url.includes('/api/projects') ? []
      : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  document.body.innerHTML = `
    <div id="pl-status"></div><ul id="pl-list"></ul>
    <button id="pl-rescan-btn"></button>
    <div id="pll-status"></div><ul id="pll-list"></ul>
    <div id="pll-tail" hidden><pre id="pll-tail-pre"></pre></div>`;
  const { installPluginManager } = await import(
    pathToFileURL(path.join(PUB, 'pluginManager.js')).href + `?t=${Math.random()}`);
  const mgr = installPluginManager({});
  await mgr.load();
  await new Promise(r => setTimeout(r, 0));
  return document.getElementById('pl-list');
}

const labels = (list) => [...list.querySelectorAll('button')].map(b => b.textContent);

// PINS: the baseline — a local plugin still offers Start, so the assertions
// below are a difference, not an artefact of the harness.
test('a local plugin still offers Start', async () => {
  const list = await renderPlugins([row()]);
  assert.ok(labels(list).includes('Start'));
  assert.equal(list.querySelectorAll('.pl-local-only').length, 0);
});

// PINS: the backend control is hidden for a remote project, and the reason
// names the code the server would have returned.
test('a remote plugin hides Start and says the backend is local-only', async () => {
  const list = await renderPlugins([row({
    system: 'prod-box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY'],
  })]);
  assert.ok(!labels(list).includes('Start'), 'no control that could only refuse');
  const note = list.querySelector('.pl-local-only');
  assert.ok(note, 'the row explains itself instead');
  assert.match(note.textContent, /PLUGIN_BACKEND_LOCAL_ONLY/);
  assert.match(note.textContent, /prod-box/, 'naming the system, so the user knows which project to move');
  assert.ok(labels(list).includes('Disable'), 'the plugin can still be disabled');
});

// PINS: the `--plugin-dir` contribution has its own code and its own line, so a
// plugin declaring both is told about both rather than about the first.
test('both local-only codes are reported when the manifest declares both', async () => {
  const list = await renderPlugins([row({
    system: 'prod-box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY', 'PLUGIN_DIR_LOCAL_ONLY'],
  })]);
  const note = list.querySelector('.pl-local-only');
  assert.match(note.textContent, /PLUGIN_BACKEND_LOCAL_ONLY/);
  assert.match(note.textContent, /PLUGIN_DIR_LOCAL_ONLY/);
});

// PINS: a plugin on a remote system that declares NEITHER local-only capability
// — a conventions-only plugin — is not marked and keeps every control it had.
// Its fragments are text, read through the System like any other project file.
test('a conventions-only plugin on a system is not marked local-only', async () => {
  const list = await renderPlugins([row({
    system: 'prod-box', localOnly: [], hasBackend: false,
  })]);
  assert.equal(list.querySelectorAll('.pl-local-only').length, 0);
  assert.ok(labels(list).includes('Disable'));
});
