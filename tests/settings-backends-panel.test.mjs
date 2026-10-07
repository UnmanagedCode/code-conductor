// The two registry-facing settings panels, driven through the real
// public/settings.js with happy-dom.
//
// Settings → Backends: the registry renders (managed rows fully read-only +
// non-removable — no edit affordance; user rows editable/removable), the add/edit
// form round-trips for USER rows, and — the load-bearing one — a 409 refusal on
// Remove surfaces the server's message instead of failing silently.
//
// Settings → Models: buildBackendPicker is REGISTRY-driven, so a user-added backend
// appears in the backend select with no code change, and the curated cloud optgroup
// is scoped to the built-in `ollama` row only.
//
// Custom models: each row offers Edit + Remove. Edit loads the row into the add
// form with backend and model id locked (the pair is the identity bindings and
// session records name); Save PATCHes label/context/steering, Cancel returns to
// add mode.
//
// Mirrors the harness in tests/account-overage.test.mjs (cache-busted import so
// module-level state doesn't leak).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MANAGED = [
  { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
  { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
];
const USER = { id: 'my-proxy', label: 'My Proxy', template: 'proxyctl exec claude --model {model} --', env: [{ key: 'PROXY_TOKEN', value: 'sekret' }], managed: false };

function modelsPayload({ backends = [...MANAGED, USER], customModels = [] } = {}) {
  return {
    backends, customModels,
    claudeFamilies: [], tiers: [], tierBackend: {}, roles: [], roleBackend: {},
    ollamaCloudModels: [], ollamaCloudTierDefaults: {},
    enabledTiers: {}, defaultSpawnTier: 'powerful',
    onOverage: 'none', overageThreshold: { enabled: false, value: 85 },
  };
}

function buildDOM(document) {
  const main = document.createElement('div');
  main.id = 'main';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.hidden = true;

  const groupSelect = document.createElement('select');
  groupSelect.id = 'settings-group-select';
  for (const val of ['models', 'backends']) {
    const opt = document.createElement('option');
    opt.value = val;
    groupSelect.appendChild(opt);
  }
  view.appendChild(groupSelect);

  for (const g of ['models', 'backends']) {
    const panel = document.createElement('div');
    panel.id = `settings-${g}`;
    panel.className = 'settings-group';
    panel.hidden = g !== 'models';
    view.appendChild(panel);
  }
  const stStatus = document.createElement('div');
  stStatus.id = 'st-status';
  view.appendChild(stStatus);

  // renderModels early-returns without #sm-tier-list, and it's what drives
  // renderBackends — so the Models panel scaffold has to exist.
  const models = view.querySelector('#settings-models');
  const tierList = document.createElement('ul');
  tierList.id = 'sm-tier-list';
  models.appendChild(tierList);
  const customList = document.createElement('ul');
  customList.id = 'sm-custom-list';
  models.appendChild(customList);
  const customForm = document.createElement('div');
  customForm.innerHTML = `
    <input id="sm-custom-label" type="text" />
    <select id="sm-custom-backend"></select>
    <input id="sm-custom-model" type="text" />
    <input id="sm-custom-context" type="text" />
    <input id="sm-custom-steer" type="checkbox" checked />
    <button type="button" id="sm-custom-add">Add</button>
    <button type="button" id="sm-custom-cancel" hidden>Cancel</button>
    <div id="sm-custom-status"></div>
  `;
  models.appendChild(customForm);

  view.querySelector('#settings-backends').innerHTML = `
    <div id="sb-status"></div>
    <ul id="sb-list"></ul>
    <fieldset>
      <legend id="sb-form-legend">Add a backend</legend>
      <input id="sb-id" type="text" />
      <input id="sb-label" type="text" />
      <input id="sb-template" type="text" />
      <textarea id="sb-env"></textarea>
      <button type="button" id="sb-save">Add</button>
      <button type="button" id="sb-cancel" hidden>Cancel</button>
      <div id="sb-form-status"></div>
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

// Serves the models payload; records every backend-CRUD and custom-model
// POST/PATCH/DELETE call; a per-test `handler` can override the response for any
// of them (e.g. to return 409 or 400).
function stubFetch(payload, handler) {
  const calls = [];
  const ok = (body, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) });
  const err = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });
  const impl = (u, opts = {}) => {
    const method = opts.method || 'GET';
    if (u === '/api/settings/models' && method === 'GET') return ok(payload);
    if (u === '/api/settings/models/prefs' && method === 'POST') {
      calls.push({ url: u, method, body: JSON.parse(opts.body) });
      return ok(payload);
    }
    if (u.startsWith('/api/settings/models/custom')) {
      const call = { url: u, method };
      if (opts.body) call.body = JSON.parse(opts.body);
      calls.push(call);
      const over = handler?.(call);
      if (over) return over.error ? err(over.status, { error: over.error }) : ok(over.body ?? payload, over.status ?? 200);
      return ok(payload);
    }
    if (u.startsWith('/api/settings/models/backends')) {
      const call = { url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined };
      calls.push(call);
      const over = handler?.(call);
      if (over) return over.error ? err(over.status, { error: over.error }) : ok(over.body ?? payload, over.status ?? 200);
      return ok(payload);
    }
    return err(503, {});
  };
  return { impl, calls, ok, err };
}

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const openSettings = async (window) => { window.location.hash = '#settings'; await tick(); };

test('renders one card per registry row; managed rows are read-only + non-removable', async () => {
  const { impl } = stubFetch(modelsPayload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const rows = [...window.document.querySelectorAll('#sb-list .sb-row')];
  assert.equal(rows.length, 3, 'one card per backend');
  assert.deepEqual(rows.map(r => r.querySelector('.sb-row-id').textContent), ['claude', 'ollama', 'my-proxy']);

  // Managed rows: badge, no action buttons (read-only), no Remove.
  const [claudeRow, ollamaRow, userRow] = rows;
  for (const r of [claudeRow, ollamaRow]) {
    assert.ok(r.querySelector('.sb-managed-badge'), 'managed badge shown');
    const labels = [...r.querySelectorAll('.sb-row-actions button')].map(b => b.textContent);
    assert.deepEqual(labels, [], 'managed row is read-only — no edit affordance, no Remove');
  }
  // The identity row shows the bare `claude` command for its blank template; ollama shows its template.
  assert.equal(claudeRow.querySelector('.sb-row-template').textContent, 'claude');
  assert.equal(ollamaRow.querySelector('.sb-row-template').textContent, MANAGED[1].template);
  // Managed env is code-authoritative (empty) — no env line rendered for ollama.
  assertNull(ollamaRow.querySelector('.sb-row-env'), 'managed ollama row renders no env line');

  // User row: no badge, both Edit and Remove.
  assertNull(userRow.querySelector('.sb-managed-badge'), 'a user backend row carries no managed badge');
  assert.deepEqual([...userRow.querySelectorAll('.sb-row-actions button')].map(b => b.textContent), ['Edit', 'Remove']);

  assert.match(window.document.getElementById('sb-status').textContent, /3 backends — 2 built in/);
});

test('a row lists the custom models bound to it', async () => {
  const { impl } = stubFetch(modelsPayload({
    customModels: [
      { label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 300000 },
      { label: 'Flash', model: 'deepseek-v4-flash:cloud', backend: 'ollama', contextWindow: 1000000 },
    ],
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const rowFor = (id) => [...window.document.querySelectorAll('#sb-list .sb-row')]
    .find(r => r.querySelector('.sb-row-id').textContent === id);
  assert.match([...rowFor('my-proxy').querySelectorAll('.sb-row-env')].map(e => e.textContent).join(' '), /models: mine:v1/);
  assert.match([...rowFor('ollama').querySelectorAll('.sb-row-env')].map(e => e.textContent).join(' '), /models: deepseek-v4-flash:cloud/);
  // The claude row hosts no user models.
  assert.equal([...rowFor('claude').querySelectorAll('.sb-row-env')].length, 0);
});

test('the add form POSTs id/label/template + parsed KEY=VALUE env, then resets', async () => {
  const { impl, calls } = stubFetch(modelsPayload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const $ = (id) => window.document.getElementById(id);
  $('sb-id').value = 'newbe';
  $('sb-label').value = 'New Backend';
  $('sb-template').value = 'newctl claude --model {model} --';
  $('sb-env').value = 'FOO=bar\n\nBAZ=with=equals\n';
  $('sb-save').click();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/settings/models/backends');
  assert.deepEqual(calls[0].body, {
    id: 'newbe', label: 'New Backend', template: 'newctl claude --model {model} --',
    // Blank lines dropped; only the FIRST '=' splits, so a value may contain '='.
    env: [{ key: 'FOO', value: 'bar' }, { key: 'BAZ', value: 'with=equals' }],
  });
  // Form reset back to add mode.
  assert.equal($('sb-id').value, '');
  assert.equal($('sb-env').value, '');
  assert.equal($('sb-save').textContent, 'Add');
  assert.equal($('sb-cancel').hidden, true);
});

test('a MANAGED row exposes no edit affordance — the form cannot be opened for it', async () => {
  const { impl, calls } = stubFetch(modelsPayload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);
  const $ = (id) => window.document.getElementById(id);

  for (const id of ['claude', 'ollama']) {
    const row = [...window.document.querySelectorAll('#sb-list .sb-row')]
      .find(r => r.querySelector('.sb-row-id').textContent === id);
    // No action buttons on a managed row → no way to open the edit form, so env
    // (code-authoritative, empty) is never editable from the UI.
    assert.equal([...row.querySelectorAll('.sb-row-actions button')].length, 0, `${id} has no edit/remove button`);
  }
  // The form stays in its "Add a backend" resting state (never opened for a managed row).
  assert.equal($('sb-save').textContent, 'Add');
  assert.equal(calls.length, 0, 'no PATCH was issued');
});

test('editing a USER row PATCHes label/template/env together', async () => {
  const { impl, calls } = stubFetch(modelsPayload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);
  const $ = (id) => window.document.getElementById(id);

  const userRow = [...window.document.querySelectorAll('#sb-list .sb-row')]
    .find(r => r.querySelector('.sb-row-id').textContent === 'my-proxy');
  userRow.querySelector('.sb-row-actions button').click(); // "Edit"
  await tick();

  assert.equal($('sb-label').disabled, false);
  assert.equal($('sb-template').disabled, false);
  assert.equal($('sb-template').value, USER.template);
  $('sb-label').value = 'Renamed';
  $('sb-save').click();
  await tick();

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, {
    label: 'Renamed', template: USER.template, env: [{ key: 'PROXY_TOKEN', value: 'sekret' }],
  });
});

// The refusal path: removal never cascades, so the user has to see WHY.
test('a 409 on Remove surfaces the server message (naming the bound models) in the status line', async () => {
  const payload = modelsPayload({ customModels: [{ label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 300000 }] });
  const { impl, calls } = stubFetch(payload, (call) => call.method === 'DELETE'
    ? { status: 409, error: "backend 'my-proxy' still has custom models bound to it (mine:v1) — remove them first" }
    : null);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const userRow = [...window.document.querySelectorAll('#sb-list .sb-row')]
    .find(r => r.querySelector('.sb-row-id').textContent === 'my-proxy');
  [...userRow.querySelectorAll('.sb-row-actions button')].find(b => b.textContent === 'Remove').click();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, '/api/settings/models/backends/my-proxy');
  const status = window.document.getElementById('sb-status').textContent;
  assert.match(status, /Remove failed/);
  assert.match(status, /mine:v1/, 'the bound model is named, so the user knows what to remove first');
  // The row is still listed — nothing was deleted.
  assert.equal([...window.document.querySelectorAll('#sb-list .sb-row')].length, 3);
});

test('a successful Remove re-renders from the response', async () => {
  const after = modelsPayload({ backends: [...MANAGED] }); // user row gone
  const { impl, calls } = stubFetch(modelsPayload(), (call) => call.method === 'DELETE' ? { body: after } : null);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const userRow = [...window.document.querySelectorAll('#sb-list .sb-row')]
    .find(r => r.querySelector('.sb-row-id').textContent === 'my-proxy');
  [...userRow.querySelectorAll('.sb-row-actions button')].find(b => b.textContent === 'Remove').click();
  await tick();

  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(
    [...window.document.querySelectorAll('#sb-list .sb-row')].map(r => r.querySelector('.sb-row-id').textContent),
    ['claude', 'ollama'],
  );
});

// ── Settings → Models: the registry-driven picker ────────────────────────────
// A tier row's two selects come from buildBackendPicker. These pin the two things
// that would silently regress if it were re-hardcoded: the backend list is the
// REGISTRY (not a Claude/Ollama literal), and the curated catalog belongs to the
// built-in `ollama` row alone.

const TIERS = [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }];
const CURATED = [{ label: 'GLM-5.2', model: 'glm-5.2:cloud', contextWindow: 1000000 }];
const CLAUDE_FAMILIES = [
  { family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5', versions: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1000000 }] },
  { family: 'haiku', label: 'Haiku', default: 'claude-haiku-4-5', versions: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' }] },
];

function tierPayload(tierBackend) {
  return {
    ...modelsPayload({
      customModels: [
        { label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 300000 },
        { label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128000 },
      ],
    }),
    tiers: TIERS,
    claudeFamilies: CLAUDE_FAMILIES,
    ollamaCloudModels: CURATED,
    tierBackend,
  };
}

// The tier rows render newest-first (frontier → fast), so find by data-tier.
function pickerFor(window, tier) {
  const sel = window.document.querySelector(`select.sm-backend[data-tier="${tier}"]`);
  const row = sel.closest('li');
  return { backendSel: sel, modelSel: row.querySelector('select.sm-version') };
}
const optTexts = (sel) => [...sel.querySelectorAll('option')].map(o => o.textContent);
const groupLabels = (sel) => [...sel.querySelectorAll('optgroup')].map(g => g.label);

test('Models picker: the backend select is the registry, so a user-added row appears in it', async () => {
  const { impl } = stubFetch(tierPayload({
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'my-proxy', model: 'mine:v1' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  // Every registry row is offered, in registry order, with its label — a
  // user-added backend appears here with no code change.
  const { backendSel } = pickerFor(window, 'fast');
  assert.deepEqual([...backendSel.querySelectorAll('option')].map(o => o.value), ['claude', 'ollama', 'my-proxy']);
  assert.deepEqual(optTexts(backendSel), ['Claude', 'Ollama', 'My Proxy']);
  // Both tier rows render, each scoped to its own bound backend (proven by the
  // model select's contents — happy-dom can't observe pre-append <option> selection).
  assert.deepEqual(groupLabels(pickerFor(window, 'powerful').modelSel), ['My Models']);
  assert.deepEqual(groupLabels(pickerFor(window, 'fast').modelSel), []);
});

test('Models picker: switching a tier TO a user backend auto-picks its first model and saves', async () => {
  const { impl, calls } = stubFetch(tierPayload({
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'claude', model: 'claude-sonnet-5' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const { backendSel } = pickerFor(window, 'fast');
  backendSel.value = 'my-proxy';
  backendSel.dispatchEvent(new window.Event('change'));
  await tick();

  const prefs = calls.filter(c => c.url === '/api/settings/models/prefs');
  assert.equal(prefs.length, 1);
  assert.deepEqual(prefs[0].body, { tierBackend: { tier: 'fast', backend: { backend: 'my-proxy', model: 'mine:v1' } } },
    "the backend's first custom model is auto-picked");
});

test('Models picker: switching a tier to a backend with NO model refuses and says which backend', async () => {
  const payload = { ...tierPayload({ fast: { backend: 'claude', model: 'claude-haiku-4-5' } }), customModels: [], ollamaCloudModels: [] };
  const { impl, calls } = stubFetch(payload);
  const { window, mod } = await setup(impl);
  const status = window.document.createElement('div');
  status.id = 'sm-status';
  window.document.getElementById('settings-models').appendChild(status);
  mod.installSettings({});
  await openSettings(window);

  const { backendSel } = pickerFor(window, 'fast');
  backendSel.value = 'my-proxy';
  backendSel.dispatchEvent(new window.Event('change'));
  await tick();

  assert.equal(calls.filter(c => c.url === '/api/settings/models/prefs').length, 0, 'nothing saved');
  assert.match(window.document.getElementById('sm-status').textContent, /Add a My Proxy model below first/);
});

test('Models picker: picking a model keeps the row on its CURRENT backend', async () => {
  const { impl, calls } = stubFetch(tierPayload({
    fast: { backend: 'my-proxy', model: 'mine:v1' },
    powerful: { backend: 'claude', model: 'claude-sonnet-5' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const { modelSel } = pickerFor(window, 'fast');
  modelSel.value = 'mine:v1';
  modelSel.dispatchEvent(new window.Event('change'));
  await tick();

  const prefs = calls.filter(c => c.url === '/api/settings/models/prefs');
  assert.equal(prefs.length, 1);
  assert.deepEqual(prefs[0].body, { tierBackend: { tier: 'fast', backend: { backend: 'my-proxy', model: 'mine:v1' } } },
    'the model pick must not silently reset the backend to claude');
});

test('Models picker: claude → the version list; the curated optgroup is ollama-only', async () => {
  const { impl } = stubFetch(tierPayload({
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'ollama', model: 'gemma4:cloud' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  // claude → flat Claude version list, no optgroups.
  const claudeModels = pickerFor(window, 'fast').modelSel;
  assert.deepEqual(groupLabels(claudeModels), []);
  assert.deepEqual(optTexts(claudeModels), ['Sonnet 5', 'Haiku 4.5']);

  // ollama → curated group + My Models, the latter filtered to that backend.
  const ollamaModels = pickerFor(window, 'powerful').modelSel;
  assert.deepEqual(groupLabels(ollamaModels), ['Ollama Cloud', 'My Models']);
  assert.deepEqual(optTexts(ollamaModels), ['GLM-5.2 — glm-5.2:cloud', 'Local — gemma4:cloud'],
    "only the ollama row's own custom model, plus the curated preset");
});

test('Models picker: a USER backend gets My Models only — no curated catalog', async () => {
  const { impl } = stubFetch(tierPayload({
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'my-proxy', model: 'mine:v1' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const modelSel = pickerFor(window, 'powerful').modelSel;
  assert.deepEqual(groupLabels(modelSel), ['My Models'], 'no curated group for a user-defined backend');
  assert.deepEqual(optTexts(modelSel), ['Mine — mine:v1'], "and only that backend's own models");
});

test('Models picker: a backend with no bindable model shows the disabled empty state', async () => {
  const payload = { ...tierPayload({
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'my-proxy', model: 'mine:v1' },
  }), customModels: [], ollamaCloudModels: [] };
  const { impl } = stubFetch(payload);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const modelSel = pickerFor(window, 'powerful').modelSel;
  assert.deepEqual(optTexts(modelSel), ['(add a model below)']);
  assert.equal(modelSel.disabled, true);
});

test('Models picker: the custom-model add form offers every SUBSTITUTION backend, never claude', async () => {
  const { impl } = stubFetch(tierPayload({ fast: { backend: 'claude', model: 'claude-haiku-4-5' } }));
  const { window, mod } = await setup(impl);
  const sel = window.document.getElementById('sm-custom-backend');

  mod.installSettings({});
  await openSettings(window);

  assert.deepEqual([...sel.querySelectorAll('option')].map(o => o.value), ['ollama', 'my-proxy'],
    'the identity `claude` row is never a custom-model host');
  // Each row shows its backend + window.
  assert.match(window.document.getElementById('sm-custom-list').textContent, /Mine — mine:v1 · My Proxy · 300k ctx/);
});

test('Remove on a custom model sends that row\'s backend and model', async () => {
  const { impl, calls } = stubFetch(modelsPayload({
    customModels: [
      { label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 300000, midTurnSteering: true },
      { label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 300000, midTurnSteering: true },
    ],
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const removes = [...window.document.querySelectorAll('#sm-custom-list .sm-custom-remove')];
  assert.equal(removes.length, 2, 'one row per (backend, model) pair');
  removes[1].click();
  await tick();
  assert.deepEqual(calls, [{ url: '/api/settings/models/custom/my-proxy/mine%3Av1', method: 'DELETE' }]);
});

// ── Custom models: Edit ─────────────────────────────────────────────────────
const MINE = { label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 131072, midTurnSteering: false };
const SIBLING = { label: 'Sibling', model: 'sib:v3', backend: 'ollama', contextWindow: 64000, midTurnSteering: true };
const OTHER = { label: 'Other', model: 'other:v2', backend: 'my-proxy', contextWindow: 300000, midTurnSteering: true };

async function setupEdit(handler, customModels = [MINE, OTHER]) {
  const payload = modelsPayload({ customModels });
  const { impl, calls } = stubFetch(payload, handler);
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);
  const $ = (id) => window.document.getElementById(id);
  const editBtn = (i) => [...window.document.querySelectorAll('#sm-custom-list .sm-custom-edit')][i];
  const form = () => ({
    label: $('sm-custom-label').value, backend: $('sm-custom-backend').value, model: $('sm-custom-model').value,
    context: $('sm-custom-context').value, steer: $('sm-custom-steer').checked,
    backendDisabled: $('sm-custom-backend').disabled, modelDisabled: $('sm-custom-model').disabled,
    button: $('sm-custom-add').textContent, cancelHidden: $('sm-custom-cancel').hidden, status: $('sm-custom-status').textContent,
  });
  return { window, calls, $, editBtn, form, payload };
}

test('a custom row offers Edit + Remove; Edit loads the row with backend and model id locked', async () => {
  const { window, $, editBtn, form } = await setupEdit();
  const rows = [...window.document.querySelectorAll('#sm-custom-list .sm-custom-item')];
  assert.deepEqual(rows.map(r => [...r.querySelectorAll('button')].map(b => b.textContent)), [['Edit', 'Remove'], ['Edit', 'Remove']]);
  editBtn(0).click();
  assert.deepEqual(form(), {
    label: 'Mine', backend: 'ollama', model: 'mine:v1', context: '131072', steer: false,
    backendDisabled: true, modelDisabled: true, button: 'Save', cancelHidden: false,
    status: 'Editing Mine — backend and model id are fixed',
  });
  assert.equal($('sm-custom-context').value, '131072', 'the raw integer, not the lossy 131k');
});

test('saving an edit PATCHes the pair URL with label/contextWindow/midTurnSteering, then returns to add mode', async () => {
  const { calls, $, editBtn, form } = await setupEdit();
  editBtn(0).click();
  $('sm-custom-label').value = 'Mine 2';
  $('sm-custom-context').value = '200k';
  $('sm-custom-steer').checked = true;
  $('sm-custom-add').click();
  await tick();
  assert.deepEqual(calls, [{
    url: '/api/settings/models/custom/ollama/mine%3Av1', method: 'PATCH',
    body: { label: 'Mine 2', contextWindow: 200000, midTurnSteering: true },
  }]);
  assert.deepEqual(form(), {
    label: '', backend: 'ollama', model: '', context: '', steer: true,
    backendDisabled: false, modelDisabled: false, button: 'Add', cancelHidden: true, status: 'Saved.',
  });
});

test('reopening the edit form on another row replaces every field the previous open left behind', async () => {
  const { calls, $, editBtn, form } = await setupEdit();
  editBtn(0).click();
  $('sm-custom-label').value = 'scribble';
  $('sm-custom-context').value = '1';
  $('sm-custom-steer').checked = true;
  editBtn(1).click();
  assert.deepEqual(form(), {
    label: 'Other', backend: 'my-proxy', model: 'other:v2', context: '300000', steer: true,
    backendDisabled: true, modelDisabled: true, button: 'Save', cancelHidden: false,
    status: 'Editing Other — backend and model id are fixed',
  });
  $('sm-custom-add').click();
  await tick();
  assert.deepEqual(calls, [{
    url: '/api/settings/models/custom/my-proxy/other%3Av2', method: 'PATCH',
    body: { label: 'Other', contextWindow: 300000, midTurnSteering: true },
  }]);
});

test('Cancel resets every field and unlocks backend + model; the next click POSTs an add', async () => {
  const { calls, $, editBtn, form } = await setupEdit();
  editBtn(0).click();
  $('sm-custom-cancel').click();
  const f = form();
  assert.deepEqual({ ...f, backend: undefined }, {
    label: '', backend: undefined, model: '', context: '', steer: true,
    backendDisabled: false, modelDisabled: false, button: 'Add', cancelHidden: true, status: '',
  });
  $('sm-custom-label').value = 'New';
  $('sm-custom-backend').value = 'my-proxy';
  $('sm-custom-model').value = 'new:v1';
  $('sm-custom-context').value = '1m';
  $('sm-custom-add').click();
  await tick();
  assert.deepEqual(calls, [{
    url: '/api/settings/models/custom', method: 'POST',
    body: { label: 'New', model: 'new:v1', backend: 'my-proxy', contextWindow: 1000000, midTurnSteering: true },
  }]);
});

test('a failed PATCH keeps edit mode and shows the server\'s message', async () => {
  const { $, editBtn, form } = await setupEdit(call => (call.method === 'PATCH' ? { status: 400, error: 'contextWindow is required' } : undefined));
  editBtn(0).click();
  $('sm-custom-add').click();
  await tick();
  assert.deepEqual(form(), {
    label: 'Mine', backend: 'ollama', model: 'mine:v1', context: '131072', steer: false,
    backendDisabled: true, modelDisabled: true, button: 'Save', cancelHidden: false,
    status: 'Save failed: contextWindow is required',
  });
});

test('a re-render while editing keeps the backend locked; removing the edited row closes the form', async () => {
  const { window, $, editBtn, form, payload } = await setupEdit(call => (call.method === 'DELETE'
    ? { body: { ...payload, customModels: [OTHER] } } : undefined));
  editBtn(0).click();
  window.location.hash = '#';
  await tick();
  await openSettings(window);
  assert.equal($('sm-custom-backend').disabled, true, 're-rendering the list does not unlock the backend select');
  assert.equal(form().button, 'Save', 'still editing');
  $('sm-custom-label').value = 'dirty';
  window.document.querySelectorAll('#sm-custom-list .sm-custom-remove')[0].click();
  await tick();
  const f = form();
  assert.deepEqual({ ...f, backend: undefined }, {
    label: '', backend: undefined, model: '', context: '', steer: true,
    backendDisabled: false, modelDisabled: false, button: 'Add', cancelHidden: true, status: '',
  });
});

test('removing a different row while editing leaves the edit form open on the edited pair', async () => {
  const { window, calls, $, editBtn, form, payload } = await setupEdit(call => (call.method === 'DELETE'
    ? { body: { ...payload, customModels: [MINE] } } : undefined), [MINE, SIBLING]);
  editBtn(0).click();
  $('sm-custom-label').value = 'Mine edited';
  window.document.querySelectorAll('#sm-custom-list .sm-custom-remove')[1].click();
  await tick();
  assert.deepEqual(form(), {
    label: 'Mine edited', backend: 'ollama', model: 'mine:v1', context: '131072', steer: false,
    backendDisabled: true, modelDisabled: true, button: 'Save', cancelHidden: false,
    status: 'Editing Mine — backend and model id are fixed',
  });
  $('sm-custom-add').click();
  await tick();
  assert.deepEqual(calls.at(-1), {
    url: '/api/settings/models/custom/ollama/mine%3Av1', method: 'PATCH',
    body: { label: 'Mine edited', contextWindow: 131072, midTurnSteering: false },
  });
});

test('a re-render whose payload lacks the edited row leaves edit mode without Remove being used', async () => {
  const { window, calls, $, editBtn, form, payload } = await setupEdit();
  editBtn(0).click();
  $('sm-custom-label').value = 'dirty';
  payload.customModels = [OTHER]; // removed elsewhere; the next settings load no longer has it
  window.location.hash = '#';
  await tick();
  await openSettings(window);
  assert.equal(calls.length, 0, 'no Remove / save request was made');
  const f = form();
  assert.deepEqual({ ...f, backend: undefined }, {
    label: '', backend: undefined, model: '', context: '', steer: true,
    backendDisabled: false, modelDisabled: false, button: 'Add', cancelHidden: true, status: '',
  });
});
