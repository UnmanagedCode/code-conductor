// Client-side cache + resolver for the configurable model catalog
// (Settings → Models). The two spawn pickers (Conduct, new-instance dialog)
// carry only a `tier` marker (fast/balanced/powerful/frontier); the tier
// resolves to a backend (a Claude family) via the tier→backend binding, then
// to a concrete base version id via the user's per-backend setting — both
// fetched once at boot and refreshed when the Settings page changes either.
//
// Context-window policy (mirrors canonicalizeModel in src/modelVersions.js):
//   Opus  → 1M bare (CLI native default)
//   Haiku → 200k bare (no 1M build)
//   Sonnet → per-version: Sonnet 5 has no 200k build, so it's pinned to 1M
//            (fixedWindow in the catalog); Sonnet 4.x has both builds and
//            remains user-selectable via Settings → Models, persisted
//            server-side so all spawn paths and resume inherit it.
// The server re-derives the same window on resume using the stored preference.

// Minimal pre-fetch fallback (one id per backend — already the floor). The
// server ships the authoritative catalog in /api/settings/models, which
// overwrites activeVersions via setActiveVersions() on every successful fetch;
// this only seeds resolveSpawnModel() in the brief window before the boot fetch
// resolves, so an early spawn never sends an empty model id.
export const DEFAULT_VERSIONS = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

// Minimal pre-fetch fallback for the tier layer — mirrors CAPABILITY_TIERS /
// DEFAULT_TIER_BACKEND in src/modelVersions.js. Overwritten by the
// authoritative catalog in loadModelVersions() on every successful fetch.
const DEFAULT_TIER_BACKEND = { fast: 'haiku', balanced: 'sonnet', powerful: 'opus', frontier: 'fable' };
const DEFAULT_TIER_LABELS = { fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful', frontier: 'Frontier' };

let activeVersions = { ...DEFAULT_VERSIONS };
let activeSonnetWindow = '1m';
let activeTierEnabled = { fast: true, balanced: true, powerful: true, frontier: true };
let activeDefaultSpawnTier = 'powerful';
let activeTierBackend = { ...DEFAULT_TIER_BACKEND };
// Minimal pre-fetch fallback mirroring the `fixedWindow` flag on
// claude-sonnet-5 in MODEL_FAMILIES (src/modelVersions.js). Overwritten by
// the authoritative catalog in loadModelVersions() on every successful
// fetch, so this only matters in the brief window before boot resolves.
let sonnetFixedWindowByVersion = { 'claude-sonnet-5': '1m' };
// Tier enum/order + labels, sourced from the shipped catalog (data.tiers).
// Seeded non-empty from DEFAULT_TIER_BACKEND keys.
let tierList = Object.keys(DEFAULT_TIER_BACKEND);
let tierLabels = { ...DEFAULT_TIER_LABELS };

export function getTierList() {
  return tierList;
}

export function getTierLabel(tier) {
  return tierLabels[tier] || tier;
}

// Infer the backend (Claude family) from a bare or suffixed model id, by
// prefix. Mirrors familyOf() in src/modelVersions.js — duplicated
// client-side since the client only ever receives the catalog data, not the
// server module itself.
export function familyOf(modelId) {
  if (typeof modelId !== 'string') return null;
  if (modelId.startsWith('claude-fable')) return 'fable';
  if (modelId.startsWith('claude-opus')) return 'opus';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  return null;
}

export function setActiveVersions(map) {
  activeVersions = { ...DEFAULT_VERSIONS, ...(map || {}) };
  return activeVersions;
}

export function getActiveVersion(family) {
  return activeVersions[family] || DEFAULT_VERSIONS[family];
}

export function isSonnetFixedWindowVersion(id) {
  return !!sonnetFixedWindowByVersion[id];
}

export function getActiveSonnetWindow() {
  return activeSonnetWindow;
}

export function setActiveSonnetWindow(w) {
  activeSonnetWindow = w === '200k' ? '200k' : '1m';
  return activeSonnetWindow;
}

export function getActiveTierEnabled(tier) {
  return activeTierEnabled[tier] !== false;
}

export function setActiveTierEnabled(map) {
  activeTierEnabled = { ...activeTierEnabled, ...(map || {}) };
}

export function getActiveDefaultSpawnTier() {
  return activeDefaultSpawnTier;
}

export function setActiveDefaultSpawnTier(v) {
  activeDefaultSpawnTier = v || 'powerful';
  return activeDefaultSpawnTier;
}

export function getActiveTierBackend(tier) {
  return activeTierBackend[tier] || DEFAULT_TIER_BACKEND[tier];
}

export function setActiveTierBackend(map) {
  activeTierBackend = { ...activeTierBackend, ...(map || {}) };
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
      setActiveVersions(data.activeVersions);
      setActiveSonnetWindow(data.sonnetContextWindow);
      if (data.tierBackend) setActiveTierBackend(data.tierBackend);
      if (data.enabledTiers) setActiveTierEnabled(data.enabledTiers);
      setActiveDefaultSpawnTier(data.defaultSpawnTier);
    }
  } catch { /* keep defaults */ }
  return activeVersions;
}

// tier: 'fast' | 'balanced' | 'powerful' | 'frontier'. Resolves to the bound
// backend, then to the model string to send on spawn. Sonnet 5 is always 1M
// (no 200k build); Sonnet 4.x obeys the user's context-window preference;
// all others use the bare id (1M for Fable/Opus via CLI default, 200k for
// Haiku).
export function resolveSpawnModel(tier) {
  const backend = getActiveTierBackend(tier);
  const base = getActiveVersion(backend);
  if (!base) return '';
  if (backend === 'sonnet') {
    if (isSonnetFixedWindowVersion(base)) return `${base}[1m]`;
    return activeSonnetWindow === '200k' ? base : `${base}[1m]`;
  }
  return base;
}
