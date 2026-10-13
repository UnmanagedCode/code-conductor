// The host platform's feature flags, read once from GET /api/health. A feature
// the platform lacks is hidden rather than offered and then refused.
// `capabilities()` is null until a load succeeds. A failed load is not
// remembered: `loadCapabilities()` resolves null and the next call retries.

// The platform's flags by name (Platform.capabilities, src/platform/).
export type Capabilities = Record<string, boolean>;

import { apiFetch } from './http.ts';

let loaded: Capabilities | null = null;
let pending: Promise<Capabilities | null> | null = null;

export function loadCapabilities(): Promise<Capabilities | null> {
  pending ??= (async () => {
    try {
      loaded = (await apiFetch<{ capabilities?: Capabilities } | null>('/api/health', { cache: 'no-store' }))?.capabilities ?? null;
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

export function capabilities(): Capabilities | null {
  return loaded;
}
