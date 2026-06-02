// Client-side cache + resolver for the configurable per-family model version
// (Settings → Models). The three spawn pickers (quick-spawn ↯, Conduct,
// new-instance dialog) carry only a `family` marker; the concrete base
// version id comes from the user's setting, fetched once at boot and
// refreshed when the Settings page switches a version.
//
// Each family runs at one fixed context window (no per-spawn choice; mirrors
// canonicalizeModel in src/modelVersions.js): Opus → 1M (bare native),
// Sonnet → 1M (CLI-native `[1m]` suffix, since bare Sonnet is 200k), Haiku →
// 200k (bare). The server re-derives the same window on resume.

export const DEFAULT_VERSIONS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

let activeVersions = { ...DEFAULT_VERSIONS };

export function getActiveVersions() {
  return activeVersions;
}

export function setActiveVersions(map) {
  activeVersions = { ...DEFAULT_VERSIONS, ...(map || {}) };
  return activeVersions;
}

export async function loadModelVersions() {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      setActiveVersions(data.active);
    }
  } catch { /* keep defaults */ }
  return activeVersions;
}

// family: 'sonnet' | 'opus' | 'haiku'. Returns the model string to send on
// spawn. Sonnet → 1M via the CLI-native `[1m]` suffix; Opus/Haiku are bare.
export function resolveSpawnModel(family) {
  const base = activeVersions[family] || DEFAULT_VERSIONS[family];
  if (!base) return '';
  return family === 'sonnet' ? `${base}[1m]` : base;
}
