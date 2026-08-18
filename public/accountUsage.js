// Account-level usage polled from /api/usage (OAuth endpoint, 180 s server cache).
// Extracted from app.js: app.js keeps only the bootstrap driver (one refresh at
// boot plus the 180 s interval) and forwards the header's getAccountUsage /
// getAccountUsageStale getters to this handle.
//
// Deliberately a bare fetch, not apiFetch: this is a status-only poll whose
// whole contract is that a failure is silent and non-destructive. apiFetch
// throws on !ok, which would turn the "keep last-good" path into a rejection.
//
// Injected interface:
//   - globalRLTracker: the account-wide RateLimitTracker the tightest bucket
//                      is merged into as a synthetic rate_limit_event.
//   - getActiveId():   the header is only repainted when a session is active.
//   - headerUpdate():  lazy — headerHandle is assigned after this install.

import { RL_BUCKET_KEYS } from './usage.js';

export function installAccountUsage({ globalRLTracker, getActiveId, headerUpdate }) {
  // null until the first successful fetch. A failed/null refresh keeps the
  // last-good value instead of blanking it — the server already retains
  // last-good data on failure (allowStale), so a transient miss here shouldn't
  // clobber a good render.
  let accountUsage = null;
  let accountUsageStale = false;

  async function refreshAccountUsage() {
    try {
      const r = await fetch('/api/usage', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j.usage == null) return; // keep last-good accountUsage, don't blank it
      accountUsage = j.usage;
      accountUsageStale = !!j.stale;
      // Merge the tightest bucket from the fetch into globalRLTracker so the
      // combined chip shows real data even before a rate_limit_event arrives.
      // fetch = richer base; messages are sparse patches on top. Both use the
      // same apply() null-guard so neither clobbers the other's unique fields
      // (isUsingOverage is message-only and survives re-fetches because it is
      // intentionally absent from this synthetic event).
      const key = RL_BUCKET_KEYS.find(k => accountUsage[k]);
      if (key) {
        const b = accountUsage[key];
        globalRLTracker.apply({
          kind: 'system', subtype: 'rate_limit_event',
          data: { rate_limit_info: {
            rateLimitType: key,
            utilization: typeof b.utilization === 'number' ? b.utilization / 100 : undefined,
            resetsAt: b.resets_at ? new Date(b.resets_at).getTime() / 1000 : undefined,
          }},
        });
      }
      if (getActiveId()) headerUpdate();
    } catch { /* ignore — keep last-good accountUsage */ }
  }

  return {
    refresh: refreshAccountUsage,
    get: () => accountUsage,
    isStale: () => accountUsageStale,
  };
}
