// The reasoning-effort vocabulary — the CLI's `--effort` axis.
//
// Deliberately its own module, NOT part of the model/tier catalog in
// modelVersions.js: effort and the capability tiers are distinct vocabularies
// (a tier says which model, an effort says how hard it thinks) and keeping them
// in separate modules is what stops the two word-sets bleeding into each other.
//
// Pure vocabulary, no imports — the STORE side (per-tier / per-role defaults)
// and the precedence chain live in appSettings.js `resolveSpawnEffort`.

// Ordered low → high; the UI renders selects straight from this array.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// End of the precedence chain: what a spawn runs at when neither the caller nor
// the tier/role it spawned on has an opinion.
export const DEFAULT_EFFORT = 'high';

// Role-only sentinel: "follow the tier this role is bound to". Not a level, so
// it is never accepted for a TIER (a tier has nothing to inherit from) and never
// reaches `--effort`.
export const INHERIT_EFFORT = 'inherit';

export function isKnownEffort(effort) {
  return typeof effort === 'string' && EFFORT_LEVELS.includes(effort);
}
