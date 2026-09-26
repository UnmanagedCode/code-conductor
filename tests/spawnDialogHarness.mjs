// Shared DOM/bootstrap harness for the tests that drive the real
// public/spawnDialog.js under happy-dom. Not a `.test.mjs` file, so
// tests/run.mjs's readdir discovery skips it (same precedent as
// tests/idleWakeCase.mjs).

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];

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
export function modelsPayload(tierEffort) {
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

export function buildDOM(document) {
  const host = document.createElement('div');
  host.innerHTML = `
    <dialog id="spawn-dialog">
      <form method="dialog">
        <span id="sd-project"></span>
        <div class="quick-spawn-models">
          ${TIERS.map(t => `<button type="button" class="qs-model" data-tier="${t}"><span class="qs-sublabel"></span></button>`).join('')}
        </div>
        <button type="button" id="sd-mode-plan" aria-pressed="false"></button>
        <button type="button" id="sd-mode-code" aria-pressed="true"></button>
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

export async function setup(tierEffort, { projects } = {}) {
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
    getProjects: () => projects ?? [{ name: 'p', isGitRepo: true }],
    refreshProjects: async () => {},
    refreshInstances: async () => {},
    selectInstance: () => {},
    closeSidebarOverflow: () => {},
  });
  return { window, dom, handles, spawns };
}

export const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
// The POST rides the dialog's `close` event with returnValue 'spawn'.
export async function closeWithSpawn(window, dom) {
  dom.spawnDialog.returnValue = 'spawn';
  dom.spawnDialog.dispatchEvent(new window.Event('close'));
  await tick();
}

