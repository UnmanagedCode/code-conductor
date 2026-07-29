// Migration 0024: turn the hardcoded `claude`/`ollama` provider union into the
// data-driven backend REGISTRY.
//
// Before (settings.json `models`):
//   models.tierBackend[tier]  = { kind:'claude'|'ollama', model[, window] }
//   models.roleBackend[role]  = { kind:'tier', tier } | { kind:'claude'|'ollama', model[, window] }
//   models.customBackends     = [{ label, model, contextWindow? }]      (all ollama-served)
//   (no models.backends)
// After:
//   models.backends           = [{ id:'claude'|'ollama', label, template, env:[] }]
//   models.tierBackend[tier]  = { backend:'claude'|'ollama', model[, window] }
//   models.roleBackend[role]  = { kind:'tier', tier } | { backend, model[, window] }
//   models.customModels       = [{ label, model, backend:'ollama', contextWindow }]
//
// Bindings are re-keyed in place: `kind` becomes `backend` with the same value.
// Tier-REFERENCE role bindings ({kind:'tier',tier}) are left alone — they carry
// no backend, and rewriting them would invent one. Iterating Object.values()
// over roleBackend covers plugin-role override keys ('<plugin-id>/<slug>') for
// free, since they live in the same flat map.
//
// Custom models gain the two fields the registry makes mandatory: `backend`
// (every pre-existing custom model was ollama-served, so 'ollama') and
// `contextWindow`, which is now REQUIRED. A row that never declared one is
// backfilled from the frozen curated-catalog snapshot below when its tag matches,
// else 200000 — the display default the old optional-window path used.
//
// Also reshapes the `<store>/session-backends.json` sidecar from the
// map-of-string form {sessions:{sid: model|null}} to {sessions:{sid:{backend,
// model}}}, CARRYING the existing tagged model across (it is the authority for a
// tag the jsonl can't hold — losing it would resume `foo:cloud` as the
// unpullable `foo`). Every pre-existing entry was ollama-backed by construction.
// Note the post-0024 reader (src/sessionBackends.js) skips string values, so a
// store left un-migrated degrades to "no record" (a plain claude resume) rather
// than crashing.
//
// Idempotent: settings is a no-op once `models.backends` exists; the sidecar is a
// no-op once its first entry is already an object. Silent on an empty root.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0024-backend-registry';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Frozen snapshot of MANAGED_BACKENDS (src/modelVersions.js) at write time —
// migrations use built-ins only, no import from src/.
const MANAGED_BACKENDS = [
  { id: 'claude', label: 'Claude', template: '', env: [] },
  { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [] },
];

// Frozen snapshot of OLLAMA_CLOUD_MODELS' tag → contextWindow at write time.
const CURATED_WINDOWS = {
  'deepseek-v4-flash:cloud': 1000000,
  'qwen3.5:cloud': 256000,
  'glm-5.2:cloud': 1000000,
  'deepseek-v4-pro:cloud': 1000000,
  'kimi-k2.7-code:cloud': 256000,
  'minimax-m3:cloud': 1000000,
  'mistral-large-3:675b-cloud': 256000,
};
// The window the old optional-contextWindow path displayed when none was set.
const FALLBACK_WINDOW = 200000;

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}
async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const storeDir = path.join(projectsRoot, '.code-conductor');
  const settingsFile = path.join(storeDir, 'settings.json');
  const sidecarFile = path.join(storeDir, 'session-backends.json');

  let didSettings = false;
  let rekeyed = 0;
  let customModels = 0;
  let sidecarSessions = null;

  const settings = await readJsonSafe(settingsFile);
  if (settings && typeof settings === 'object' && settings.models && typeof settings.models === 'object') {
    const models = settings.models;
    if (!Array.isArray(models.backends)) {
      models.backends = MANAGED_BACKENDS.map(b => ({ ...b, env: [] }));

      // `kind` → `backend`, same value. Skips tier-reference role bindings.
      const rekey = (binding) => {
        if (!binding || typeof binding !== 'object') return;
        if (binding.kind === 'tier') return;
        if (typeof binding.kind !== 'string') return;
        binding.backend = binding.kind;
        delete binding.kind;
        rekeyed += 1;
      };
      if (models.tierBackend && typeof models.tierBackend === 'object') {
        for (const b of Object.values(models.tierBackend)) rekey(b);
      }
      if (models.roleBackend && typeof models.roleBackend === 'object') {
        // Flat map — built-in, user-custom AND plugin-role ('<id>/<slug>')
        // override keys are all covered by iterating values.
        for (const b of Object.values(models.roleBackend)) rekey(b);
      }

      // customBackends → customModels, all bound to the built-in ollama backend.
      if (Array.isArray(models.customBackends)) {
        models.customModels = models.customBackends
          .filter(b => b && typeof b.label === 'string' && typeof b.model === 'string')
          .map(b => ({
            label: b.label,
            model: b.model,
            backend: 'ollama',
            contextWindow: (typeof b.contextWindow === 'number' && Number.isFinite(b.contextWindow) && b.contextWindow > 0)
              ? Math.round(b.contextWindow)
              : (CURATED_WINDOWS[b.model] ?? FALLBACK_WINDOW),
          }));
        customModels = models.customModels.length;
      }
      delete models.customBackends;

      await writeJsonAtomic(settingsFile, settings);
      didSettings = true;
    }
  }

  const sidecar = await readJsonSafe(sidecarFile);
  const sessions = sidecar && typeof sidecar === 'object' && sidecar.sessions
    && typeof sidecar.sessions === 'object' && !Array.isArray(sidecar.sessions)
    ? sidecar.sessions : null;
  if (sessions) {
    const entries = Object.entries(sessions);
    // Already reshaped once every value is an object (or there is nothing left).
    const needsWork = entries.some(([, v]) => typeof v !== 'object' || v === null);
    if (needsWork) {
      const next = {};
      for (const sid of Object.keys(sessions).sort((a, b) => a.localeCompare(b))) {
        const v = sessions[sid];
        if (v && typeof v === 'object') {
          // Mixed store (partially migrated) — pass an already-shaped record on.
          next[sid] = { backend: typeof v.backend === 'string' && v.backend ? v.backend : 'ollama', model: typeof v.model === 'string' && v.model ? v.model : null };
        } else {
          // Carry the tag across; a legacy null stays null (resume falls back to
          // the jsonl and self-heals on the next mark).
          next[sid] = { backend: 'ollama', model: typeof v === 'string' && v ? v : null };
        }
      }
      await writeJsonAtomic(sidecarFile, { sessions: next });
      sidecarSessions = Object.keys(next).length;
    }
  }

  if (!didSettings && sidecarSessions === null) return { applied: false };
  const parts = [];
  if (didSettings) parts.push(`seeded backend registry (re-keyed ${rekeyed} binding${rekeyed === 1 ? '' : 's'}, ${customModels} custom model${customModels === 1 ? '' : 's'})`);
  if (sidecarSessions !== null) parts.push(`reshaped ${sidecarSessions} session-backends entr${sidecarSessions === 1 ? 'y' : 'ies'}`);
  log(`  ✓ ${parts.join(' + ')}`);
  return {
    applied: true,
    summary: { settings: didSettings, rekeyed, customModels, sidecar: sidecarSessions },
  };
}
