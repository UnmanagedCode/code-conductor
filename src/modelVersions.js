// Curated catalog of selectable Claude model *versions*, grouped by family
// (Sonnet / Opus / Haiku), offered in the Settings → Models group. Single
// source of truth: the API ships this list to the frontend (so the picker
// isn't duplicated client-side) AND it doubles as the allow-list that gates
// the per-family Settings endpoint — only a (family, id) pair present here
// may be activated via Settings.
//
// `id` is the bare CLI model identifier. Context-window policy is one fixed
// window per family (no per-spawn choice), except Sonnet, which is
// per-version: Opus → 1M (bare CLI default); Haiku → 200k (no 1M build);
// Sonnet 5 has no 200k build, so it's pinned to `[1m]` via the `fixedWindow`
// flag on its catalog entry below; Sonnet 4.x has both builds and remains
// user-selectable — the chosen window rides on the individual tier/role
// binding (`binding.window`), not a global preference.
// `canonicalizeModel()` below applies that policy and is the single source
// of truth; the client mirrors it in public/models.js.
//
// This catalog is also the BACKEND CATALOG for the capability-tier layer
// below: each tier binds to one of these families via Settings
// (`getTierBackend`/`setTierBackend` in appSettings.js). A legacy caller
// passing a family name directly (`opus`, `sonnet`, ...) still resolves here
// unchanged, independent of any tier→backend binding — see spawnInstance in
// src/mcp/handlers.js.

export const MODEL_FAMILIES = [
  {
    family: 'fable',
    label: 'Fable',
    default: 'claude-fable-5',
    versions: [
      { id: 'claude-fable-5', label: 'Fable 5' },
    ],
  },
  {
    family: 'opus',
    label: 'Opus',
    default: 'claude-opus-4-8',
    versions: [
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    ],
  },
  {
    family: 'sonnet',
    label: 'Sonnet',
    default: 'claude-sonnet-5',
    versions: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5', fixedWindow: '1m' },
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

// --- Backends -----------------------------------------------------------
// A BACKEND is a launch recipe: `template` is the command that replaces
// `claude` on the argv, with `{model}` standing in for the model id. An empty
// template means "run `claude` directly" (the identity backend). Backends are
// user-manageable DATA (Settings → Backends, persisted as `models.backends` —
// see appSettings.js getBackends), so adding a provider is a settings row, not
// a code change.
//
// These two are MANAGED: their id/label/template/managed come from here, not
// from the store, so `ollama`'s template can't drift and `claude` can't be
// removed. Only their `env` is user-editable. appSettings.getBackends() layers
// the user's rows on top and re-asserts these.
//
// A tier/role binding is {backend, model}: for 'claude' the model is a
// MODEL_FAMILIES version id; for any other backend it's whatever that backend's
// models are identified by (an Ollama tag, say — see Settings → Models custom
// models).
export const MANAGED_BACKENDS = [
  { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
  { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
];

export const MANAGED_BACKEND_IDS = MANAGED_BACKENDS.map(b => b.id);

// The identity backend — the one that runs `claude` itself. Everything that
// used to branch on `backendKind === 'ollama'` now branches on
// `backend !== CLAUDE_BACKEND_ID` (i.e. "is this a substitution backend?"), so
// a user-defined backend gets the same treatment the built-in ollama row does.
export const CLAUDE_BACKEND_ID = 'claude';

// --- Capability tiers ---------------------------------------------------
// Fixed, data-driven set of abstract capability tiers exposed to spawn
// callers (UI pickers + MCP `spawn_instance`). Each tier is a bindable slot
// that maps (via Settings, see appSettings.js `getTierBackend`) to a
// {backend, model} pair. Renaming a tier, or changing the tier count, is a
// one-line change to this array.
export const CAPABILITY_TIERS = [
  { tier: 'fast',      label: 'Fast' },
  { tier: 'balanced',  label: 'Balanced' },
  { tier: 'powerful',  label: 'Powerful' },
  { tier: 'frontier',  label: 'Frontier' },
];

// Default tier → {backend, model} binding — each tier's Claude family default
// version.
export const DEFAULT_TIER_BACKEND = {
  fast:     { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.haiku },
  balanced: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.sonnet },
  powerful: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.opus },
  frontier: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.fable },
};

export function isKnownTier(tier) {
  return CAPABILITY_TIERS.some(t => t.tier === tier);
}

// --- Roles --------------------------------------------------------------
// Data-driven set of named roles, a second bindable layer parallel to the
// capability tiers. A role binds (via Settings, see appSettings.js
// `getRoleBinding`) to EITHER a capability tier ({kind:'tier', tier}) — follow
// whatever that tier points at — or a concrete backend ({backend, model}, the
// same shape a tier uses). Adding a role is a one-line change to this array.
export const ROLES = [
  { role: 'conductor', label: 'Conductor' },
  { role: 'reviewer',  label: 'Reviewer' },
];

// Default role → binding. Both point at the `powerful` tier out of the box.
export const DEFAULT_ROLE_BINDING = {
  conductor: { kind: 'tier', tier: 'powerful' },
  reviewer:  { kind: 'tier', tier: 'powerful' },
};

export function isKnownRole(role) {
  return ROLES.some(r => r.role === role);
}

export function isKnownVersion(family, id) {
  const f = MODEL_FAMILIES.find(x => x.family === family);
  return !!f && f.versions.some(v => v.id === id);
}

// A model id is a known Claude version if any family lists it (family-agnostic
// — a tier binding stores a concrete version id, not a family).
export function isKnownClaudeModel(id) {
  return MODEL_FAMILIES.some(f => f.versions.some(v => v.id === id));
}

export function defaultVersion(family) {
  return MODEL_FAMILIES.find(f => f.family === family)?.default ?? null;
}

// Infer the Claude family from a bare or suffixed model id, by prefix. Returns
// null for anything that isn't a Claude id (any other backend's model id
// included) — which is exactly what makes canonicalizeModel a no-op for
// non-Claude models, so a tagged id survives resume untouched.
export function familyOf(modelId) {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Returns the pinned suffix for a specific (family, bare-id) version, if the
// catalog fixes it (e.g. Sonnet 5 has no 200k build), or undefined if the
// version defers to the sonnetWindow preference instead.
function fixedWindowFor(family, id) {
  const v = MODEL_FAMILIES.find(f => f.family === family)?.versions.find(x => x.id === id);
  return v?.fixedWindow;
}

// Single source of truth for context-window policy. Strips any existing
// `[200k]`/`[1m]` suffix first so recovered ids normalise cleanly.
// Opus → 1M bare (CLI default); Haiku → 200k bare (no 1M build). Sonnet's
// window is per-version: a version can pin `fixedWindow` in the catalog
// (Sonnet 5 — no 200k build, always `[1m]`) or defer to the `sonnetWindow`
// preference (Sonnet 4.x — user-selectable via Settings → Models).
export function canonicalizeModel(modelId, { sonnetWindow = '1m' } = {}) {
  if (typeof modelId !== 'string' || !modelId) return modelId;
  const bare = modelId.replace(/\[(200k|1m)\]$/, '');
  const family = familyOf(bare);
  if (family !== 'sonnet') return bare;
  const window = fixedWindowFor('sonnet', bare) || sonnetWindow;
  return window === '200k' ? bare : `${bare}[1m]`;
}

// True if a model id's context window is user-selectable — i.e. a Sonnet
// version with no catalog-pinned `fixedWindow` (Sonnet 4.x). Used to gate
// where a per-binding `window` is meaningful: Sonnet 5 (fixedWindow) and every
// non-Sonnet family ignore any binding window, so we don't persist one there.
export function sonnetWindowSelectable(id) {
  if (typeof id !== 'string') return false;
  const bare = id.replace(/\[(200k|1m)\]$/, '');
  return familyOf(bare) === 'sonnet' && !fixedWindowFor('sonnet', bare);
}
