// Migration 0013: drop the retired `talking-to-user` conductor-module slug
// from a persisted `enabled` selection.
//
// The `talking-to-user` module was folded into the always-on `conduct/core.md`
// and removed from SEED_MODULES (src/conductModules.js). A stored `enabled`
// array still naming it makes every subsequent compose() call (settings
// writes, ensureConductProject()) throw "unknown convention slug
// 'talking-to-user'" (400), since compose() resolves slugs against the
// live catalog with no tolerance for a retired one.
//
// Scope: a single file in the central store, `<root>/.code-conductor/conduct-modules.json`.
// Idempotent: a no-op once `talking-to-user` is absent from `enabled`.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0013-drop-retired-talking-to-user-slug';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const RETIRED_SLUG = 'talking-to-user';

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
  if (!store.enabled.includes(RETIRED_SLUG)) return { applied: false };

  store.enabled = store.enabled.filter(slug => slug !== RETIRED_SLUG);
  await writeJsonAtomic(file, store);
  log(`  ✓ dropped retired slug '${RETIRED_SLUG}' from enabled conductor modules in ${file}`);
  return { applied: true, summary: { droppedSlug: RETIRED_SLUG } };
}
