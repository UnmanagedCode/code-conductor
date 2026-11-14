// Rate-limit reset-time normalisation. A leaf, so `src/usageOverageMonitor.ts`
// can use it without importing back into `src/instances.ts` (an import cycle).

// Normalise the rate-limit window reset time to epoch SECONDS, or null.
// The live `rate_limit_event` field is the camelCase epoch-seconds `resetsAt`
// (confirmed against a real CLI capture). The snake_case ISO `resets_at` (as in
// the account-usage payload / web/src/app/accountUsage.ts's
// `new Date(b.resets_at)`) and a
// raw epoch number are accepted only as defensive fallbacks. The overage
// auto-resume timer (overageResume.ts arm()) and the global clear timer both
// expect epoch seconds, so this is the single place the shape is reconciled.
export function parseResetEpochSecs(info: unknown): number | null {
  const rec = (info ?? null) as { resetsAt?: unknown; resets_at?: unknown } | null;
  const v = rec?.resetsAt ?? rec?.resets_at ?? null;
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null; // already epoch secs
  const ms = Date.parse(v as string);                              // ISO-8601 string
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
