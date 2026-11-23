// The host platform's feature flags, read once from GET /api/health. A feature
// the platform lacks is hidden rather than offered and then refused.
// `capabilities()` is null until a load succeeds. A failed load is not
// remembered: `loadCapabilities()` resolves null and the next call retries.

import { apiFetch } from './http.ts';
import { setViewOnly } from './viewOnly.ts';
import { focusFromHealth, setFocus } from './focus.ts';

// The platform's flags by name (Platform.capabilities, src/platform/).
export type Capabilities = Record<string, boolean>;

let loaded: Capabilities | null = null;
let pending: Promise<Capabilities | null> | null = null;

export function loadCapabilities(): Promise<Capabilities | null> {
  pending ??= (async () => {
    let body: { capabilities?: Capabilities } | null;
    try {
      body = await apiFetch<{ capabilities?: Capabilities } | null>('/api/health');
      loaded = body?.capabilities ?? null;
      if (!loaded) throw new Error('no capabilities in the response');
    } catch (e) {
      console.warn('capabilities: could not read /api/health, will retry on next use:', e);
      pending = null;
      return null;
    }
    setViewOnly(loaded.viewOnly === true);
    setFocus(focusFromHealth(body));
    return loaded;
  })();
  return pending;
}

export function capabilities(): Capabilities | null {
  return loaded;
}

/** Resolves once the load that is already under way has settled (null when none was started, which starts none). */
export function capabilitiesSettled(): Promise<Capabilities | null> {
  return pending ?? Promise.resolve(null);
}
