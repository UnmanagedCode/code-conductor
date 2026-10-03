// The host platform's feature flags, read once from GET /api/health. A feature
// the platform lacks is hidden rather than offered and then refused.
// `capabilities()` is null until `loadCapabilities()` resolves.

const ALL_OFF = { remoteSystems: false, fuseUnion: false, voice: false };

let loaded = null;
let pending = null;

export function loadCapabilities() {
  pending ??= (async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loaded = (await r.json()).capabilities ?? ALL_OFF;
    } catch (e) {
      console.warn('capabilities: could not read /api/health — platform features stay hidden:', e);
      loaded = ALL_OFF;
    }
    return loaded;
  })();
  return pending;
}

export function capabilities() {
  return loaded;
}

// Test hook: forget the memoized load so a test can supply its own fetch.
export function resetCapabilities() {
  loaded = null;
  pending = null;
}
