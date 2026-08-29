// Settings → Systems, driven through the real public/settings.js with happy-dom.
//
// The panel is a registry card list plus an add/edit form. What is worth pinning
// is what would silently regress:
//   - the built-in `local` row has NO edit and NO Remove affordance, so the
//     server's refusals can never be reached from the UI;
//   - the add/edit form round-trips id+label to the right method and URL;
//   - a 409 on Remove surfaces the server's message VERBATIM (it names the
//     projects still on the system) instead of failing silently, and the row
//     survives.
//
// Mirrors the harness in tests/settings-backends-panel.test.mjs (cache-busted
// import so module-level state doesn't leak between tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOCAL = { id: 'local', label: 'This machine', managed: true, projects: [] };
const PROD = { id: 'prod-box', label: 'Prod box', managed: false, projects: ['shipping'] };

const payload = (systems = [LOCAL, PROD]) => ({ systems });

function buildDOM(document) {
  const main = document.createElement('div');
  main.id = 'main';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.hidden = true;

  const groupSelect = document.createElement('select');
  groupSelect.id = 'settings-group-select';
  for (const val of ['models', 'systems']) {
    const opt = document.createElement('option');
    opt.value = val;
    groupSelect.appendChild(opt);
  }
  view.appendChild(groupSelect);

  for (const g of ['models', 'systems']) {
    const panel = document.createElement('div');
    panel.id = `settings-${g}`;
    panel.className = 'settings-group';
    panel.hidden = g !== 'models';
    view.appendChild(panel);
  }
  const stStatus = document.createElement('div');
  stStatus.id = 'st-status';
  view.appendChild(stStatus);

  view.querySelector('#settings-systems').innerHTML = `
    <div id="sy-status"></div>
    <ul id="sy-list"></ul>
    <fieldset>
      <legend id="sy-form-legend">Add a system</legend>
      <input id="sy-id" type="text" />
      <input id="sy-label" type="text" />
      <button type="button" id="sy-save">Add</button>
      <button type="button" id="sy-cancel" hidden>Cancel</button>
      <div id="sy-form-status"></div>
    </fieldset>
  `;

  main.appendChild(view);
  document.body.appendChild(main);
  return { view };
}

let counter = 0;
async function setup(fetchImpl) {
  const window = new Window({ url: 'http://localhost/#' });
  window.fetch = fetchImpl;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.fetch = window.fetch;

  const dom = buildDOM(window.document);
  const url = pathToFileURL(path.resolve(__dirname, '..', 'public', 'settings.js')).href + '?t=' + (++counter);
  const mod = await import(url);
  return { window, mod, ...dom };
}

// Serves the systems payload and records every systems-CRUD call; a per-test
// `handler` can override the response for one of them (e.g. to return 409).
function stubFetch(body, handler) {
  const calls = [];
  const ok = (b, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(b) });
  const err = (status, b) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(b) });
  const impl = (u, opts = {}) => {
    const method = opts.method || 'GET';
    if (u === '/api/settings/systems' && method === 'GET') return ok(body);
    if (u.startsWith('/api/settings/systems')) {
      const call = { url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined };
      calls.push(call);
      const over = handler?.(call);
      if (over) return over.error ? err(over.status, { error: over.error }) : ok(over.body ?? body, over.status ?? 200);
      return ok(body);
    }
    // Every other settings loader the page fires on open is out of scope here.
    return err(503, {});
  };
  return { impl, calls };
}

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const openSettings = async (window) => { window.location.hash = '#settings'; await tick(); };
const rows = (window) => [...window.document.querySelectorAll('#sy-list .sy-row')];
const rowFor = (window, id) => rows(window).find(r => r.querySelector('.sy-row-id').textContent === id);

test('renders one card per row; the built-in row is read-only and non-removable', async () => {
  const { impl } = stubFetch(payload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  assert.deepEqual(rows(window).map(r => r.querySelector('.sy-row-id').textContent), ['local', 'prod-box']);
  const local = rowFor(window, 'local');
  assert.equal(local.querySelector('.sy-row-label').textContent, 'This machine');
  assert.ok(local.querySelector('.sy-managed-badge'), 'built-in badge shown');
  assert.deepEqual([...local.querySelectorAll('.sy-row-actions button')].map(b => b.textContent), [],
    'no edit and no Remove — the server refuses both, and the UI never offers them');
  assertNull(local.querySelector('.sy-row-projects'), 'local carries no referencing projects');

  const prod = rowFor(window, 'prod-box');
  assertNull(prod.querySelector('.sy-managed-badge'), 'a user row carries no built-in badge');
  assert.deepEqual([...prod.querySelectorAll('.sy-row-actions button')].map(b => b.textContent), ['Edit', 'Remove']);
  // What holds the row, shown before the refusal can be hit.
  assert.equal(prod.querySelector('.sy-row-projects').textContent, 'projects: shipping');

  assert.match(window.document.getElementById('sy-status').textContent, /2 systems — 1 built in/);
});

test('the add form POSTs id + label, then resets to add mode', async () => {
  const { impl, calls } = stubFetch(payload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const $ = (id) => window.document.getElementById(id);
  $('sy-id').value = ' staging-box ';
  $('sy-label').value = ' Staging ';
  $('sy-save').click();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/settings/systems');
  assert.deepEqual(calls[0].body, { id: 'staging-box', label: 'Staging' });
  assert.equal($('sy-id').value, '');
  assert.equal($('sy-label').value, '');
  assert.equal($('sy-save').textContent, 'Add');
  assert.equal($('sy-cancel').hidden, true);
});

test('the built-in row exposes no way to open the edit form', async () => {
  const { impl, calls } = stubFetch(payload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  assert.equal([...rowFor(window, 'local').querySelectorAll('.sy-row-actions button')].length, 0);
  assert.equal(window.document.getElementById('sy-save').textContent, 'Add',
    'the form stays in its resting add state');
  assert.equal(calls.length, 0, 'no PATCH was issued');
});

test('editing a user row PATCHes the label only; the id is fixed', async () => {
  const { impl, calls } = stubFetch(payload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);
  const $ = (id) => window.document.getElementById(id);

  [...rowFor(window, 'prod-box').querySelectorAll('.sy-row-actions button')]
    .find(b => b.textContent === 'Edit').click();
  await tick();

  assert.equal($('sy-id').value, 'prod-box');
  assert.equal($('sy-id').disabled, true, 'the id is the identity — it cannot be edited into another row');
  assert.equal($('sy-label').value, 'Prod box');
  assert.equal($('sy-save').textContent, 'Save');
  assert.equal($('sy-cancel').hidden, false);

  $('sy-label').value = 'Production';
  $('sy-save').click();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, '/api/settings/systems/prod-box');
  assert.deepEqual(calls[0].body, { label: 'Production' });
  assert.equal($('sy-save').textContent, 'Add', 'back to add mode after a successful save');
});

// The refusal path: removal never cascades, so the user has to see WHY.
test('a 409 on Remove surfaces the server message (naming the projects) in the status line', async () => {
  const { impl, calls } = stubFetch(payload(), (call) => call.method === 'DELETE'
    ? { status: 409, error: "system 'prod-box' is still named by 1 project (shipping) — move or remove it first" }
    : null);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  [...rowFor(window, 'prod-box').querySelectorAll('.sy-row-actions button')]
    .find(b => b.textContent === 'Remove').click();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, '/api/settings/systems/prod-box');
  const status = window.document.getElementById('sy-status').textContent;
  assert.match(status, /Remove failed/);
  assert.match(status, /shipping/, 'the project is named, so the user knows what to move first');
  assert.equal(rows(window).length, 2, 'the row is still listed — nothing was deleted');
});

test('a successful Remove re-renders from the response', async () => {
  const { impl, calls } = stubFetch(payload(), (call) => call.method === 'DELETE'
    ? { body: payload([LOCAL]) } : null);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  [...rowFor(window, 'prod-box').querySelectorAll('.sy-row-actions button')]
    .find(b => b.textContent === 'Remove').click();
  await tick();

  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(rows(window).map(r => r.querySelector('.sy-row-id').textContent), ['local']);
});

test('a failed add reports in the form status and leaves the typed values alone', async () => {
  const { impl } = stubFetch(payload(), (call) => call.method === 'POST'
    ? { status: 409, error: "system 'prod-box' already exists" } : null);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const $ = (id) => window.document.getElementById(id);
  $('sy-id').value = 'prod-box';
  $('sy-label').value = 'Dup';
  $('sy-save').click();
  await tick();

  assert.match($('sy-form-status').textContent, /Save failed.*already exists/);
  assert.equal($('sy-id').value, 'prod-box', 'the form is not reset, so the typed id can be corrected');
  assert.equal($('sy-save').disabled, false, 'the button is re-enabled after the failure');
});
