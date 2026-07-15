// Migration 0017: collapse the tier/custom-backend model to the backend-agnostic
// shape.
//
// Before (0016 + phase-3 landed):
//   models.tierBackend[tier]  = a family key ('opus') OR an 'ollama:<slug>' id
//   models.customBackends     = [{ id, label, model, host }]
//   models.<family>           = per-family active version id ('models.opus' = …)
// After:
//   models.tierBackend[tier]  = { kind:'claude'|'ollama', model:<version|tag> }
//   models.customBackends     = [{ label, model }]           (drop id + host)
//   models.<family>           deleted (subsumed — tiers store concrete versions)
//
// Each tier's CURRENT effective binding is materialized: a family key resolves
// to that family's active version (models[family] ?? catalog default); an
// 'ollama:<slug>' resolves to that custom backend's tag. Also reshapes the
// `<store>/session-backends.json` sidecar from the map form {backends:{sid:{kind}}}
// to the set form {sessions:[sid where kind==='ollama']} so a session live
// across the upgrade resumes with the right kind. Idempotent: a no-op once
// tierBackend's first value is already an object.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0017-collapse-tier-backend-to-kind-model';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Hardcoded snapshot of the catalog at write time (migrations use built-ins
// only — no import from src/).
const FAMILY_DEFAULT_VERSION = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
// fast→haiku, balanced→sonnet, powerful→opus, frontier→fable at write time.
const DEFAULT_TIER_FAMILY = { fast: 'haiku', balanced: 'sonnet', powerful: 'opus', frontier: 'fable' };
const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}
async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

function claudeBinding(family, models) {
  const model = (typeof models[family] === 'string' && models[family]) ? models[family] : FAMILY_DEFAULT_VERSION[family];
  return { kind: 'claude', model };
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const storeDir = path.join(projectsRoot, '.code-conductor');
  const settingsFile = path.join(storeDir, 'settings.json');
  const sidecarFile = path.join(storeDir, 'session-backends.json');

  let didSettings = false;
  let didSidecar = false;

  const settings = await readJsonSafe(settingsFile);
  if (settings && typeof settings === 'object' && settings.models && typeof settings.models === 'object') {
    const models = settings.models;
    const tb = models.tierBackend;
    const alreadyNew = tb && typeof tb === 'object' &&
      Object.values(tb).some(v => v && typeof v === 'object' && 'kind' in v);
    if (!alreadyNew) {
      const oldCustom = Array.isArray(models.customBackends) ? models.customBackends : [];
      const tagById = new Map(oldCustom.filter(b => b && typeof b.id === 'string').map(b => [b.id, b.model]));

      const nextTierBackend = {};
      for (const tier of TIERS) {
        const v = (tb && typeof tb === 'object') ? tb[tier] : undefined;
        if (typeof v === 'string' && v.startsWith('ollama:')) {
          const tag = tagById.get(v);
          nextTierBackend[tier] = tag ? { kind: 'ollama', model: tag } : claudeBinding(DEFAULT_TIER_FAMILY[tier], models);
        } else if (typeof v === 'string' && FAMILIES.includes(v)) {
          nextTierBackend[tier] = claudeBinding(v, models);
        } else {
          nextTierBackend[tier] = claudeBinding(DEFAULT_TIER_FAMILY[tier], models);
        }
      }
      models.tierBackend = nextTierBackend;

      // customBackends: drop id + host.
      models.customBackends = oldCustom
        .filter(b => b && typeof b.label === 'string' && typeof b.model === 'string')
        .map(b => ({ label: b.label, model: b.model }));

      // Delete dead per-family active-version keys.
      for (const f of FAMILIES) delete models[f];

      await writeJsonAtomic(settingsFile, settings);
      didSettings = true;
    }
  }

  // Reshape the ollama-session sidecar: map {backends:{sid:{kind,…}}} → set.
  const sidecar = await readJsonSafe(sidecarFile);
  if (sidecar && typeof sidecar === 'object' && sidecar.backends && typeof sidecar.backends === 'object') {
    const sessions = Object.entries(sidecar.backends)
      .filter(([, rec]) => rec && rec.kind === 'ollama')
      .map(([sid]) => sid)
      .sort((a, b) => a.localeCompare(b));
    if (sessions.length) await writeJsonAtomic(sidecarFile, { sessions });
    else { try { await fs.unlink(sidecarFile); } catch { /* ignore */ } }
    didSidecar = true;
  }

  if (!didSettings && !didSidecar) return { applied: false };
  log(`  ✓ collapsed tier bindings to {kind,model}${didSidecar ? ' + reshaped session-backends sidecar' : ''}`);
  return { applied: true, summary: { settings: didSettings, sidecar: didSidecar } };
}
