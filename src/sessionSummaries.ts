// Sidecar JSON store mapping sessionId → per-tier summary records.
// Single global file at `<store>/session-summaries.json`.
//
// Shape: { summaries: { "<sid>": { short?: {summary,generatedAt,messageCount},
//                                  medium?: {...}, long?: {...} } } }
// The `length` key IS the tier; it is not stored inside the record.
//
// Atomic writes (write tmp + rename). Missing file = empty map.
// Concurrent writers serialised behind a per-process promise chain.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';

const VALID_LENGTHS = new Set(['short', 'medium', 'long'] as const);
type TierLength = 'short' | 'medium' | 'long';

interface TierRecord {
  summary: string;
  generatedAt: number;
  messageCount: number;
}

type SessionEntry = Partial<Record<TierLength, TierRecord>>;

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
  for (const len of VALID_LENGTHS) {
    if (r[len] != null) {
      const rec = normalizeTierRecord(r[len]);
      if (rec) entry[len] = rec;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

export async function loadAll(): Promise<Map<string, SessionEntry>> {
  try {
    const raw = await fs.readFile(summariesFile(), 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return new Map();
    const summaries = (obj as { summaries?: unknown }).summaries;
    if (typeof summaries !== 'object' || summaries === null) return new Map();
    const out = new Map<string, SessionEntry>();
    for (const [sid, rawEntry] of Object.entries(summaries as Record<string, unknown>)) {
      if (typeof sid !== 'string') continue;
      const entry = normalizeEntry(rawEntry);
      if (entry) out.set(sid, entry);
    }
    return out;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    console.warn(`sessionSummaries: failed to read ${summariesFile()}: ${errMsg(e)}`);
    return new Map();
  }
}

// Returns { short?, medium?, long? } — empty object when no summaries exist.
export async function getSummaries(sessionId: string): Promise<SessionEntry> {
  if (typeof sessionId !== 'string' || !sessionId) return {};
  const map = await loadAll();
  return map.get(sessionId) ?? {};
}

// Serialise concurrent writers behind a per-process promise chain.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map: Map<string, SessionEntry>): Promise<void> {
  const file = summariesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { summaries: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Merges the new tier into the session's existing entry (never clobbers other tiers).
// Returns the stored tier record, or null on bad input.
export function setSummary(sessionId: string, length: string, record: unknown): Promise<TierRecord | null> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (!VALID_LENGTHS.has(length as TierLength)) return null;
    const tier = normalizeTierRecord(record);
    if (!tier) return null;

    const map = await loadAll();
    const existing = map.get(sessionId) ?? {};
    map.set(sessionId, { ...existing, [length]: tier });
    await writeMap(map);
    return tier;
  });
}

// Removes ALL tiers for a session.
export function deleteSummaries(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
  });
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
