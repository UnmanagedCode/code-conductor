// Migration 0026: retire the Sonnet 200k/1M window selector, and repair
// substitution-backend model ids that the old Claude-oriented canonicalization
// truncated.
//
// Before: a tier/role binding could carry `window: '1m'|'200k'` (Sonnet 4.x
// only), and every instance/session carried a `sonnetWindow` string. Separately,
// `canonicalizeModel` stripped a terminal `[1m]`/`[200k]` from EVERY model id
// before checking whether it was a Claude id — so a substitution model
// configured as the exact registry key `gpt-5.6-sol[1m]` was recorded in the
// session sidecar / resume manifest as the truncated `gpt-5.6-sol`, which no
// longer matches its custom-model row.
//
// After: every Claude model has exactly one native context window (Sonnet 4.x
// always launches `[1m]`), so a binding is just {backend, model}; runtime state
// carries a numeric `contextWindowTokens` resolved server-side from
// {backend, model}. Canonicalization is gated on `backend`, so a substitution id
// is byte-exact from here on.
//
// CONSERVATIVE BY CONSTRUCTION — the failure mode to avoid is rewriting a model
// id that was always correct:
//   - `models.customModels[].model` is NEVER touched. It is the registry key;
//     `gpt-5.6-sol[1m]` must survive byte-exact.
//   - Only `backend === 'claude'` bindings are normalized (drop `window`, strip
//     a stray launch tag). A non-Claude binding is never rewritten.
//   - A truncated substitution model id is repaired only when EXACTLY ONE custom
//     model on that same backend matches it after removing a terminal
//     `[1m]`/`[200k]`. Zero candidates → left alone (nothing to repair against).
//     Two or more → left alone and counted `ambiguous`, because picking either
//     could silently repoint a session at the wrong model.
//
// Covers three files. `pending-resume.json` matters for SELF-UPDATE: an old
// process can write the old manifest shape moments before new code boots, and
// migrations run before restoreFromResumeManifest (server.js).
//
// Known limit: repair candidates come from `models.customModels` only. The
// curated Ollama cloud presets live in src/ (never imported here, per
// migrations.md) — they carry no `[1m]`-style tags, so they can't be truncation
// victims and their absence loses nothing.
//
// Idempotent: re-running finds nothing to change and reports {applied:false}.
//
// Frozen artifact — do not edit. Uses Node built-ins only (per migrations.md).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0026-drop-sonnet-window-state';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Frozen snapshot of the identity backend id (mirrors CLAUDE_BACKEND_ID).
const CLAUDE_BACKEND = 'claude';
const LAUNCH_TAG_RE = /\[(200k|1m)\]$/;

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Normalize one persisted {backend, model, window?} binding IN PLACE.
// Returns true if it changed. A role binding of the form {kind:'tier',tier} has
// no backend/model and is skipped untouched.
function normalizeBinding(b) {
  if (!b || typeof b !== 'object' || b.backend !== CLAUDE_BACKEND) return false;
  let changed = false;
  if ('window' in b) { delete b.window; changed = true; }
  if (typeof b.model === 'string' && LAUNCH_TAG_RE.test(b.model)) {
    // A Claude binding stores the BARE version id; the launch tag is re-applied
    // at spawn from the catalog. A stored tag is stale data, never a key.
    b.model = b.model.replace(LAUNCH_TAG_RE, '');
    changed = true;
  }
  return changed;
}

// Resolve a possibly-truncated substitution model id against the custom-model
// catalog. Returns {model, contextWindowTokens} when it can be resolved with
// certainty, {ambiguous:true} when several rows collide, or null when there is
// nothing to say.
function resolveSubstitutionModel(customModels, backend, model) {
  if (typeof backend !== 'string' || !backend || backend === CLAUDE_BACKEND) return null;
  if (typeof model !== 'string' || !model) return null;

  const onBackend = customModels.filter(m => m && m.backend === backend && typeof m.model === 'string');

  // Exact hit — the id was never truncated. Only backfill the window.
  const exact = onBackend.find(m => m.model === model);
  if (exact) {
    return Number.isFinite(exact.contextWindow)
      ? { model, contextWindowTokens: exact.contextWindow }
      : null;
  }

  // No exact row: the id may be a tag-stripped rendering of one.
  const candidates = onBackend.filter(m => m.model.replace(LAUNCH_TAG_RE, '') === model);
  if (candidates.length === 0) return null;      // unmatched — leave alone
  if (candidates.length > 1) return { ambiguous: true };
  const c = candidates[0];
  return {
    model: c.model,
    contextWindowTokens: Number.isFinite(c.contextWindow) ? c.contextWindow : null,
  };
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const storeDir = path.join(projectsRoot, '.code-conductor');
  const settingsFile = path.join(storeDir, 'settings.json');
  const sidecarFile = path.join(storeDir, 'session-backends.json');
  const manifestFile = path.join(storeDir, 'pending-resume.json');

  let migrated = 0;   // bindings normalized + capacity backfills
  let repaired = 0;   // truncated substitution ids restored to their registry key
  let ambiguous = 0;  // truncated ids left alone because several rows matched

  // ── settings.json ──────────────────────────────────────────────────────
  const settings = await readJsonSafe(settingsFile);
  const customModels = Array.isArray(settings?.models?.customModels)
    ? settings.models.customModels : [];
  let settingsChanged = false;

  if (settings?.models && typeof settings.models === 'object') {
    for (const group of ['tierBackend', 'roleBackend']) {
      const map = settings.models[group];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const key of Object.keys(map)) {
        if (normalizeBinding(map[key])) { settingsChanged = true; migrated++; }
      }
    }
  }
  if (settingsChanged) await writeJsonAtomic(settingsFile, settings);

  // ── session-backends.json ──────────────────────────────────────────────
  const sidecar = await readJsonSafe(sidecarFile);
  let sidecarChanged = false;
  if (sidecar && typeof sidecar.sessions === 'object' && sidecar.sessions && !Array.isArray(sidecar.sessions)) {
    for (const rec of Object.values(sidecar.sessions)) {
      if (!rec || typeof rec !== 'object') continue;
      const r = resolveSubstitutionModel(customModels, rec.backend, rec.model);
      if (!r) continue;
      if (r.ambiguous) { ambiguous++; continue; }
      if (r.model !== rec.model) { rec.model = r.model; repaired++; sidecarChanged = true; }
      if (Number.isFinite(r.contextWindowTokens) && rec.contextWindowTokens !== r.contextWindowTokens) {
        rec.contextWindowTokens = r.contextWindowTokens;
        migrated++;
        sidecarChanged = true;
      }
    }
  }
  if (sidecarChanged) await writeJsonAtomic(sidecarFile, sidecar);

  // ── pending-resume.json ────────────────────────────────────────────────
  const manifest = await readJsonSafe(manifestFile);
  let manifestChanged = false;
  if (manifest && Array.isArray(manifest.instances)) {
    for (const e of manifest.instances) {
      if (!e || typeof e !== 'object') continue;
      if ('sonnetWindow' in e) { delete e.sonnetWindow; manifestChanged = true; migrated++; }
      const r = resolveSubstitutionModel(customModels, e.backend, e.model);
      if (!r) continue;
      if (r.ambiguous) { ambiguous++; continue; }
      if (r.model !== e.model) { e.model = r.model; repaired++; manifestChanged = true; }
      if (Number.isFinite(r.contextWindowTokens) && e.contextWindowTokens !== r.contextWindowTokens) {
        e.contextWindowTokens = r.contextWindowTokens;
        migrated++;
        manifestChanged = true;
      }
    }
  }
  if (manifestChanged) await writeJsonAtomic(manifestFile, manifest);

  if (!settingsChanged && !sidecarChanged && !manifestChanged) {
    // Ambiguity is PERMANENT — the colliding custom-model rows are left exactly
    // as they are, so a re-run finds the same collisions. Reporting `applied`
    // for it would make this migration claim work on every single boot forever,
    // so it only ever surfaces as a warning here.
    if (ambiguous > 0) {
      log(`  ! ${ambiguous} record${ambiguous === 1 ? '' : 's'} left untouched: model id matches several custom models on the same backend`);
    }
    return { applied: false };
  }
  log(`  ✓ migrated ${migrated}, repaired ${repaired}, ambiguous ${ambiguous}`);
  return { applied: true, summary: { migrated, repaired, ambiguous } };
}
