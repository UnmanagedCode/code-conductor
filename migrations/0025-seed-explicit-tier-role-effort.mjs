// Migration 0025: pin an EXISTING install's per-tier / per-role default effort to
// today's behaviour, before the new Settings → Models effort controls could move it.
//
// Before:
//   models.tierEffort — absent (every spawn ran at the hardcoded DEFAULT_EFFORT)
//   models.roleEffort — absent
// After:
//   models.tierEffort = { fast:'high', balanced:'high', powerful:'high', frontier:'high' }
//   models.roleEffort = { <each known role>: 'inherit' }
//
// Every spawn used to run at 'high' unless the caller passed `effort` explicitly.
// Pinning the four tiers to an explicit 'high' means a later change to the code
// default can never silently re-tune an existing workspace.
//
// Roles are pinned to 'inherit' — "follow the bound tier" — NOT to 'high'. That is
// still an explicit stored value (a change to the role code default can't move it)
// and it resolves to 'high' today because this same migration pins every tier to
// 'high', so behaviour is unchanged. Writing 'high' onto roles instead would freeze
// them out of tier inheritance permanently: a user who later sets Frontier → 'max'
// would see a tier-bound Conductor follow on a fresh install but not on a migrated
// one. Identical behaviour now, identical semantics later.
//
// Roles seeded: the built-in ones (frozen snapshot below), every role that already
// has a stored binding under models.roleBackend (custom + plugin overrides), and
// every models.customRoles name. A PLUGIN role with no stored binding can't be
// enumerated from disk (plugin roles are live-derived from enabled plugins) — it
// simply keeps the 'inherit' code default, which resolves through the tier value
// pinned here, so it is unaffected either way.
//
// A workspace with no settings.json, or one whose settings.json has no `models`
// namespace, is left alone: it has no bindings at all and resolves to 'high'
// everywhere from code, so there is nothing to preserve — and inventing a `models`
// namespace would write settings the user never touched.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0025-seed-explicit-tier-role-effort';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Frozen snapshots of the catalogs as they stand at this migration (CAPABILITY_TIERS
// / ROLES in src/modelVersions.js) — deliberately copied, not imported.
const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];
const BUILTIN_ROLES = ['conductor', 'reviewer'];

// The effort every spawn ran at before this feature (DEFAULT_EFFORT), and the
// role sentinel meaning "follow the bound tier" (INHERIT_EFFORT).
const PINNED_TIER_EFFORT = 'high';
const PINNED_ROLE_EFFORT = 'inherit';

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
  if (!settings || typeof settings !== 'object' || !settings.models || typeof settings.models !== 'object') {
    return { applied: false };
  }
  const models = settings.models;
  // Idempotency probe: key presence, not per-tier completeness — a partially
  // populated tierEffort is the user's own doing and must not be overwritten.
  if ('tierEffort' in models) return { applied: false };

  const tierEffort = {};
  for (const tier of TIERS) tierEffort[tier] = PINNED_TIER_EFFORT;

  const roleNames = new Set(BUILTIN_ROLES);
  if (models.roleBackend && typeof models.roleBackend === 'object') {
    for (const role of Object.keys(models.roleBackend)) roleNames.add(role);
  }
  if (Array.isArray(models.customRoles)) {
    for (const role of models.customRoles) if (typeof role === 'string' && role) roleNames.add(role);
  }
  const roleEffort = {};
  for (const role of roleNames) roleEffort[role] = PINNED_ROLE_EFFORT;

  models.tierEffort = tierEffort;
  models.roleEffort = roleEffort;
  await writeJsonAtomic(settingsFile, settings);

  log(`  ✓ pinned ${TIERS.length} tier(s) to effort '${PINNED_TIER_EFFORT}' and ${roleNames.size} role(s) to '${PINNED_ROLE_EFFORT}'`);
  return { applied: true, summary: { tiers: TIERS.length, roles: roleNames.size } };
}
