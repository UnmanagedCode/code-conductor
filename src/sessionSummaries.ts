// The session-summary vocabulary: the tiers a summary is generated at, and the
// normalizers the unified session store (src/sessionStore.ts) parses a
// session's `summaries` map with. Each tier's record is
// `{summary, generatedAt, messageCount}`; the tier is the map key.

// The generation options the dialog offers. `title` is not a length — it names
// the session's current goal — but it stores and renders exactly like a tier.
export const SUMMARY_LENGTHS = ['short', 'medium', 'long', 'title'] as const;
export type SummaryLength = typeof SUMMARY_LENGTHS[number];

export interface TierRecord {
  summary: string;
  generatedAt: number;
  messageCount: number;
}

export type SummaryTiers = Partial<Record<SummaryLength, TierRecord>>;

export function normalizeTierRecord(rec: unknown): TierRecord | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { summary?: unknown; generatedAt?: unknown; messageCount?: unknown };
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null;
  return {
    summary: r.summary.trim(),
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : 0,
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
  };
}

// Normalise a raw per-session tier map; null when it holds no valid tier.
export function normalizeSummaryTiers(raw: unknown): SummaryTiers | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const entry: SummaryTiers = {};
  for (const len of SUMMARY_LENGTHS) {
    if (r[len] != null) {
      const rec = normalizeTierRecord(r[len]);
      if (rec) entry[len] = rec;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}
