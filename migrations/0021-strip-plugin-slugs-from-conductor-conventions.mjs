// Migration 0021: strip plugin conductor-convention slugs out of the seed/custom
// `enabled` array in the conductor conventions store.
//
// Runs AFTER 0020-consolidate-convention-stores, which relocates
// conduct-modules.json → conventions/conductor.json (a plain rename, same
// shape), so this targets the NEW path `<root>/.code-conductor/conventions/conductor.json`.
//
// Previously a manually-enabled plugin conductor convention was persisted into
// `enabled` as its namespaced `<plugin-id>/<slug>`. The model changed: a
// plugin's conductor conventions are ON by default while the plugin is enabled
// (derived from the live catalog), and only the user's explicit OFF-switches
// persist (`pluginOff`). `enabled` now holds seed/custom slugs only.
//
// This is cosmetic cleanup so `enabled` is clean — a leftover `<id>/<slug>` is
// harmless (getSelection filters non-seed/custom slugs out of the base), but we
// remove it so the persisted file matches the current shape. We deliberately do
// NOT move these into `pluginOff`: they were user-ENABLED, and under the new
// model an enabled plugin's conventions are on by default, so leaving them out
// of pluginOff keeps them on.
//
// Consequence (accepted): a convention that was default-OFF under the old model
// (never ticked) turns ON after upgrade for an already-enabled plugin. That is
// the intended new behavior — on-by-default — not a regression.
//
// Idempotent: a no-op once `enabled` holds no `/`-slug.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0021-strip-plugin-slugs-from-conductor-conventions';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const isPluginSlug = s => typeof s === 'string' && s.includes('/');

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
  const file = path.join(projectsRoot, '.code-conductor', 'conventions', 'conductor.json');

  const store = await readJsonSafe(file);
  if (!store || typeof store !== 'object' || !Array.isArray(store.enabled)) {
    return { applied: false };
  }
  const stripped = store.enabled.filter(isPluginSlug);
  if (stripped.length === 0) return { applied: false };

  store.enabled = store.enabled.filter(s => !isPluginSlug(s));
  await writeJsonAtomic(file, store);
  log(`  ✓ stripped ${stripped.length} plugin convention slug(s) from enabled in ${file}`);
  return { applied: true, summary: { stripped } };
}
