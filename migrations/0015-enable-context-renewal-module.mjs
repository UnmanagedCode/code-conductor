// Migration 0015: enable the new `context-renewal` conductor-module slug for
// existing installs.
//
// SEED_MODULES' "default enabled" fallback (src/conductModules.js
// getSelection()) only applies when conduct-modules.json has NO `enabled` key
// at all — i.e. a truly fresh install. Any install that has already persisted
// a selection (opened Settings → Conventions → Conductor, or toggled
// anything) has an `enabled` array that predates this slug, so the new
// module would otherwise sit unchecked until a user notices and opts in. The
// whole point of `context-renewal` is that TODAY's long-lived conductors
// adopt the renewal discipline, not just future fresh installs — so this
// migration retroactively appends the slug to any pre-existing selection.
//
// Scope: a single file in the central store, `<root>/.code-conductor/conduct-modules.json`.
// Idempotent: a no-op once `context-renewal` is already present in `enabled`
// (or the file/array doesn't exist yet — a fresh install gets it from the
// SEED_MODULES fallback with no store file needed).
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0015-enable-context-renewal-module';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const NEW_SLUG = 'context-renewal';

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const file = path.join(projectsRoot, '.code-conductor', 'conduct-modules.json');

  const store = await readJsonSafe(file);
  if (!store || typeof store !== 'object' || !Array.isArray(store.enabled)) {
    return { applied: false };
  }
  if (store.enabled.includes(NEW_SLUG)) return { applied: false };

  store.enabled = [...store.enabled, NEW_SLUG];
  await writeJsonAtomic(file, store);
  log(`  ✓ enabled new slug '${NEW_SLUG}' in existing conductor modules selection in ${file}`);
  return { applied: true, summary: { addedSlug: NEW_SLUG } };
}
