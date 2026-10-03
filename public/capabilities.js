// The host platform's feature flags, read once from GET /api/health. A feature
// the platform lacks is hidden rather than offered and then refused.
// `capabilities()` is null until a load succeeds. A failed load is not
// remembered: `loadCapabilities()` resolves null and the next call retries.

let loaded = null;
let pending = null;

export function loadCapabilities() {
  pending ??= (async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loaded = (await r.json()).capabilities;
      if (!loaded) throw new Error('no capabilities in the response');
    } catch (e) {
      console.warn('capabilities: could not read /api/health, will retry on next use:', e);
      pending = null;
      return null;
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
