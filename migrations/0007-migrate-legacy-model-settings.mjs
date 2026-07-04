// Migration 0007: rewrite legacy `models` keys in `settings.json` to their
// current equivalents, then drop the legacy keys.
//
// Before: `models.autoStopOnOverage: true` meant "stop on overage" and
//         `models.fable5Enabled: false` meant "hide the fable family".
// After:  `models.onOverage: 'stop'` / `models.enabledFamilies: {...}`.
//
// Mirrors the exact read-time semantics that used to live in
// src/appSettings.js's getOnOverageAction/getEnabledFamilies: a legacy key
// only takes effect when the *current* key is unset, and only a legacy
// value of `true` (onOverage) / `false` (fable5Enabled) has any effect —
// any other legacy value is simply discarded once the key is deleted.
//
// Scope: a single file in the central store, `<root>/.code-conductor/settings.json`.
// Idempotent: a no-op once neither legacy key is present.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0007-migrate-legacy-model-settings';

// Default projects root = parent dir of the repo (migrations/0007…mjs →
// ../../). Mirrors src/projects.js's DEFAULT_PROJECTS_ROOT; kept self-
// contained per the migrations conventions.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Hardcoded rather than imported from src/modelVersions.js (migrations use
// built-ins only). Matches MODEL_FAMILIES's family set at the time this
// migration was written: fable, opus, sonnet, haiku — all default true.
const ENABLED_FAMILIES_DEFAULTS = { fable: true, opus: true, sonnet: true, haiku: true };

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
  const file = path.join(projectsRoot, '.code-conductor', 'settings.json');

  const settings = await readJsonSafe(file);
  if (!settings || typeof settings !== 'object' || !settings.models || typeof settings.models !== 'object') {
    return { applied: false };
  }

  const models = settings.models;
  const hasLegacyOverage = 'autoStopOnOverage' in models;
  const hasLegacyFamilies = 'fable5Enabled' in models;
  if (!hasLegacyOverage && !hasLegacyFamilies) return { applied: false };

  let onOverageMigrated = false;
  if (hasLegacyOverage) {
    if (models.onOverage === undefined && models.autoStopOnOverage === true) {
      models.onOverage = 'stop';
      onOverageMigrated = true;
    }
    delete models.autoStopOnOverage;
  }

  let enabledFamiliesMigrated = false;
  if (hasLegacyFamilies) {
    if (models.enabledFamilies === undefined && models.fable5Enabled === false) {
      models.enabledFamilies = { ...ENABLED_FAMILIES_DEFAULTS, fable: false };
      enabledFamiliesMigrated = true;
    }
    delete models.fable5Enabled;
  }

  await writeJsonAtomic(file, settings);
  log(`  ✓ migrated legacy model settings keys in ${file}`);
  return { applied: true, summary: { onOverageMigrated, enabledFamiliesMigrated } };
}
