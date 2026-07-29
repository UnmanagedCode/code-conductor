// Client-side cache + resolver for the model catalog (Settings → Models). The
// spawn pickers carry only a `tier` (fast/balanced/powerful/frontier); a tier
// resolves via its {backend, model} binding to the spawn args {model, backend}
// — backend 'claude' (model = a MODEL_FAMILIES version id) or any other registry
// id (model = one of that backend's custom models / curated presets). Catalog
// fetched once at boot, refreshed on Settings changes.
//
// Sonnet context-window policy (mirrors canonicalizeModel in
// src/modelVersions.js): Sonnet 5 is pinned to 1M (fixedWindow); Sonnet 4.x
// obeys the window on its own binding (`binding.window`, no global); Opus/Fable
// 1M, Haiku 200k.

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

// The identity backend id (mirrors CLAUDE_BACKEND_ID in src/modelVersions.js).
export const CLAUDE_BACKEND = 'claude';

// Pre-fetch fallback tier→{backend,model} bindings (mirrors DEFAULT_TIER_BACKEND
// in src/modelVersions.js). Overwritten by the shipped catalog at boot.
const DEFAULT_TIER_BACKEND = {
  fast:     { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.haiku },
  balanced: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.sonnet },
  powerful: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.opus },
  frontier: { backend: CLAUDE_BACKEND, model: DEFAULT_VERSIONS.fable },
};
const DEFAULT_TIER_LABELS = { fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful', frontier: 'Frontier' };

// Pre-fetch fallback role→binding (mirrors DEFAULT_ROLE_BINDING in
// src/modelVersions.js). A role binds to a tier ({kind:'tier',tier}) or a
// concrete {backend,model}. Overwritten by the shipped catalog at boot.
const DEFAULT_ROLE_BINDING = {
  conductor: { kind: 'tier', tier: 'powerful' },
  reviewer:  { kind: 'tier', tier: 'powerful' },
};

let activeTierEnabled = { fast: true, balanced: true, powerful: true, frontier: true };
let activeDefaultSpawnTier = 'powerful';
let activeTierBackend = { ...DEFAULT_TIER_BACKEND };
let sonnetFixedWindowByVersion = { 'claude-sonnet-5': '1m' };
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
export function getBackends() { return backends; }
export function setBackends(list) { backends = Array.isArray(list) && list.length ? list : backends; return backends; }
export function getBackendLabel(id) { return backends.find(b => b.id === id)?.label || id; }
export function getCustomModels() { return customModels; }
export function setCustomModels(list) { customModels = Array.isArray(list) ? list : []; return customModels; }
export function getOllamaCloudModels() { return ollamaCloudModels; }
export function setOllamaCloudModels(list) { ollamaCloudModels = Array.isArray(list) ? list : []; return ollamaCloudModels; }

// Native context window (raw tokens) for a non-Claude model id, or null when
// unknown. Custom models win over the curated catalog. Matches the full id OR its
// bare base name: the inner CLI reports such models bare (`qwen3.5`, dropping the
// `:cloud` suffix) in system/init + message_start, and the UsageTracker adopts
// that bare id as the live model — so contextWindowFor() often sees the base
// name rather than the full id. The curated bases are collision-free.
export function customContextWindowFor(model) {
  if (typeof model !== 'string' || !model) return null;
  const match = (m) => m.model === model || m.model.split(':')[0] === model;
  const custom = customModels.find(match);
  if (custom && Number.isFinite(custom.contextWindow)) return custom.contextWindow;
  const preset = ollamaCloudModels.find(match);
  if (preset && Number.isFinite(preset.contextWindow)) return preset.contextWindow;
  return null;
}

// Infer the Claude family from a model id, by prefix. Mirrors familyOf() in
// src/modelVersions.js. Returns null for a non-Claude id (another backend's
// tagged model), which is what makes the window suffix a no-op for them.
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

export function isSonnetFixedWindowVersion(id) { return !!sonnetFixedWindowByVersion[id]; }
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

// Apply the Sonnet window suffix to a Claude version id from the binding's own
// `window` ('1m'|'200k', default '1m') — no global. No-op for non-Sonnet and
// non-Claude ids; fixed-window Sonnet (5) is always [1m] regardless of `window`.
function applyClaudeWindow(versionId, window) {
  if (familyOf(versionId) !== 'sonnet') return versionId;
  if (isSonnetFixedWindowVersion(versionId)) return `${versionId}[1m]`;
  return window === '200k' ? versionId : `${versionId}[1m]`;
}

export async function loadModelVersions() {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.claudeFamilies) && data.claudeFamilies.length) {
        const sonnetFamily = data.claudeFamilies.find(f => f.family === 'sonnet');
        sonnetFixedWindowByVersion = Object.fromEntries(
          (sonnetFamily?.versions || []).filter(v => v.fixedWindow).map(v => [v.id, v.fixedWindow]),
        );
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
      if (data.roleBackend) setActiveRoleBindings(data.roleBackend);
      if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
      setActiveDefaultSpawnTier(data.defaultSpawnTier);
      setCustomModels(data.customModels);
      setOllamaCloudModels(data.ollamaCloudModels);
    }
  } catch { /* keep defaults */ }
  return activeTierBackend;
}

// Resolve a tier to the spawn args {model, backend}. For 'claude' the model
// carries the Sonnet window suffix; for any other backend it's the bare model id.
export function resolveSpawnModel(tier) {
  const b = getActiveTierBackend(tier);
  if (!b || !b.model) return { model: '', backend: CLAUDE_BACKEND };
  if (backendIdOf(b) !== CLAUDE_BACKEND) return { model: b.model, backend: backendIdOf(b) };
  return { model: applyClaudeWindow(b.model, b.window), backend: CLAUDE_BACKEND, sonnetWindow: b.window === '200k' ? '200k' : '1m' };
}

// Resolve a role to the spawn args {model, backend}. A tier binding delegates to
// resolveSpawnModel (mirrors the server's resolveRoleBackend); a concrete binding
// resolves like a tier's own {backend,model} (Claude window suffix applied for
// claude, bare model id otherwise).
export function resolveSpawnRole(role) {
  const b = getActiveRoleBinding(role);
  if (b && b.kind === 'tier') return resolveSpawnModel(b.tier);
  if (!b || !b.model) return { model: '', backend: CLAUDE_BACKEND };
  if (backendIdOf(b) !== CLAUDE_BACKEND) return { model: b.model, backend: backendIdOf(b) };
  return { model: applyClaudeWindow(b.model, b.window), backend: CLAUDE_BACKEND, sonnetWindow: b.window === '200k' ? '200k' : '1m' };
}
