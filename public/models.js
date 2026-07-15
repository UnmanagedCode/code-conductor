// Client-side cache + resolver for the model catalog (Settings → Models). The
// spawn pickers carry only a `tier` (fast/balanced/powerful/frontier); a tier
// resolves via its {kind, model} binding to the spawn args {model, backendKind}
// — kind 'claude' (model = a MODEL_FAMILIES version id) or 'ollama' (model = an
// Ollama tag). Catalog fetched once at boot, refreshed on Settings changes.
//
// Sonnet context-window policy (mirrors canonicalizeModel in
// src/modelVersions.js): Sonnet 5 is pinned to 1M (fixedWindow); Sonnet 4.x
// obeys the global sonnetContextWindow preference; Opus/Fable 1M, Haiku 200k.

// Pre-fetch fallback version ids (one per family) — only used to seed the
// default tier bindings before the boot fetch resolves.
const DEFAULT_VERSIONS = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

// Pre-fetch fallback tier→{kind,model} bindings (mirrors DEFAULT_TIER_BACKEND in
// src/modelVersions.js). Overwritten by the shipped catalog at boot.
const DEFAULT_TIER_BACKEND = {
  fast:     { kind: 'claude', model: DEFAULT_VERSIONS.haiku },
  balanced: { kind: 'claude', model: DEFAULT_VERSIONS.sonnet },
  powerful: { kind: 'claude', model: DEFAULT_VERSIONS.opus },
  frontier: { kind: 'claude', model: DEFAULT_VERSIONS.fable },
};
const DEFAULT_TIER_LABELS = { fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful', frontier: 'Frontier' };

let activeSonnetWindow = '1m';
let activeTierEnabled = { fast: true, balanced: true, powerful: true, frontier: true };
let activeDefaultSpawnTier = 'powerful';
let activeTierBackend = { ...DEFAULT_TIER_BACKEND };
let sonnetFixedWindowByVersion = { 'claude-sonnet-5': '1m' };
let tierList = Object.keys(DEFAULT_TIER_BACKEND);
let tierLabels = { ...DEFAULT_TIER_LABELS };
let providers = [{ kind: 'claude', label: 'Claude' }, { kind: 'ollama', label: 'Ollama' }];
let customBackends = []; // [{label, model}]

export function getTierList() { return tierList; }
export function getTierLabel(tier) { return tierLabels[tier] || tier; }
export function getProviders() { return providers; }
export function getCustomBackends() { return customBackends; }
export function setCustomBackends(list) { customBackends = Array.isArray(list) ? list : []; return customBackends; }

// Infer the Claude family from a model id, by prefix. Mirrors familyOf() in
// src/modelVersions.js. Returns null for a non-Claude id (an Ollama tag), which
// is what makes the window suffix a no-op for tags.
export function familyOf(modelId) {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

// Kind of a {kind, model} tier binding.
export function backendKindOf(binding) {
  return binding && binding.kind === 'ollama' ? 'ollama' : 'claude';
}

export function isSonnetFixedWindowVersion(id) { return !!sonnetFixedWindowByVersion[id]; }
export function getActiveSonnetWindow() { return activeSonnetWindow; }
export function setActiveSonnetWindow(w) { activeSonnetWindow = w === '200k' ? '200k' : '1m'; return activeSonnetWindow; }

export function getActiveTierEnabled(tier) { return activeTierEnabled[tier] !== false; }
export function setActiveTierEnabled(map) { activeTierEnabled = { ...activeTierEnabled, ...(map || {}) }; }
export function getActiveDefaultSpawnTier() { return activeDefaultSpawnTier; }
export function setActiveDefaultSpawnTier(v) { activeDefaultSpawnTier = v || 'powerful'; return activeDefaultSpawnTier; }

// Returns the tier's {kind, model} binding (fallback default if unset).
export function getActiveTierBackend(tier) { return activeTierBackend[tier] || DEFAULT_TIER_BACKEND[tier]; }
export function setActiveTierBackend(map) { activeTierBackend = { ...activeTierBackend, ...(map || {}) }; }

// Apply the Sonnet window suffix to a Claude version id (no-op for non-Sonnet
// and non-Claude ids).
function applyClaudeWindow(versionId) {
  if (familyOf(versionId) !== 'sonnet') return versionId;
  if (isSonnetFixedWindowVersion(versionId)) return `${versionId}[1m]`;
  return activeSonnetWindow === '200k' ? versionId : `${versionId}[1m]`;
}

export async function loadModelVersions() {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.backends) && data.backends.length) {
        const sonnetFamily = data.backends.find(f => f.family === 'sonnet');
        sonnetFixedWindowByVersion = Object.fromEntries(
          (sonnetFamily?.versions || []).filter(v => v.fixedWindow).map(v => [v.id, v.fixedWindow]),
        );
      }
      if (Array.isArray(data.tiers) && data.tiers.length) {
        tierList = data.tiers.map(t => t.tier);
        tierLabels = Object.fromEntries(data.tiers.map(t => [t.tier, t.label]));
      }
      if (Array.isArray(data.providers) && data.providers.length) providers = data.providers;
      setActiveSonnetWindow(data.sonnetContextWindow);
      if (data.tierBackend) setActiveTierBackend(data.tierBackend);
      if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
      setActiveDefaultSpawnTier(data.defaultSpawnTier);
      setCustomBackends(data.customBackends);
    }
  } catch { /* keep defaults */ }
  return activeTierBackend;
}

// Resolve a tier to the spawn args {model, backendKind}. For 'claude' the model
// carries the Sonnet window suffix; for 'ollama' it's the bare tag.
export function resolveSpawnModel(tier) {
  const b = getActiveTierBackend(tier);
  if (!b || !b.model) return { model: '', backendKind: 'claude' };
  if (b.kind === 'ollama') return { model: b.model, backendKind: 'ollama' };
  return { model: applyClaudeWindow(b.model), backendKind: 'claude' };
}
