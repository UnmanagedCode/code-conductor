// Settings → Models, the per-field LABEL CONTRACT that the responsive layout
// rests on, driven through the real public/settings.js with happy-dom.
//
// The phone layout drops `.sm-family-header` (its column captions stop lining up
// with anything once a row restacks) and gets the captions from a `label.sm-field`
// wrapper around each control instead. That wrapper is pure DOM, so it is what a
// screenshot can't prove and what a stylesheet alone can't supply: if a control is
// ever appended bare again, the CSS half of the fix still "works" and the row
// silently renders captionless on a phone. Same for the accessible names — the
// enable checkbox and default radio had none before, and the removed column header
// was the only thing naming the two binding selects.
//
// Geometry (overflow, tap targets, clipping) is checked in the browser by
// harness/playwright/check-models-responsive.mjs; this file is the deterministic half.
//
// Harness mirrors tests/settings-models-effort-panel.test.mjs (cache-busted import
// so module-level state doesn't leak between tests).

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
    backends: [
      { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
      { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --', env: [], managed: true },
    ],
    claudeFamilies: [{ family: 'opus', label: 'Opus', default: 'claude-opus-4-8', versions: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }] }],
    customModels: [{ label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 256000 }],
    ollamaCloudModels: [], ollamaCloudTierDefaults: {},
    tiers: TIERS,
    tierBackend: Object.fromEntries(TIERS.map(t => [t.tier, { backend: 'claude', model: 'claude-opus-4-8' }])),
    tierEffort: Object.fromEntries(TIERS.map(t => [t.tier, 'high'])),
    efforts: EFFORT_LEVELS,
    defaultEffort: 'high',
    // A tier-bound role and a Custom-bound one: only the latter renders the
    // backend + model fields, so both field sets get covered.
    roles: [
      { role: 'conductor', label: 'Conductor', builtin: true },
      { role: 'Mine-Own-Role' },
    ],
    roleBackend: {
      conductor: { kind: 'tier', tier: 'powerful' },
      'Mine-Own-Role': { backend: 'ollama', model: 'mine:v1' },
    },
    roleEffort: {
      conductor: { effort: 'inherit', inheritsTo: 'high' },
      'Mine-Own-Role': { effort: 'inherit', inheritsTo: 'high' },
    },
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
  const stStatus = document.createElement('div');
  stStatus.id = 'st-status';
  view.appendChild(stStatus);

  main.appendChild(view);
  document.body.appendChild(main);
  return { view };
}

let counter = 0;
async function setup(payload) {
  const window = new Window({ url: 'http://localhost/#' });
  const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  window.fetch = (u, opts = {}) => {
    const method = opts.method || 'GET';
    if (u === '/api/settings/models' && method === 'GET') return ok(payload);
    if (u === '/api/settings/models/prefs' && method === 'POST') return ok(payload);
    if (u === '/api/settings/spawn' && method === 'GET') return ok({ debugByDefault: false });
    return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.fetch = window.fetch;

  buildDOM(window.document);
  const url = pathToFileURL(path.resolve(__dirname, '..', 'public', 'settings.js')).href + '?t=' + (++counter);
  const mod = await import(url);
  mod.installSettings({});
  window.location.hash = '#settings';
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  return window;
}

const allRows = (window) => [
  ...window.document.querySelectorAll('#sm-tier-list .sm-family-row'),
  ...window.document.querySelectorAll('#sm-role-list .sm-role-row'),
];
const rowName = (li) => li.querySelector('.sm-family-label')?.textContent || '?';

test('every select in a tier/role row sits in a captioned label.sm-field', async () => {
  const window = await setup(modelsPayload());
  const rows = allRows(window);
  assert.equal(rows.length, 6, '4 tiers + 2 roles');

  let seen = 0;
  for (const li of rows) {
    const selects = [...li.querySelectorAll('select')];
    assert.ok(selects.length >= 2, `${rowName(li)} renders its selects`);
    for (const sel of selects) {
      const wrap = sel.parentElement;
      assert.ok(
        wrap && wrap.tagName === 'LABEL' && wrap.classList.contains('sm-field'),
        `${rowName(li)}: ${sel.className} must be wrapped in label.sm-field, got ${wrap?.tagName}.${wrap?.className}`,
      );
      const cap = wrap.querySelector('.sm-field-cap');
      assert.ok(cap && cap.textContent.trim(),
        `${rowName(li)}: ${sel.className} needs a non-empty .sm-field-cap — it is the only visible label once the row restacks`);
      seen++;
    }
  }
  // 4 tiers × (backend, model, effort) + conductor (binding, effort)
  // + Mine-Own-Role (binding, backend, model, effort)
  assert.equal(seen, 18, 'every select covered');
});

test('the tier enable checkbox and default radio are both wrapped and named', async () => {
  const window = await setup(modelsPayload());
  for (const li of window.document.querySelectorAll('#sm-tier-list .sm-family-row')) {
    const tier = rowName(li);
    for (const [cls, kind] of [['.sm-enable', 'enable'], ['.sm-default-radio', 'default']]) {
      const box = li.querySelector(cls);
      const wrap = box.parentElement;
      assert.ok(wrap.tagName === 'LABEL' && wrap.classList.contains(`sm-field--${kind}`),
        `${tier}: ${cls} must sit in label.sm-field--${kind} — that wrapper is its 44px tap target`);
      assert.match(box.getAttribute('aria-label') || '', new RegExp(tier),
        `${tier}: ${cls} needs an aria-label naming its row`);
    }
  }
});

test('the binding selects carry a row-specific aria-label, not just a shared caption', async () => {
  // The wide layout's captions live in one `.sm-family-header` shared by every
  // row, so "backend" alone never said WHICH row. Assert the accessible name
  // names the row, or four identical "backend" selects are indistinguishable.
  const window = await setup(modelsPayload());
  const frontier = [...window.document.querySelectorAll('#sm-tier-list .sm-family-row')]
    .find(li => li.querySelector('.sm-backend')?.dataset.tier === 'frontier');
  assert.equal(frontier.querySelector('.sm-backend').getAttribute('aria-label'), 'Backend for the Frontier tier');
  assert.equal(frontier.querySelector('.sm-version').getAttribute('aria-label'), 'Model for the Frontier tier');

  const role = window.document.querySelector('#sm-role-list .sm-role-row');
  assert.equal(role.querySelector('.sm-role-binding').getAttribute('aria-label'), 'Binding for the Conductor role');
});

test('a wrapped control still reaches its row via closest(), and the row still reaches it', async () => {
  // Both traversal directions the panel and its other tests depend on: the
  // wrapper must not become a scoping boundary. Unlike the tests above this one
  // passes with OR without the wrapper by design — it guards against a wrapper
  // placed wrongly (around the row, or replacing the `<li>`), not against its
  // absence.
  const window = await setup(modelsPayload());
  const sel = window.document.querySelector('select.sm-backend[data-tier="fast"]');
  const li = sel.closest('li');
  assert.ok(li?.classList.contains('sm-family-row'));
  assert.equal(li.querySelector('select.sm-version').tagName, 'SELECT');
  assert.equal(li.querySelector('.sm-effort').value, 'high');
});

test('model and effort share one .sm-field-pair, and only where both exist', async () => {
  // The pair is what puts the two selects on one line under the breakpoint. It is
  // pure DOM: the CSS half (`.sm-field-pair` → 2-column grid) still "works" with no
  // wrapper present, and the row just renders one field per line again — a silent
  // regression a stylesheet cannot prevent and a screenshot at one width may not
  // make obvious.
  const window = await setup(modelsPayload());

  for (const li of window.document.querySelectorAll('#sm-tier-list .sm-family-row')) {
    const tier = rowName(li);
    const pairs = li.querySelectorAll('.sm-field-pair');
    assert.equal(pairs.length, 1, `${tier}: exactly one .sm-field-pair`);
    const kinds = [...pairs[0].children].map(f => f.className.replace('sm-field sm-field--', ''));
    assert.deepEqual(kinds, ['model', 'effort'], `${tier}: the pair holds model + effort, in that order`);
    // Backend stays on its own line — it is the widest select and pairing it too
    // would put three controls on one 232px line at 320px.
    assert.equal(li.querySelector('.sm-field--backend').closest('.sm-field-pair'), null,
      `${tier}: backend is not in the pair`);
  }

  const rows = [...window.document.querySelectorAll('#sm-role-list .sm-role-row')];
  const tierBound = rows.find(li => rowName(li) === 'Conductor');
  const custom = rows.find(li => rowName(li) === 'Mine-Own-Role');
  assert.equal(tierBound.querySelector('.sm-field-pair'), null,
    'a tier-bound role has no model field, so effort takes the line alone — an empty half would be a dead column');
  assert.ok(tierBound.querySelector('.sm-field--effort'), 'effort is still rendered, just unpaired');
  assert.equal(custom.querySelectorAll('.sm-field-pair').length, 1,
    'a Custom-bound role does render a model field, so it pairs');
  assert.deepEqual(
    [...custom.querySelector('.sm-field-pair').children].map(f => f.className.replace('sm-field sm-field--', '')),
    ['model', 'effort'],
  );
});

test('a caption is omitted entirely rather than emitted empty', async () => {
  // An empty .sm-field-cap would still claim a 4.5em caption column on the phone
  // layout, pushing the control it wraps out of the row.
  const window = await setup(modelsPayload());
  for (const cap of window.document.querySelectorAll('#settings-models .sm-field-cap')) {
    assert.ok(cap.textContent.trim(), 'no empty .sm-field-cap nodes');
  }
  const enable = window.document.querySelector('#sm-tier-list .sm-field--enable');
  assert.equal(enable.querySelector('.sm-field-cap'), null,
    'the enable checkbox is named by the tier label beside it — no caption node');
});
