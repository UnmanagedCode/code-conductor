// Client-side cache + resolver for the configurable per-family model version
// (Settings → Models). The three spawn pickers (quick-spawn ↯, Conduct,
// new-instance dialog) carry only a `family` + context-window `ctx` marker;
// the concrete base version id comes from the user's setting, fetched once at
// boot and refreshed when the Settings page switches a version.
//
// The 200k/1M context-window variant is recombined here at click time and
// stays family-keyed (mirrors src/modelVersions.js): Opus bare = 1M, `[200k]`
// forces 200k; Sonnet bare = 200k, `[1m]` opts into 1M; Haiku is 200k-only.
// The server-side `[200k]`/`[1m]` suffix handling (src/instances.js) is
// unchanged — it still receives the same suffix shape.

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

// family: 'sonnet' | 'opus' | 'haiku'; ctx: '200k' | '1m' | undefined.
// Returns the model string to send on spawn (base version id + any suffix).
export function resolveSpawnModel(family, ctx) {
  const base = activeVersions[family] || DEFAULT_VERSIONS[family];
  if (!base) return '';
  if (family === 'opus') return ctx === '1m' ? base : `${base}[200k]`;
  if (family === 'sonnet') return ctx === '1m' ? `${base}[1m]` : base;
  return base; // haiku — 200k only, no ctx suffix
}
