// Curated catalog of selectable Claude model *versions*, grouped by family
// (Sonnet / Opus / Haiku), offered in the Settings → Models group. Single
// source of truth: the API ships this list to the frontend (so the picker
// isn't duplicated client-side) AND it doubles as the allow-list that gates
// the per-family Settings endpoint — only a (family, id) pair present here
// may be activated via Settings.
//
// `id` is the bare CLI model identifier. Every entry declares exactly ONE
// numeric `contextWindow` (raw tokens) — its native capacity — plus an optional
// `launchTag`, the suffix the CLI needs to actually get that capacity
// (Sonnet 4.x ships separate 200k/1M builds, so its 1M capacity is only
// reachable as `…[1m]`; every other model's native window is the bare id's
// default). There is no per-spawn window choice and no routing selector: one
// model, one capacity.
//
// `contextWindow` is the authoritative capacity for a `claude`-backend model —
// read it via claudeContextWindowTokens(), and for a concrete {backend, model}
// pair via resolveContextWindowTokens() in appSettings.ts, which is the single
// place capacity is resolved. `canonicalizeModel()` below owns the launch-tag
// half of the policy.
//
// This catalog is the `claude` BACKEND's model list (shipped as the
// `claudeFamilies` payload key); the backend catalog proper is the user-managed
// registry — see MANAGED_BACKENDS below and appSettings.getBackends(). A tier
// binds to a {backend, model} pair via Settings
// (`getTierBackend`/`setTierBackend` in appSettings.ts). A legacy caller
// passing a family name directly (`opus`, `sonnet`, ...) still resolves here
// unchanged, independent of any tier binding — see spawnInstance in
// src/mcp/handlers.js.

export type FamilyName = 'fable' | 'opus' | 'sonnet' | 'haiku';
export type TierName = 'fast' | 'balanced' | 'powerful' | 'frontier';
export type RoleName = 'conductor' | 'reviewer';

export interface ModelVersion {
  id: string;
  label: string;
  contextWindow: number;
  launchTag?: string;
}

export interface ModelFamily {
  family: FamilyName;
  label: string;
  default: string;
  versions: readonly ModelVersion[];
}

export interface BackendRecord {
  id: string;
  label: string;
  template: string;
  env: readonly { key: string; value: string }[];
  managed: boolean;
}

export interface CapabilityTier {
  tier: TierName;
  label: string;
}

export interface Role {
  role: RoleName;
  label: string;
}

export interface BackendBinding {
  backend: string;
  model: string;
}

export interface TierBinding {
  kind: 'tier';
  tier: TierName;
}

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  {
    family: 'fable',
    label: 'Fable',
    default: 'claude-fable-5',
    versions: [
      { id: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000 },
    ],
  },
  {
    family: 'opus',
    label: 'Opus',
    default: 'claude-opus-4-8',
    versions: [
      { id: 'claude-opus-5', label: 'Opus 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-7', label: 'Opus 4.7', contextWindow: 1_000_000 },
    ],
  },
  {
    family: 'sonnet',
    label: 'Sonnet',
    default: 'claude-sonnet-5',
    versions: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1_000_000 },
      // Sonnet 4.x is the only family with separate 200k/1M builds; its 1M
      // capacity is reachable only via the `[1m]` tag, so it always launches
      // tagged.
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 1_000_000, launchTag: '[1m]' },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', contextWindow: 1_000_000, launchTag: '[1m]' },
    ],
  },
  {
    family: 'haiku',
    label: 'Haiku',
    default: 'claude-haiku-4-5',
    versions: [
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', contextWindow: 200_000 },
    ],
  },
];

// Convenience map of family → default version id. Built from MODEL_FAMILIES,
// which lists exactly the FamilyName keys, so the resulting record genuinely
// has all four.
export const DEFAULT_VERSIONS: Record<FamilyName, string> = Object.fromEntries(
  MODEL_FAMILIES.map(f => [f.family, f.default]),
) as Record<FamilyName, string>;

export function isKnownFamily(family: unknown): boolean {
  return MODEL_FAMILIES.some(f => f.family === family);
}

// --- Backends -----------------------------------------------------------
// A BACKEND is a launch recipe: `template` is the command that replaces
// `claude` on the argv, with `{model}` standing in for the model id. An empty
// template means "run `claude` directly" (the identity backend). Backends are
// user-manageable DATA (Settings → Backends, persisted as `models.backends` —
// see appSettings.ts getBackends), so adding a provider is a settings row, not
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
export const MANAGED_BACKENDS: readonly BackendRecord[] = [
  { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
  { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
];

export const MANAGED_BACKEND_IDS: readonly string[] = MANAGED_BACKENDS.map(b => b.id);

// The identity backend — the one that runs `claude` itself. Everything that
// used to branch on `backendKind === 'ollama'` now branches on
// `backend !== CLAUDE_BACKEND_ID` (i.e. "is this a substitution backend?"), so
// a user-defined backend gets the same treatment the built-in ollama row does.
export const CLAUDE_BACKEND_ID = 'claude';

// --- Capability tiers ---------------------------------------------------
// Fixed, data-driven set of abstract capability tiers exposed to spawn
// callers (UI pickers + MCP `spawn_instance`). Each tier is a bindable slot
// that maps (via Settings, see appSettings.ts `getTierBackend`) to a
// {backend, model} pair. Renaming a tier, or changing the tier count, is a
// one-line change to this array.
export const CAPABILITY_TIERS: readonly CapabilityTier[] = [
  { tier: 'fast',      label: 'Fast' },
  { tier: 'balanced',  label: 'Balanced' },
  { tier: 'powerful',  label: 'Powerful' },
  { tier: 'frontier',  label: 'Frontier' },
];

// Default tier → {backend, model} binding — each tier's Claude family default
// version.
export const DEFAULT_TIER_BACKEND: Record<TierName, BackendBinding> = {
  fast:     { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.haiku },
  balanced: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.sonnet },
  powerful: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.opus },
  frontier: { backend: CLAUDE_BACKEND_ID, model: DEFAULT_VERSIONS.fable },
};

export function isKnownTier(tier: unknown): boolean {
  return CAPABILITY_TIERS.some(t => t.tier === tier);
}

// --- Roles --------------------------------------------------------------
// Data-driven set of named roles, a second bindable layer parallel to the
// capability tiers. A role binds (via Settings, see appSettings.ts
// `getRoleBinding`) to EITHER a capability tier ({kind:'tier', tier}) — follow
// whatever that tier points at — or a concrete backend ({backend, model}, the
// same shape a tier uses). Adding a role is a one-line change to this array.
export const ROLES: readonly Role[] = [
  { role: 'conductor', label: 'Conductor' },
  { role: 'reviewer',  label: 'Reviewer' },
];

// Default role → binding. Both point at the `powerful` tier out of the box.
export const DEFAULT_ROLE_BINDING: Record<RoleName, TierBinding> = {
  conductor: { kind: 'tier', tier: 'powerful' },
  reviewer:  { kind: 'tier', tier: 'powerful' },
};

export function isKnownRole(role: unknown): boolean {
  return ROLES.some(r => r.role === role);
}

export function isKnownVersion(family: unknown, id: unknown): boolean {
  const f = MODEL_FAMILIES.find(x => x.family === family);
  return !!f && f.versions.some(v => v.id === id);
}

// A model id is a known Claude version if any family lists it (family-agnostic
// — a tier binding stores a concrete version id, not a family).
export function isKnownClaudeModel(id: unknown): boolean {
  return MODEL_FAMILIES.some(f => f.versions.some(v => v.id === id));
}

export function defaultVersion(family: unknown): string | null {
  return MODEL_FAMILIES.find(f => f.family === family)?.default ?? null;
}

// Infer the Claude family from a bare or suffixed model id, by prefix. Returns
// null for anything that doesn't LOOK like a Claude id.
//
// This is a naming heuristic, not a backend test, and must never be used as
// one. A substitution backend is free to serve a model whose id happens to
// start with `claude-`, and conversely a non-Claude id tells you nothing about
// which registry row serves it. Only the `backend` field decides that — see
// canonicalizeModel below, which gates on it explicitly.
export function familyOf(modelId: unknown): FamilyName | null {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Terminal `[1m]`/`[200k]` build tag. Only meaningful on a `claude` model id.
const LAUNCH_TAG_RE = /\[(200k|1m)\]$/;

// Catalog lookup for a bare Claude version id.
function claudeVersion(bareId: string): ModelVersion | null {
  for (const f of MODEL_FAMILIES) {
    const v = f.versions.find(x => x.id === bareId);
    if (v) return v;
  }
  return null;
}

// Native context window (raw tokens) for a `claude`-backend model id, or null
// when the catalog doesn't know it (an unlisted/future `claude-*` id). Null
// means "unknown" and must render as unknown — never as a fabricated default.
// Tolerates a launch tag on the way in.
export function claudeContextWindowTokens(modelId: unknown): number | null {
  if (typeof modelId !== 'string' || !modelId) return null;
  const v = claudeVersion(modelId.replace(LAUNCH_TAG_RE, ''));
  const n = v?.contextWindow;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// Apply the launch-tag half of context-window policy: return the exact model id
// to put on the CLI's `--model`.
//
// `backend` is a REQUIRED positional, and the gate below is the ONLY thing that
// makes this a no-op for a substitution backend. Do not reintroduce a
// family/prefix test in its place: a non-Claude model id is an OPAQUE,
// byte-exact registry key that may legitimately end in `[1m]` or look
// Claude-shaped, and stripping it desynchronises this.model from the key the
// registry is stored under — which silently drops the context env vars, breaks
// `{model}` substitution, and poisons the session sidecar.
//
// Omitting the argument yields `undefined !== CLAUDE_BACKEND_ID` → verbatim,
// i.e. it fails toward preserving the caller's id rather than mangling it.
export function canonicalizeModel(modelId: string | undefined, backend: string | undefined): string | undefined {
  if (typeof modelId !== 'string' || !modelId) return modelId;
  if (backend !== CLAUDE_BACKEND_ID) return modelId;
  const bare = modelId.replace(LAUNCH_TAG_RE, '');
  return `${bare}${claudeVersion(bare)?.launchTag ?? ''}`;
}
