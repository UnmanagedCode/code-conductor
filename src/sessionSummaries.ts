// Sidecar JSON store mapping sessionId → per-tier summary records.
// Single global file at `<store>/session-summaries.json`.
//
// Shape: { summaries: { "<sid>": { short?: {summary,generatedAt,messageCount},
//                                  medium?: {...}, long?: {...} } } }
// The `length` key IS the tier; it is not stored inside the record.
//
// Read/write machinery (cross-process lock + write-chain + atomic write +
// unlink-when-empty) comes from `jsonStore.ts`.

import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { createJsonStore } from './jsonStore.ts';

// The generation options the dialog offers. `title` is not a length — it names
// the session's current goal — but it stores and renders exactly like a tier.
export const SUMMARY_LENGTHS = ['short', 'medium', 'long', 'title'] as const;
export type SummaryLength = typeof SUMMARY_LENGTHS[number];
const VALID_LENGTHS = new Set<string>(SUMMARY_LENGTHS);

interface TierRecord {
  summary: string;
  generatedAt: number;
  messageCount: number;
}

type SessionEntry = Partial<Record<SummaryLength, TierRecord>>;

function summariesFile(): string {
  return path.join(orchStoreRoot(), 'session-summaries.json');
}

function normalizeTierRecord(rec: unknown): TierRecord | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { summary?: unknown; generatedAt?: unknown; messageCount?: unknown };
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null;
  return {
    summary: r.summary.trim(),
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : 0,
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
  };
}

// Normalise a raw per-session entry to { short?, medium?, long? }.
function normalizeEntry(raw: unknown): SessionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const entry: SessionEntry = {};
  for (const len of SUMMARY_LENGTHS) {
    if (r[len] != null) {
      const rec = normalizeTierRecord(r[len]);
      if (rec) entry[len] = rec;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

function parseMap(obj: unknown): Map<string, SessionEntry> {
  const out = new Map<string, SessionEntry>();
  if (typeof obj !== 'object' || obj === null) return out;
  const summaries = (obj as { summaries?: unknown }).summaries;
  if (typeof summaries !== 'object' || summaries === null) return out;
  for (const [sid, rawEntry] of Object.entries(summaries as Record<string, unknown>)) {
    if (typeof sid !== 'string') continue;
    const entry = normalizeEntry(rawEntry);
    if (entry) out.set(sid, entry);
  }
  return out;
}

const store = createJsonStore<Map<string, SessionEntry>>({
  file: summariesFile,
  noun: 'sessionSummaries',
  empty: () => new Map(),
  parse: parseMap,
  toDoc: (map) => ({ summaries: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) }),
  isEmpty: (map) => map.size === 0,
});

export async function loadAll(): Promise<Map<string, SessionEntry>> {
  return store.load();
}

// Returns { short?, medium?, long? } — empty object when no summaries exist.
export async function getSummaries(sessionId: string): Promise<SessionEntry> {
  if (typeof sessionId !== 'string' || !sessionId) return {};
  const map = await loadAll();
  return map.get(sessionId) ?? {};
}

// Merges the new tier into the session's existing entry (never clobbers other tiers).
// Returns the stored tier record, or null on bad input.
export function setSummary(sessionId: string, length: string, record: unknown): Promise<TierRecord | null> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(null);
  if (!VALID_LENGTHS.has(length)) return Promise.resolve(null);
  const tier = normalizeTierRecord(record);
  if (!tier) return Promise.resolve(null);
  return store.mutate(async (map, write) => {
    const existing = map.get(sessionId) ?? {};
    map.set(sessionId, { ...existing, [length]: tier });
    await write(map);
    return tier;
  });
}

// Removes ALL tiers for a session.
export function deleteSummaries(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (map, write) => {
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await write(map);
    return true;
  });
}
