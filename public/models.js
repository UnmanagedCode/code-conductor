// Client-side cache + resolver for the configurable per-family model version
// (Settings → Models). The three spawn pickers (quick-spawn ↯, Conduct,
// new-instance dialog) carry only a `family` marker; the concrete base
// version id comes from the user's setting, fetched once at boot and
// refreshed when the Settings page switches a version.
//
// Context-window policy (mirrors canonicalizeModel in src/modelVersions.js):
//   Opus  → 1M bare (CLI native default)
//   Haiku → 200k bare (no 1M build)
//   Sonnet → user-selectable (200k or 1M) via Settings → Models; preference
//            persisted server-side so all spawn paths and resume inherit it.
// The server re-derives the same window on resume using the stored preference.

export const DEFAULT_VERSIONS = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

let activeVersions = { ...DEFAULT_VERSIONS };
let activeSonnetWindow = '1m';
let activeFable5Enabled = true;
let activeDefaultSpawnFamily = 'opus';

export function getActiveVersions() {
  return activeVersions;
}

export function setActiveVersions(map) {
  activeVersions = { ...DEFAULT_VERSIONS, ...(map || {}) };
  return activeVersions;
}

export function getActiveSonnetWindow() {
  return activeSonnetWindow;
}

export function setActiveSonnetWindow(w) {
  activeSonnetWindow = w === '200k' ? '200k' : '1m';
  return activeSonnetWindow;
}

export function getActiveFable5Enabled() {
  return activeFable5Enabled;
}

export function setActiveFable5Enabled(v) {
  activeFable5Enabled = v !== false;
  return activeFable5Enabled;
}

export function getActiveDefaultSpawnFamily() {
  return activeDefaultSpawnFamily;
}

export function setActiveDefaultSpawnFamily(v) {
  activeDefaultSpawnFamily = v || 'opus';
  return activeDefaultSpawnFamily;
}

export async function loadModelVersions() {
  try {
    const r = await fetch('/api/settings/models', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      setActiveVersions(data.active);
      setActiveSonnetWindow(data.sonnetContextWindow);
      setActiveFable5Enabled(data.fable5Enabled);
      setActiveDefaultSpawnFamily(data.defaultSpawnFamily);
    }
  } catch { /* keep defaults */ }
  return activeVersions;
}

// family: 'fable' | 'sonnet' | 'opus' | 'haiku'. Returns the model string to
// send on spawn. Sonnet obeys the user's context-window preference; all
// others use the bare id (1M for Fable/Opus via CLI default, 200k for Haiku).
export function resolveSpawnModel(family) {
  const base = activeVersions[family] || DEFAULT_VERSIONS[family];
  if (!base) return '';
  if (family === 'sonnet') return activeSonnetWindow === '200k' ? base : `${base}[1m]`;
  return base;
}
