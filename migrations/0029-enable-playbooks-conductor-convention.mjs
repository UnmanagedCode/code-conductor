// Migration 0029: enable the new `playbooks` conductor-convention slug for
// existing installs.
//
// SEED_CONVENTIONS' "default enabled" fallback (src/conductorConventions.ts
// getSelection()) only applies when conventions/conductor.json has NO
// `enabled` key at all — i.e. a truly fresh install. Any install that has
// already persisted a selection (opened Settings → Conventions → Conductor,
// or toggled anything) has an `enabled` array that predates this slug
// (added 9fb304e, 2026-08-05, with no migration), so the new convention
// would otherwise sit unchecked forever: `composeConduct()` gates both the
// available-playbooks listing and the preferred-playbook section behind
// `enabledSlugs.includes('playbooks')`, so a correctly-persisted
// `defaultPlaybook` selection renders nowhere. This migration retroactively
// appends the slug to any pre-existing selection, same bug class and same
// fix shape as 0015 (`context-renewal`).
//
// Scope: a single file in the central store,
// `<root>/.code-conductor/conventions/conductor.json` (post-0020 path).
// Idempotent: a no-op once `playbooks` is already present in `enabled`
// (or the file/array doesn't exist yet — a fresh install gets it from the
// SEED_CONVENTIONS fallback with no store file needed).
//
// Accepted consequence (same as 0021's note): the store cannot distinguish
// "predates the slug" from "the user deliberately unchecked it", so a
// deliberate opt-out — if one ever happened after 2026-08-05 but before this
// migration ran — is re-enabled once. Matches 0015's precedent.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0029-enable-playbooks-conductor-convention';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const NEW_SLUG = 'playbooks';

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
  if (store.enabled.includes(NEW_SLUG)) return { applied: false };

  store.enabled = [...store.enabled, NEW_SLUG];
  await writeJsonAtomic(file, store);
  log(`  ✓ enabled new slug '${NEW_SLUG}' in existing conductor conventions selection in ${file}`);
  return { applied: true, summary: { addedSlug: NEW_SLUG } };
}
