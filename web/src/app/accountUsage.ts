// Account-level usage from GET /api/usage (the server caches the OAuth
// endpoint). Its tightest bucket also seeds the rate-limit tracker, so the
// usage chip has a value before any session emits a rate_limit_event.
import { RL_BUCKET_KEYS } from '@/lib/core/usage.js';
import { createStore } from '@/state/createStore';
import { rateLimits, trackerSignal } from './trackers';

export const accountUsageStore = createStore<{ usage: any | null; stale: boolean }>({ usage: null, stale: false });

const POLL_MS = 180_000;
let generation = 0;

export async function refreshAccountUsage() {
  const g = generation;
  try {
    const r = await fetch('/api/usage', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (g !== generation || j.usage == null) return; // keep the last good reading
    accountUsageStore.set({ usage: j.usage, stale: !!j.stale });
    const key = RL_BUCKET_KEYS.find((k: string) => j.usage[k]);
    if (key) {
      const b = j.usage[key];
      rateLimits.apply({
        kind: 'system', subtype: 'rate_limit_event',
        data: { rate_limit_info: {
          rateLimitType: key,
          utilization: typeof b.utilization === 'number' ? b.utilization / 100 : undefined,
          resetsAt: b.resets_at ? new Date(b.resets_at).getTime() / 1000 : undefined,
        } },
      });
      trackerSignal.bump();
    }
  } catch { /* keep the last good reading */ }
}

/** A Claude login switched accounts: the previous account's figures are void. */
export function accountChanged() {
  generation++;
  accountUsageStore.set({ usage: null, stale: false });
  rateLimits.reset();
  trackerSignal.bump();
  return refreshAccountUsage();
}

export function startAccountUsagePolling() {
  void refreshAccountUsage();
  setInterval(() => void refreshAccountUsage(), POLL_MS);
}
