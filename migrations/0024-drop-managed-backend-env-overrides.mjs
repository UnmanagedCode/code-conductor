// Migration 0024: drop any stored managed-row env overrides from models.backends.
//
// Before: a managed backend (`claude`, `ollama`) accepted an `env` edit, which
// updateBackend persisted as a `{id, env}` entry inside models.backends.
// getBackends() then layered that stored env onto the code-authoritative
// managed row. Managed env is now fully code-authoritative (empty, from
// MANAGED_BACKENDS in src/modelVersions.js) — getBackends() no longer reads a
// managed row's env from the store, so any such stored entry is dead data this
// migration strips, exactly mirroring how the managed label/template were
// always code-authoritative and never stored.
//
// Safe to drop: managed env is empty by definition (MANAGED_BACKENDS carries
// `env: []`), and the cc-managed context-window vars are applied separately in
// Instance.spawn() after the backend's own env. User rows in models.backends
// are passed through untouched.
//
// Idempotent: a no-op once no models.backends entry has a managed id. Silent on
// an empty root / a store with no models.backends array.
//
// Frozen artifact — do not edit. Uses Node built-ins only (per migrations.md).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0024-drop-managed-backend-env-overrides';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Frozen snapshot of the managed-backend ids at write time (mirrors
// MANAGED_BACKEND_IDS in src/modelVersions.js). Never import from ../src/ —
// migrations stay faithful to the world they were written for.
const MANAGED_IDS = ['claude', 'ollama'];

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
  const settingsFile = path.join(projectsRoot, '.code-conductor', 'settings.json');

  const settings = await readJsonSafe(settingsFile);
  if (!settings || typeof settings !== 'object'
      || !settings.models || typeof settings.models !== 'object'
      || !Array.isArray(settings.models.backends)) {
    return { applied: false };
  }

  const before = settings.models.backends;
  const after = before.filter(b => !(b && typeof b.id === 'string' && MANAGED_IDS.includes(b.id)));
  if (after.length === before.length) return { applied: false }; // no managed entries

  const dropped = before.length - after.length;
  settings.models.backends = after;
  await writeJsonAtomic(settingsFile, settings);
  log(`  ✓ dropped ${dropped} managed-row env override${dropped === 1 ? '' : 's'}`);
  return { applied: true, summary: { dropped } };
}