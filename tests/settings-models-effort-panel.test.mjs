// Settings → Models, the DEFAULT-EFFORT axis, driven through the real
// public/settings.js with happy-dom.
//
// Two things are under test, both of which a screenshot can't prove:
//   1. the selects read/write the right key (a tier row → tierEffort, a role row →
//      roleEffort) via the shared /prefs POST;
//   2. a role row is never OPAQUE — its `Inherit` option names the level it will
//      actually run at, taken from the payload's server-computed `inheritsTo`.
//
// Harness mirrors tests/settings-backends-panel.test.mjs (cache-busted import so
// module-level state doesn't leak between tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { EFFORT_LEVELS } from '../src/effortLevels.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIERS = [
  { tier: 'fast', label: 'Fast' },
  { tier: 'balanced', label: 'Balanced' },
  { tier: 'powerful', label: 'Powerful' },
  { tier: 'frontier', label: 'Frontier' },
];

function modelsPayload(over = {}) {
  return {
    backends: [{ id: 'claude', label: 'Claude', template: '', env: [], managed: true }],
    claudeFamilies: [{ family: 'opus', label: 'Opus', default: 'claude-opus-4-8', versions: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }] }],
    customModels: [], ollamaCloudModels: [], ollamaCloudTierDefaults: {},
    tiers: TIERS,
    tierBackend: Object.fromEntries(TIERS.map(t => [t.tier, { backend: 'claude', model: 'claude-opus-4-8' }])),
    tierEffort: Object.fromEntries(TIERS.map(t => [t.tier, 'high'])),
    efforts: EFFORT_LEVELS,
    defaultEffort: 'high',
    roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
    roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
    roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'high' } },
    enabledTiers: Object.fromEntries(TIERS.map(t => [t.tier, true])),
    defaultSpawnTier: 'powerful',
    onOverage: 'none', overageThreshold: { enabled: false, value: 85 },
    ...over,
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
  const opt = document.createElement('option');
  opt.value = 'models';
  groupSelect.appendChild(opt);
  view.appendChild(groupSelect);

  const panel = document.createElement('div');
  panel.id = 'settings-models';
  panel.className = 'settings-group';
  panel.innerHTML = `
    <div id="sm-status"></div>
    <ul id="sm-tier-list"></ul>
    <ul id="sm-role-list"></ul>
    <div id="sm-role-status"></div>
    <ul id="sm-custom-list"></ul>
    <div id="sm-custom-status"></div>
  `;
  view.appendChild(panel);
  // The Voice group's status line: installSettings' load() writes its fetch
  // failure here, and a missing node throws instead (same scaffold need as
  // tests/settings-backends-panel.test.mjs).
  const stStatus = document.createElement('div');
  stStatus.id = 'st-status';
  view.appendChild(stStatus);

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

// Serves the models payload and records every /prefs POST. `nextPayload` (when
// given) is what a /prefs call responds with, so a test can assert the re-render.
function stubFetch(payload, nextPayload) {
  const calls = [];
  const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const impl = (u, opts = {}) => {
    const method = opts.method || 'GET';
    if (u === '/api/settings/models' && method === 'GET') return ok(payload);
    if (u === '/api/settings/models/prefs' && method === 'POST') {
      calls.push(JSON.parse(opts.body));
      return ok(nextPayload ?? payload);
    }
    if (u === '/api/settings/spawn' && method === 'GET') return ok({ debugByDefault: false });
    return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  };
  return { impl, calls };
}

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const openSettings = async (window) => { window.location.hash = '#settings'; await tick(); };
const tierRow = (window, tier) =>
  [...window.document.querySelectorAll('#sm-tier-list .sm-family-row')]
    .find(li => li.querySelector('.sm-backend')?.dataset.tier === tier);

test('each tier row renders an effort select showing its stored level', async () => {
  const { impl } = stubFetch(modelsPayload({
    tierEffort: { fast: 'low', balanced: 'high', powerful: 'high', frontier: 'max' },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const rows = [...window.document.querySelectorAll('#sm-tier-list .sm-family-row')];
  assert.equal(rows.length, 4, 'one row per tier');
  // Rows render Frontier → Fast, so read each row's own select.
  assert.equal(tierRow(window, 'frontier').querySelector('.sm-effort').value, 'max');
  assert.equal(tierRow(window, 'fast').querySelector('.sm-effort').value, 'low');
  assert.equal(tierRow(window, 'balanced').querySelector('.sm-effort').value, 'high');

  // Options come from the server-shipped catalog, and a TIER has no Inherit option.
  const opts = [...tierRow(window, 'fast').querySelector('.sm-effort').options].map(o => o.value);
  assert.deepEqual(opts, EFFORT_LEVELS, 'no inherit on a tier — it has nothing to inherit from');
});

test('changing a tier row effort POSTs tierEffort for that tier', async () => {
  const { impl, calls } = stubFetch(modelsPayload());
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const sel = tierRow(window, 'frontier').querySelector('.sm-effort');
  sel.value = 'max';
  sel.dispatchEvent(new window.Event('change'));
  await tick();

  assert.deepEqual(calls, [{ tierEffort: { tier: 'frontier', effort: 'max' } }],
    'writes the effort axis of the row it belongs to — not a binding, not another tier');
});

test("a role row's Inherit option names the level it resolves to", async () => {
  const { impl } = stubFetch(modelsPayload({
    roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'max' } },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const sel = window.document.querySelector('#sm-role-list .sm-effort');
  assert.ok(sel, 'the role row has an effort select');
  assert.equal(sel.value, 'inherit', 'inherit is selected');
  const first = sel.options[0];
  assert.equal(first.value, 'inherit');
  assert.equal(first.textContent, 'Inherit (max)',
    'the row states what it will actually run at — never an opaque bare "Inherit"');
  assert.deepEqual([...sel.options].map(o => o.value), ['inherit', ...EFFORT_LEVELS]);
});

test('a role with an explicit level shows that level, and changing it POSTs roleEffort', async () => {
  const { impl, calls } = stubFetch(modelsPayload({
    roleEffort: { conductor: { effort: 'xhigh', inheritsTo: 'low' } },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const sel = window.document.querySelector('#sm-role-list .sm-effort');
  assert.equal(sel.value, 'xhigh', 'the explicit level wins in the UI, as it does at spawn');
  // The Inherit option still advertises what it would fall back to.
  assert.equal(sel.options[0].textContent, 'Inherit (low)');

  sel.value = 'inherit';
  sel.dispatchEvent(new window.Event('change'));
  await tick();
  assert.deepEqual(calls, [{ roleEffort: { role: 'conductor', effort: 'inherit' } }]);
});

test('a disabled tier disables its effort select alongside its binding pickers', async () => {
  const { impl } = stubFetch(modelsPayload({
    enabledTiers: { fast: false, balanced: true, powerful: true, frontier: true },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  const row = tierRow(window, 'fast');
  assert.equal(row.querySelector('.sm-backend').disabled, true);
  assert.equal(row.querySelector('.sm-effort').disabled, true, 'a hidden tier can\'t be re-tuned');
  assert.equal(tierRow(window, 'balanced').querySelector('.sm-effort').disabled, false);
});

test('a row whose level is missing from the payload shows the SERVER default, not the first level', async () => {
  // A stale/partial payload (an older server, a hand-edited store) must not display
  // `low` — the first entry in EFFORT_LEVELS — for a row the server resolves at
  // `high`. The displayed level is a claim about what will run.
  const { impl } = stubFetch(modelsPayload({
    tierEffort: { balanced: 'max' },                 // fast/powerful/frontier absent
    roleEffort: { conductor: { effort: undefined, inheritsTo: 'high' } },
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  assert.equal(tierRow(window, 'fast').querySelector('.sm-effort').value, 'high',
    'falls back to the payload\'s defaultEffort');
  assert.equal(tierRow(window, 'balanced').querySelector('.sm-effort').value, 'max');
  // A role with no stored effort still lands on its Inherit option.
  assert.equal(window.document.querySelector('#sm-role-list .sm-effort').value, 'inherit');
});

test('every panel fallback routes through the payload\'s defaultEffort, including the Inherit label', async () => {
  // defaultEffort deliberately differs from the global default so a hardcoded
  // 'high' anywhere in the panel shows up as a wrong label / wrong selection.
  const { impl } = stubFetch(modelsPayload({
    defaultEffort: 'medium',
    tierEffort: { balanced: 'max' },                        // other tiers absent
    roleEffort: { conductor: { effort: 'inherit' } },       // inheritsTo absent
  }));
  const { window, mod } = await setup(impl);
  mod.installSettings({});
  await openSettings(window);

  assert.equal(tierRow(window, 'frontier').querySelector('.sm-effort').value, 'medium',
    'the tier-select fallback uses defaultEffort');
  assert.equal(window.document.querySelector('#sm-role-list .sm-effort').options[0].textContent,
    'Inherit (medium)', 'so does the Inherit label — no separate literal');
});
