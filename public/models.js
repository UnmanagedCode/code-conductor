// Client-side cache + resolver for the model catalog (Settings → Models). The
// spawn pickers carry only a `tier` (fast/balanced/powerful/frontier); a tier
// resolves via its {backend, model} binding to the spawn args {model, backend}
// — backend 'claude' (model = a MODEL_FAMILIES version id) or any other registry
// id (model = one of that backend's custom models / curated presets). Catalog
// fetched once at boot, refreshed on Settings changes.
//
// This module holds NO context-window policy. Every model has exactly one
// native capacity, resolved server-side from {backend, model} and delivered as
// the instance summary's `contextWindowTokens`; the launch tag some Claude
// builds need is applied server-side too (canonicalizeModel). A client mirror
// of either would be a second source of truth that drifts.

// Pre-fetch fallback version ids (one per family) — only used to seed the
// default tier bindings before the boot fetch resolves.
const DEFAULT_VERSIONS = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

// Friendly names for the pre-fetch fallback ids above — overwritten by the
// shipped catalog's per-version `label` field once loadModelVersions() resolves.
const DEFAULT_VERSION_LABELS = {
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-haiku-4-5': 'Haiku 4.5',
};

// The identity backend id (mirrors CLAUDE_BACKEND_ID in src/modelVersions.ts).
export const CLAUDE_BACKEND = 'claude';

// Pre-fetch fallback tier→{backend,model} bindings (mirrors DEFAULT_TIER_BACKEND
// in src/modelVersions.ts). Overwritten by the shipped catalog at boot.
const DEFAULT_TIER_BACKEND = {
  fast:     { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.haiku },
  balanced: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.sonnet },
  powerful: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.opus },
  frontier: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.fable },
};
const DEFAULT_TIER_LABELS = { fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful', frontier: 'Frontier' };

// Pre-fetch fallback role→binding (mirrors DEFAULT_ROLE_BINDING in
// src/modelVersions.ts). A role binds to a tier ({kind:'tier',tier}) or a
// concrete {backend,model}. Overwritten by the shipped catalog at boot.
const DEFAULT_ROLE_BINDING = {
  conductor: { kind: 'tier', tier: 'powerful' },
  reviewer:  { kind: 'tier', tier: 'powerful' },
};

// First-paint seed for the end of the effort chain (mirrors DEFAULT_EFFORT in
// src/effortLevels.ts) — replaced by the payload's `defaultEffort` on the boot
// fetch, so the shipped value is the single source and this is only what a
// pre-fetch read sees. Read for DISPLAY only: the spawn dialog's `Default (…)`
// label. The client never resolves the effort chain itself (that is
// resolveSpawnEffort, src/appSettings.ts).
let defaultEffort = 'high';

let activeTierEffort = {};
let activeTierEnabled = { fast: true, balanced: true, powerful: true, frontier: true };
let activeDefaultSpawnTier = 'powerful';
let activeTierBackend = { ...DEFAULT_TIER_BACKEND };
let claudeVersionLabelById = {};
let tierList = Object.keys(DEFAULT_TIER_BACKEND);
let tierLabels = { ...DEFAULT_TIER_LABELS };
let activeRoleBinding = { ...DEFAULT_ROLE_BINDING };
// First-paint fallback of the backend REGISTRY — the two managed rows. A
// fallback only; the server's registry (which also carries user rows) replaces it
// on the boot fetch.
let backends = [{ id: CLAUDE_BACKEND, label: 'Claude', managed: true }, { id: 'ollama', label: 'Ollama', managed: true }];
let customModels = []; // [{label, model, backend, contextWindow}]
let ollamaCloudModels = []; // curated catalog [{label, model, contextWindow}], scoped to the built-in `ollama` backend

export function getTierList() { return tierList; }
export function getTierLabel(tier) { return tierLabels[tier] || tier; }
// Returns the role's binding (a tier binding {kind:'tier',tier} or a concrete
// {backend,model}), falling back to the pre-fetch default.
export function getActiveRoleBinding(role) { return activeRoleBinding[role] || DEFAULT_ROLE_BINDING[role]; }
export function setActiveRoleBindings(map) { activeRoleBinding = { ...activeRoleBinding, ...(map || {}) }; }
export function setBackends(list) { backends = Array.isArray(list) && list.length ? list : backends; return backends; }
export function getBackendLabel(id) { return backends.find(b => b.id === id)?.label || id; }
export function getCustomModels() { return customModels; }
export function setCustomModels(list) { customModels = Array.isArray(list) ? list : []; return customModels; }
export function setOllamaCloudModels(list) { ollamaCloudModels = Array.isArray(list) ? list : []; return ollamaCloudModels; }

// Infer the Claude family from a model id, by prefix. Mirrors familyOf() in
// src/modelVersions.ts. A naming heuristic for grouping the Settings picker —
// never a backend test; only a binding's `backend` field says which registry row
// serves a model.
export function familyOf(modelId) {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Backend id of a {backend, model} tier binding.
export function backendIdOf(binding) {
  return (binding && typeof binding.backend === 'string' && binding.backend) || CLAUDE_BACKEND;
}

// Friendly display name for a Claude version id (e.g. "Opus 4.8"), falling
// back to the pre-fetch default label, then the raw id itself.
export function getVersionLabel(id) { return claudeVersionLabelById[id] || DEFAULT_VERSION_LABELS[id] || id; }

export function getActiveTierEnabled(tier) { return activeTierEnabled[tier] !== false; }
export function setActiveTierEnabled(map) { activeTierEnabled = { ...activeTierEnabled, ...(map || {}) }; }
export function getActiveDefaultSpawnTier() { return activeDefaultSpawnTier; }
export function setActiveDefaultSpawnTier(v) { activeDefaultSpawnTier = v || 'powerful'; return activeDefaultSpawnTier; }

// Returns the tier's {backend, model} binding (fallback default if unset).
export function getActiveTierBackend(tier) { return activeTierBackend[tier] || DEFAULT_TIER_BACKEND[tier]; }
export function setActiveTierBackend(map) { activeTierBackend = { ...activeTierBackend, ...(map || {}) }; }

// The effort a spawn on this tier runs at, as resolved SERVER-side and shipped in
// the models payload. Display-only.
export function getActiveTierEffort(tier) { return activeTierEffort[tier] || defaultEffort; }
export function setActiveTierEffort(map) { activeTierEffort = { ...activeTierEffort, ...(map || {}) }; }
export function setDefaultEffort(level) { if (level) defaultEffort = level; return defaultEffort; }

export async function loadModelVersions() {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.claudeFamilies) && data.claudeFamilies.length) {
        claudeVersionLabelById = Object.fromEntries(
          data.claudeFamilies.flatMap(b => b.versions || []).map(v => [v.id, v.label]),
        );
      }
      if (Array.isArray(data.tiers) && data.tiers.length) {
        tierList = data.tiers.map(t => t.tier);
        tierLabels = Object.fromEntries(data.tiers.map(t => [t.tier, t.label]));
      }
      setBackends(data.backends);
      if (data.tierBackend) setActiveTierBackend(data.tierBackend);
      setDefaultEffort(data.defaultEffort);
      if (data.tierEffort) setActiveTierEffort(data.tierEffort);
      if (data.roleBackend) setActiveRoleBindings(data.roleBackend);
      if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
      setActiveDefaultSpawnTier(data.defaultSpawnTier);
      setCustomModels(data.customModels);
      setOllamaCloudModels(data.ollamaCloudModels);
    }
  } catch { /* keep defaults */ }
  return activeTierBackend;
}

// Resolve a tier to the spawn args {model, backend} — the binding's ids
// verbatim. No launch tag is applied here: that is catalog policy, owned by
// canonicalizeModel() server-side, which sees the authoritative `backend`.
export function resolveSpawnModel(tier) {
  const b = getActiveTierBackend(tier);
  if (!b || !b.model) return { model: '', backend: CLAUDE_BACKEND };
  return { model: b.model, backend: backendIdOf(b) };
}

// Resolve a role to the spawn args {model, backend}. A tier binding delegates to
// resolveSpawnModel (mirrors the server's resolveRoleBackend); a concrete
// binding resolves like a tier's own {backend, model}.
export function resolveSpawnRole(role) {
  const b = getActiveRoleBinding(role);
  if (b && b.kind === 'tier') return resolveSpawnModel(b.tier);
  if (!b || !b.model) return { model: '', backend: CLAUDE_BACKEND };
  return { model: b.model, backend: backendIdOf(b) };
}
