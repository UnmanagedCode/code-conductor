// The New Session dialog's Effort control, driven through the real
// public/spawnDialog.js with happy-dom.
//
// The load-bearing claim: the UI does NOT resolve the effort chain. It shows the
// selected tier's server-resolved default as `Default (<level>)`, and on spawn it
// sends the TIER and omits `effort` — so the server's resolveSpawnEffort is the
// only place the precedence lives, and the browser path genuinely exercises it.
// The Conduct button does the same with `role:'conductor'`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];

// The REAL `<select id="sd-effort">` markup, lifted out of public/index.html rather
// than hand-written here: the leading `<option value="">` is the anchor the whole
// "leave it on Default and let the server resolve" contract hangs on (spawnDialog.js
// reads `dom.sdEffort.value || undefined` and relabels `option[value=""]`), so a
// hand-copied select would let someone delete that option with these tests still green.
const INDEX_HTML = readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
const SD_EFFORT_MARKUP = (() => {
  const m = INDEX_HTML.match(/<select id="sd-effort">[\s\S]*?<\/select>/);
  if (!m) throw new Error('public/index.html no longer has a <select id="sd-effort"> — update this test');
  return m[0];
})();

// Mirrors GET /api/settings/models for the fields models.js caches.
function modelsPayload(tierEffort) {
  return {
    backends: [{ id: 'claude', label: 'Claude', managed: true }],
    claudeFamilies: [{
      family: 'opus', label: 'Opus', default: 'claude-opus-4-8',
      versions: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }],
    }],
    tiers: TIERS.map(t => ({ tier: t, label: t })),
    tierBackend: Object.fromEntries(TIERS.map(t => [t, { backend: 'claude', model: 'claude-opus-4-8' }])),
    tierEffort,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
    roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
    roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'high' } },
    enabledTiers: Object.fromEntries(TIERS.map(t => [t, true])),
    defaultSpawnTier: 'powerful',
    customModels: [], ollamaCloudModels: [], ollamaCloudTierDefaults: {},
  };
}

function buildDOM(document) {
  const host = document.createElement('div');
  host.innerHTML = `
    <dialog id="spawn-dialog">
      <form method="dialog">
        <span id="sd-project"></span>
        <div class="quick-spawn-models">
          ${TIERS.map(t => `<button type="button" class="qs-model" data-tier="${t}"><span class="qs-sublabel"></span></button>`).join('')}
        </div>
        <button type="button" id="sd-mode-code" aria-pressed="true"></button>
        <button type="button" id="sd-mode-plan" aria-pressed="false"></button>
        ${SD_EFFORT_MARKUP}
        <select id="sd-thinking"><option value="adaptive" selected>adaptive</option></select>
        <input id="sd-worktree" type="checkbox" />
        <span id="sd-worktree-hint"></span>
        <input id="sd-temp" type="checkbox" />
        <input id="sd-debug" type="checkbox" />
        <div id="sd-error"></div>
        <details id="sd-advanced"><summary>Advanced</summary></details>
        <div id="sd-hook-result" hidden><span id="sd-hook-summary"></span><pre id="sd-hook-output"></pre></div>
        <button type="submit" id="sd-spawn" value="spawn">Spawn</button>
      </form>
    </dialog>
    <button type="button" id="conduct-btn"></button>
  `;
  document.body.appendChild(host);
  const g = (id) => document.getElementById(id);
  const spawnDialog = g('spawn-dialog');
  // happy-dom's <dialog> has no showModal/close-with-returnValue behaviour we can
  // rely on; the module only needs them to exist, and the tests drive the `close`
  // event (which is what carries the POST) directly.
  spawnDialog.showModal = () => { spawnDialog.setAttribute('open', ''); };
  return {
    dom: {
      spawnDialog,
      sdProject: g('sd-project'),
      sdModeCode: g('sd-mode-code'),
      sdModePlan: g('sd-mode-plan'),
      sdEffort: g('sd-effort'),
      sdThinking: g('sd-thinking'),
      sdWorktree: g('sd-worktree'),
      sdWorktreeHint: g('sd-worktree-hint'),
      sdTemp: g('sd-temp'),
      sdDebug: g('sd-debug'),
      sdError: g('sd-error'),
      sdHookResult: g('sd-hook-result'),
      sdHookSummary: g('sd-hook-summary'),
      sdHookOutput: g('sd-hook-output'),
      sdSpawn: g('sd-spawn'),
      sdAdvanced: g('sd-advanced'),
      conductBtn: g('conduct-btn'),
    },
  };
}

async function setup(tierEffort) {
  const spawns = [];
  const window = new Window({ url: 'http://localhost/' });
  const fetchImpl = (u, opts = {}) => {
    const method = opts.method || 'GET';
    const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (u === '/api/settings/models') return ok(modelsPayload(tierEffort));
    if (u === '/api/settings/spawn') return ok({ debugByDefault: false });
    if (u === '/api/projects/.conduct/ensure') return ok({ ok: true });
    if (u === '/api/instances' && method === 'POST') {
      spawns.push(JSON.parse(opts.body));
      return ok({ id: 'i1' });
    }
    return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  };
  window.fetch = fetchImpl;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.fetch = fetchImpl;
  globalThis.alert = () => {};

  const { dom } = buildDOM(window.document);
  // NOT cache-busted, deliberately: spawnDialog.js imports './models.js' by its
  // plain path, so a busted copy here would be a SECOND models.js instance and the
  // dialog would read an unseeded cache. Sharing one instance is safe because each
  // test re-seeds it via loadModelVersions() below with its own payload.
  const models = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'models.js')).href);
  const mod = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'spawnDialog.js')).href);
  await models.loadModelVersions();   // seeds the client cache from the payload
  const handles = mod.installSpawnDialog({
    dom,
    getProjects: () => [{ name: 'p', isGitRepo: true }],
    refreshProjects: async () => {},
    refreshInstances: async () => {},
    selectInstance: () => {},
    closeSidebarOverflow: () => {},
  });
  return { window, dom, handles, spawns };
}

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const defaultOptionText = (dom) => dom.sdEffort.querySelector('option[value=""]').textContent;
// The POST rides the dialog's `close` event with returnValue 'spawn'.
async function closeWithSpawn(window, dom) {
  dom.spawnDialog.returnValue = 'spawn';
  dom.spawnDialog.dispatchEvent(new window.Event('close'));
  await tick();
}

test('opening the dialog labels Default with the default tier\'s effort', async () => {
  // `powerful` (the configured default tier) is deliberately NOT on the global
  // fallback level here: a broken lookup would render 'Default (high)' and pass.
  const { dom, handles } = await setup({ fast: 'low', balanced: 'medium', powerful: 'xhigh', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  assert.equal(dom.sdEffort.value, '', 'opens on Default — the tier decides');
  assert.equal(defaultOptionText(dom), 'Default (xhigh)', 'the configured default tier is powerful');
});

test('clicking a tier card re-labels the Default option', async () => {
  const { window, dom, handles } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();

  for (const [tier, level] of [['frontier', 'max'], ['fast', 'low'], ['balanced', 'medium']]) {
    dom.spawnDialog.querySelector(`.qs-model[data-tier="${tier}"]`)
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(defaultOptionText(dom), `Default (${level})`,
      `the label follows the ${tier} tier's own effort`);
  }
});

test('spawning on Default sends the tier and NO effort — the server resolves it', async () => {
  const { window, dom, handles, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  dom.spawnDialog.querySelector('.qs-model[data-tier="frontier"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  await closeWithSpawn(window, dom);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].tier, 'frontier', 'the tier travels so the server can resolve its effort');
  assert.ok(!('effort' in spawns[0]) || spawns[0].effort === undefined,
    'no effort is sent — sending one (even the right level) would bypass the server chain');
});

test('picking an explicit level sends it as the override', async () => {
  const { window, dom, handles, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  dom.sdEffort.value = 'xhigh';

  await closeWithSpawn(window, dom);

  assert.equal(spawns[0].effort, 'xhigh');
  assert.equal(spawns[0].tier, 'powerful', 'the tier still rides along (it also picks the model)');
});

test('the Conduct button sends role:conductor and no effort', async () => {
  const { window, dom, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  dom.conductBtn.dispatchEvent(new window.Event('click'));
  await tick(20);

  assert.equal(spawns.length, 1, 'Conduct spawns directly, no dialog');
  assert.equal(spawns[0].project, '.conduct');
  assert.equal(spawns[0].role, 'conductor',
    "the Conductor role travels so ITS default effort applies (not the spawn dialog's tier)");
  assert.equal(spawns[0].effort, undefined);
});

// The client cache's own fallbacks (public/models.js), which every test above
// bypasses by supplying a complete `tierEffort`. Uses its OWN cache-busted
// models.js instance so the pre-fetch state is genuinely unseeded.
test('models.js: pre-fetch reads the DEFAULT_EFFORT seed, then adopts the payload\'s defaultEffort', async () => {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  const models = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'public', 'models.js')).href + '?prefetch=1');

  // Before any fetch: the seed mirrors src/effortLevels.js DEFAULT_EFFORT, so a
  // first paint can't advertise a level the server would never resolve.
  for (const t of TIERS) assert.equal(models.getActiveTierEffort(t), 'high');

  // After the fetch: a tier the payload omits falls back to the SHIPPED default,
  // not to the stale seed.
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ ...modelsPayload({ balanced: 'max' }), defaultEffort: 'medium' }),
  });
  await models.loadModelVersions();
  assert.equal(models.getActiveTierEffort('balanced'), 'max', 'a shipped level wins');
  assert.equal(models.getActiveTierEffort('frontier'), 'medium', 'an absent one uses defaultEffort');
});

test('public/index.html anchors the Default option: first, value="", pre-selected', async () => {
  const { dom } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  const opts = [...dom.sdEffort.options];
  assert.equal(opts[0].value, '', 'the empty-value option exists and is FIRST');
  assert.equal(dom.sdEffort.value, '', 'the shipped markup pre-selects it');
  // The remaining entries are the real levels, in order, with no stray duplicate
  // of the removed hardcoded `selected` on `high`.
  assert.deepEqual(opts.slice(1).map(o => o.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opts.filter(o => o.value === '').length, 1);
});
