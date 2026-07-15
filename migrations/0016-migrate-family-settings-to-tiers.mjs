// Migration 0016: rewrite family-scoped spawn prefs in `settings.json`'s
// `models` namespace to the new tier-scoped shape, and seed a default
// tier→backend binding.
//
// Before: `models.enabledFamilies: {fable,opus,sonnet,haiku}` gated which
//         family cards the spawn pickers showed; `models.defaultFamily`
//         picked the pre-selected card.
// After:  `models.enabledTiers: {fast,balanced,powerful,frontier}` +
//         `models.defaultTier` play the same role one layer up; a new
//         `models.tierBackend` binds each tier to a family (fresh concept —
//         no prior data to carry over, so it's always seeded to the default
//         binding below).
//
// `models[family] = versionId` (per-backend active version), `onOverage`,
// `sonnetContextWindow`, and the compact-window/overage-threshold keys are
// untouched — they stay backend-level/global prefs, unaffected by tiers.
//
// Scope: a single file in the central store, `<root>/.code-conductor/settings.json`.
// Idempotent: a no-op once neither legacy key is present.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0016-migrate-family-settings-to-tiers';

// Default projects root = parent dir of the repo (migrations/0016…mjs →
// ../../). Mirrors src/projects.js's DEFAULT_PROJECTS_ROOT; kept self-
// contained per the migrations conventions.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Hardcoded rather than imported from src/modelVersions.js (migrations use
// built-ins only). Matches DEFAULT_TIER_BACKEND's inverse at the time this
// migration was written: fast→haiku, balanced→sonnet, powerful→opus,
// frontier→fable.
const FAMILY_TO_DEFAULT_TIER = { haiku: 'fast', sonnet: 'balanced', opus: 'powerful', fable: 'frontier' };
const DEFAULT_TIER_BACKEND = { fast: 'haiku', balanced: 'sonnet', powerful: 'opus', frontier: 'fable' };
const DEFAULT_SPAWN_TIER = 'powerful';

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
  const hasLegacyEnabled = 'enabledFamilies' in models;
  const hasLegacyDefault = 'defaultFamily' in models;
  if (!hasLegacyEnabled && !hasLegacyDefault) return { applied: false };

  if (hasLegacyEnabled) {
    const legacy = models.enabledFamilies;
    const enabledTiers = {};
    for (const [family, tier] of Object.entries(FAMILY_TO_DEFAULT_TIER)) {
      enabledTiers[tier] = legacy && typeof legacy === 'object' ? legacy[family] !== false : true;
    }
    models.enabledTiers = enabledTiers;
    delete models.enabledFamilies;
  }

  if (hasLegacyDefault) {
    const legacyDefault = models.defaultFamily;
    models.defaultTier = FAMILY_TO_DEFAULT_TIER[legacyDefault] ?? DEFAULT_SPAWN_TIER;
    delete models.defaultFamily;
  }

  if (models.tierBackend === undefined) {
    models.tierBackend = { ...DEFAULT_TIER_BACKEND };
  }

  await writeJsonAtomic(file, settings);
  log(`  ✓ migrated family-scoped model settings to tiers in ${file}`);
  return { applied: true, summary: { migratedEnabled: hasLegacyEnabled, migratedDefault: hasLegacyDefault } };
}
