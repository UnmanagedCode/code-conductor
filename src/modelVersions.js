// Curated catalog of selectable Claude model *versions*, grouped by family
// (Sonnet / Opus / Haiku), offered in the Settings → Models group. Single
// source of truth: the API ships this list to the frontend (so the picker
// isn't duplicated client-side) AND it doubles as the allow-list that gates
// the per-family switch endpoint — only a (family, id) pair present here may
// be activated, keeping arbitrary strings out of the spawn `--model` flag.
//
// `id` is the bare CLI model identifier. Context-window policy is one fixed
// window per family (no per-spawn choice): Opus → 1M (bare CLI default),
// Sonnet → 1M (CLI-native `[1m]` suffix, since bare Sonnet is 200k), Haiku →
// 200k. `canonicalizeModel()` below applies that policy and is the single
// source of truth; the client mirrors it in public/models.js.

export const MODEL_FAMILIES = [
  {
    family: 'opus',
    label: 'Opus',
    default: 'claude-opus-4-8',
    versions: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    ],
  },
  {
    family: 'sonnet',
    label: 'Sonnet',
    default: 'claude-sonnet-4-6',
    versions: [
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    ],
  },
  {
    family: 'haiku',
    label: 'Haiku',
    default: 'claude-haiku-4-5',
    versions: [
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
  },
];

// Convenience map of family → default version id.
export const DEFAULT_VERSIONS = Object.fromEntries(
  MODEL_FAMILIES.map(f => [f.family, f.default]),
);

export function isKnownFamily(family) {
  return MODEL_FAMILIES.some(f => f.family === family);
}

export function isKnownVersion(family, id) {
  const f = MODEL_FAMILIES.find(x => x.family === family);
  return !!f && f.versions.some(v => v.id === id);
}

export function defaultVersion(family) {
  return MODEL_FAMILIES.find(f => f.family === family)?.default ?? null;
}

// Infer the family from a bare or suffixed model id, by prefix.
export function familyOf(modelId) {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Single source of truth for context-window policy: one fixed window per
// family. Sonnet → 1M requires the CLI-native `[1m]` suffix (its bare
// default is 200k); Opus → 1M is the CLI-native default (bare); Haiku →
// 200k (no 1M build, bare). Strips any stale `[200k]`/`[1m]` suffix first,
// so a model recovered from a resumed session (always bare on disk) or an
// older client string normalises to the canonical form. Unknown ids pass
// through unchanged.
export function canonicalizeModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return modelId;
  const bare = modelId.replace(/\[(200k|1m)\]$/, '');
  return familyOf(bare) === 'sonnet' ? `${bare}[1m]` : bare;
}
