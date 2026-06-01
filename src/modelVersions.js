// Curated catalog of selectable Claude model *versions*, grouped by family
// (Sonnet / Opus / Haiku), offered in the Settings → Models group. Single
// source of truth: the API ships this list to the frontend (so the picker
// isn't duplicated client-side) AND it doubles as the allow-list that gates
// the per-family switch endpoint — only a (family, id) pair present here may
// be activated, keeping arbitrary strings out of the spawn `--model` flag.
//
// `id` is the bare CLI model identifier (no context-window suffix). The
// 200k/1M context-window choice is NOT part of this catalog — it stays a
// spawn-time picker affordance keyed to the family (Opus bare = 1M, `[200k]`
// forces 200k; Sonnet bare = 200k, `[1m]` opts into 1M; Haiku 200k-only).
// The pickers recombine `configuredId + ctx suffix` at click time, so the
// `[200k]`/`[1m]` handling in src/instances.js is unaffected.

export const MODEL_FAMILIES = [
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
    family: 'opus',
    label: 'Opus',
    default: 'claude-opus-4-8',
    versions: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
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
