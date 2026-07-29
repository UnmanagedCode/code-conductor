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
// SUPERSEDES 0017. 0017's idempotency probe was "does some tierBackend value have
// a `kind` key?" — which this migration removes, so leaving 0017 registered would
// make it re-run on every later boot and reset every tier binding to its Claude
// default. 0017 is therefore unregistered (see migrations/index.mjs) and the
// pre-0017 shapes it used to normalize are absorbed here:
//   - models.tierBackend[tier] as a STRING: a family key ('opus') resolving to
//     that family's active version (models[family] ?? the catalog default), or
//     'ollama:<slug>' resolving to that custom backend's tag by id;
//   - models.customBackends entries carrying the dropped `id` / `host` fields;
//   - the dead per-family active-version keys (models.opus = '…');
//   - the pre-0017 sidecar form {backends:{sid:{kind}}} (0018 only handles the
//     intermediate {sessions:[…]} set form, and still runs before this).
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

// Frozen snapshots of the catalog at write time, for the absorbed 0017 shapes.
const FAMILY_DEFAULT_VERSION = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const DEFAULT_TIER_FAMILY = { fast: 'haiku', balanced: 'sonnet', powerful: 'opus', frontier: 'fable' };
const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];

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

      // Absorbed from 0017: a pre-0017 STRING tierBackend value. Materialize the
      // binding it stood for before the re-key sweep below sees it.
      const oldCustom = Array.isArray(models.customBackends) ? models.customBackends : [];
      const tagById = new Map(oldCustom.filter(b => b && typeof b.id === 'string').map(b => [b.id, b.model]));
      const claudeBinding = (family) => ({
        backend: 'claude',
        model: (typeof models[family] === 'string' && models[family]) ? models[family] : FAMILY_DEFAULT_VERSION[family],
      });
      if (models.tierBackend && typeof models.tierBackend === 'object') {
        for (const tier of TIERS) {
          const v = models.tierBackend[tier];
          if (typeof v !== 'string') continue;
          if (v.startsWith('ollama:')) {
            const tag = tagById.get(v);
            models.tierBackend[tier] = tag ? { backend: 'ollama', model: tag } : claudeBinding(DEFAULT_TIER_FAMILY[tier]);
          } else if (FAMILIES.includes(v)) {
            models.tierBackend[tier] = claudeBinding(v);
          } else {
            models.tierBackend[tier] = claudeBinding(DEFAULT_TIER_FAMILY[tier]);
          }
          rekeyed += 1;
        }
      }
      // Absorbed from 0017: the dead per-family active-version keys.
      for (const f of FAMILIES) delete models[f];

      if (models.tierBackend && typeof models.tierBackend === 'object') {
        for (const b of Object.values(models.tierBackend)) rekey(b);
      }
      if (models.roleBackend && typeof models.roleBackend === 'object') {
        // Flat map — built-in, user-custom AND plugin-role ('<id>/<slug>')
        // override keys are all covered by iterating values.
        for (const b of Object.values(models.roleBackend)) rekey(b);
      }

      // customBackends → customModels, all bound to the built-in ollama backend.
      // Absorbed from 0017: a pre-0017 entry may still carry `id` / `host`; taking
      // only the four fields below drops them.
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
  // Absorbed from 0017: the pre-0017 form {backends:{sid:{kind}}} — only the
  // ollama-kind entries were ever sessions on a non-claude backend. The model was
  // not carried in that form, so it lands model-unknown (resume falls back to the
  // jsonl and self-heals on the next mark), exactly as 0017→0018 produced.
  if (sidecar && typeof sidecar === 'object' && sidecar.backends && typeof sidecar.backends === 'object') {
    const next = {};
    for (const sid of Object.keys(sidecar.backends).sort((a, b) => a.localeCompare(b))) {
      const rec = sidecar.backends[sid];
      if (rec && rec.kind === 'ollama') next[sid] = { backend: 'ollama', model: null };
    }
    if (Object.keys(next).length) await writeJsonAtomic(sidecarFile, { sessions: next });
    else { try { await fs.unlink(sidecarFile); } catch { /* ignore */ } }
    sidecarSessions = Object.keys(next).length;
  }
  const sessions = sidecarSessions === null && sidecar && typeof sidecar === 'object' && sidecar.sessions
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
