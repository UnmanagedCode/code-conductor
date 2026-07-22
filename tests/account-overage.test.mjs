// Tests for the Account settings page (overage protection), moved out of the
// Models panel into its own group. Uses happy-dom to drive the real
// public/settings.js. Verifies the controls are populated from the shared
// /api/settings/models payload, that edits stage behind Apply (nothing persists
// until then), and that Apply commits and re-syncs to the server's values.
//
// Mirrors the harness in tests/settings-toggle.test.mjs (cache-busted import so
// module-level state doesn't leak; hashchange is async → waitUntilComplete).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A models payload as GET /api/settings/models returns it — overage prefs ride
// along here (there is no separate Account endpoint).
function modelsPayload(over) {
  return {
    providers: [{ kind: 'claude', label: 'Claude' }, { kind: 'ollama', label: 'Ollama' }],
    backends: [], tiers: [], tierBackend: {}, customBackends: [],
    ollamaCloudModels: [], ollamaCloudTierDefaults: {},
    enabledTiers: {}, defaultSpawnTier: 'powerful',
    onOverage: over.onOverage,
    overageThreshold: over.overageThreshold,
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
  for (const val of ['models', 'account']) {
    const opt = document.createElement('option');
    opt.value = val;
    groupSelect.appendChild(opt);
  }
  view.appendChild(groupSelect);

  // Panels — models is default-visible, account hidden.
  for (const g of ['models', 'account']) {
    const panel = document.createElement('div');
    panel.id = `settings-${g}`;
    panel.className = 'settings-group';
    panel.hidden = g !== 'models';
    view.appendChild(panel);
  }
  const account = view.querySelector('#settings-account');
  const models = view.querySelector('#settings-models');

  // Transcribe load() writes to #st-status on failure — must exist or it throws.
  const stStatus = document.createElement('div');
  stStatus.id = 'st-status';
  view.appendChild(stStatus);

  // Models needs #sm-tier-list to exist or loadModels() early-returns before
  // renderModels() (and thus before the overage sync) ever runs.
  const tierList = document.createElement('ul');
  tierList.id = 'sm-tier-list';
  models.appendChild(tierList);

  // Overage controls now live in the Account panel.
  account.innerHTML = `
    <div class="qs-mode-toggle" id="sm-overage" role="group">
      <button type="button" data-overage="none" aria-pressed="true">Off</button>
      <button type="button" data-overage="stop" aria-pressed="false">Stop</button>
      <button type="button" data-overage="stop-resume" aria-pressed="false">Stop &amp; resume</button>
    </div>
    <label><input id="sm-overage-threshold-enabled" type="checkbox" /> threshold</label>
    <div id="sm-overage-threshold-row" hidden>
      <input id="sm-overage-threshold" type="range" min="10" max="99" step="1" value="85" />
      <span id="sm-overage-threshold-val">85%</span>
    </div>
    <span id="sm-overage-dirty" hidden>Unsaved changes</span>
    <span id="sm-overage-status" hidden></span>
    <button id="sm-overage-apply" type="button" disabled>Apply</button>
  `;

  main.appendChild(view);
  document.body.appendChild(main);
  return { main, view, groupSelect, account, models };
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

  const url = pathToFileURL(
    path.resolve(__dirname, '..', 'public', 'settings.js'),
  ).href + '?t=' + (++counter);
  const mod = await import(url);
  return { window, mod, ...dom };
}

// fetch stub: serves the models payload, 503 for everything else, and records
// every POST to /api/settings/models/prefs so tests can assert staging.
function stubFetch(payload, prefsResponse) {
  const posts = [];
  const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const notFound = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  const impl = (u, opts = {}) => {
    const method = opts.method || 'GET';
    if (u === '/api/settings/models' && method === 'GET') return ok(payload);
    if (u === '/api/settings/models/prefs' && method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return prefsResponse ? ok(prefsResponse) : notFound();
    }
    return notFound();
  };
  return { impl, posts };
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const click = (node, win) => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

test('account: overage controls populate from the shared models payload on open', async () => {
  const { impl } = stubFetch(modelsPayload({ onOverage: 'stop', overageThreshold: { enabled: true, value: 40 } }));
  const { window, mod } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const d = window.document;
  assert.equal(d.querySelector('#sm-overage [data-overage="stop"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.querySelector('#sm-overage [data-overage="none"]').getAttribute('aria-pressed'), 'false');
  assert.equal(d.getElementById('sm-overage-threshold-enabled').checked, true);
  assert.equal(d.getElementById('sm-overage-threshold').value, '40');
  assert.equal(d.getElementById('sm-overage-threshold-val').textContent, '40%');
  assert.equal(d.getElementById('sm-overage-threshold-row').hidden, false);
  assert.equal(d.getElementById('sm-overage-apply').disabled, true, 'Apply disabled when clean');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, true, 'no dirty hint when clean');
  window.happyDOM.abort();
});

test('account: the Account group option reveals the account panel', async () => {
  const { impl } = stubFetch(modelsPayload({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } }));
  const { window, mod, groupSelect } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();

  groupSelect.value = 'account';
  groupSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.getElementById('settings-account').hidden, false);
  assert.equal(window.document.getElementById('settings-models').hidden, true);
  window.happyDOM.abort();
});

test('account: editing stages behind Apply — nothing persists until Apply is clicked', async () => {
  const { impl, posts } = stubFetch(modelsPayload({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } }));
  const { window, mod } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const d = window.document;
  click(d.querySelector('#sm-overage [data-overage="stop-resume"]'), window);

  assert.equal(d.querySelector('#sm-overage [data-overage="stop-resume"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, false, 'dirty hint shown');
  assert.equal(d.getElementById('sm-overage-apply').disabled, false, 'Apply enabled');
  assert.equal(posts.length, 0, 'no prefs POST fired on a staged edit');
  window.happyDOM.abort();
});

test('account: Apply commits {onOverage, overageThreshold} and re-syncs to server values', async () => {
  // Server clamps 99 → stays 99, but returns the canonical committed shape which
  // the client re-syncs to (proving clearOverageDirty→renderModels ordering).
  const server = modelsPayload({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 99 } });
  const { impl, posts } = stubFetch(
    modelsPayload({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } }),
    server,
  );
  const { window, mod } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const d = window.document;
  click(d.querySelector('#sm-overage [data-overage="stop-resume"]'), window);
  d.getElementById('sm-overage-threshold-enabled').checked = true;
  d.getElementById('sm-overage-threshold-enabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  const slider = d.getElementById('sm-overage-threshold');
  slider.value = '95';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));

  click(d.getElementById('sm-overage-apply'), window);
  await tick();

  assert.equal(posts.length, 1, 'exactly one prefs POST on Apply');
  assert.deepEqual(posts[0], { onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 95 } });

  // Re-synced to the server's committed values, dirty cleared, status shown.
  assert.equal(d.getElementById('sm-overage-threshold').value, '99', 're-synced to server value');
  assert.equal(d.getElementById('sm-overage-threshold-val').textContent, '99%');
  assert.equal(d.getElementById('sm-overage-apply').disabled, true, 'Apply disabled after commit');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, true, 'dirty hint cleared');
  const status = d.getElementById('sm-overage-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /applied/i);
  window.happyDOM.abort();
});

test('account: a failed Apply keeps the edit staged (dirty preserved, error shown)', async () => {
  // prefsResponse omitted → POST returns 503, so onApplyOveragePrefs throws.
  const { impl } = stubFetch(modelsPayload({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } }));
  const { window, mod } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const d = window.document;
  click(d.querySelector('#sm-overage [data-overage="stop"]'), window);
  click(d.getElementById('sm-overage-apply'), window);
  await tick();

  assert.equal(d.getElementById('sm-overage-apply').disabled, false, 'still dirty after a failed Apply');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, false);
  const status = d.getElementById('sm-overage-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /failed/i);
  window.happyDOM.abort();
});

test('account: a prefs save elsewhere (e.g. a tier toggle) does not clobber a staged, un-applied overage edit', async () => {
  // Two enabled tiers so the toggled checkbox isn't the last-enabled one (which
  // renderModels would render disabled).
  const initial = modelsPayload({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } });
  initial.tiers = [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }];
  initial.enabledTiers = { fast: true, powerful: true };

  // What the tier-toggle POST echoes back — different onOverage/threshold than
  // what we're about to stage locally, standing in for "server state moved
  // elsewhere while this edit sat un-applied".
  const refreshed = modelsPayload({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 20 } });
  refreshed.tiers = initial.tiers;
  refreshed.enabledTiers = { fast: false, powerful: true };

  const { impl, posts } = stubFetch(initial, refreshed);
  const { window, mod } = await setup(impl);
  mod.installSettings({ requestClose: () => {} });

  window.location.hash = '#settings';
  await window.happyDOM.waitUntilComplete();
  await tick();

  const d = window.document;

  // Stage an Account edit without Apply — smOverageDirty becomes true.
  click(d.querySelector('#sm-overage [data-overage="stop"]'), window);
  d.getElementById('sm-overage-threshold-enabled').checked = true;
  d.getElementById('sm-overage-threshold-enabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  const slider = d.getElementById('sm-overage-threshold');
  slider.value = '60';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(d.querySelector('#sm-overage [data-overage="stop"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, false, 'dirty hint shown before the outside refresh');

  // Something elsewhere — a tier-enable toggle on the Models page — POSTs prefs
  // and re-renders from the response, which carries different overage values.
  const fastCheckbox = d.querySelector('#sm-tier-list .sm-enable[data-tier="fast"]');
  fastCheckbox.checked = false;
  fastCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  assert.equal(posts.length, 1, 'the tier toggle posted prefs and triggered a renderModels refresh');

  // The staged Account edit must still be in place — the guard blocked the clobber.
  assert.equal(d.querySelector('#sm-overage [data-overage="stop"]').getAttribute('aria-pressed'), 'true', 'staged action preserved');
  assert.equal(d.querySelector('#sm-overage [data-overage="stop-resume"]').getAttribute('aria-pressed'), 'false', 'server value from elsewhere did not overwrite the staged edit');
  assert.equal(d.getElementById('sm-overage-threshold-enabled').checked, true, 'staged threshold-enabled preserved');
  assert.equal(d.getElementById('sm-overage-threshold').value, '60', 'staged threshold value preserved');
  assert.equal(d.getElementById('sm-overage-dirty').hidden, false, 'still dirty after the outside refresh');
  window.happyDOM.abort();
});
