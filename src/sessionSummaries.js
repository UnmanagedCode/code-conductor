// Sidecar JSON store mapping sessionId → per-tier summary records.
// Single global file at `<store>/session-summaries.json`.
//
// New shape: { summaries: { "<sid>": { short?: {summary,generatedAt,messageCount},
//                                      medium?: {...}, long?: {...} } } }
// The `length` key IS the tier; it is not stored inside the record.
//
// Backward compat: entries written by the old single-summary shape
// { summary, length, generatedAt, messageCount } are migrated on read to
// { [length]: { summary, generatedAt, messageCount } } so the shared store
// doesn't crash when it holds a mix of old and new entries.
//
// Atomic writes (write tmp + rename). Missing file = empty map.
// Concurrent writers serialised behind a per-process promise chain.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

const VALID_LENGTHS = new Set(['short', 'medium', 'long']);

function summariesFile() {
  return path.join(orchStoreRoot(), 'session-summaries.json');
}

function normalizeTierRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.summary !== 'string' || !rec.summary.trim()) return null;
  return {
    summary: rec.summary.trim(),
    generatedAt: typeof rec.generatedAt === 'number' ? rec.generatedAt : 0,
    messageCount: typeof rec.messageCount === 'number' ? rec.messageCount : 0,
  };
}

// Normalise a raw per-session entry to { short?, medium?, long? }.
// Handles both the new multi-tier shape and the old single-record shape.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Old shape: has a top-level `summary` string and `length` field.
  if (typeof raw.summary === 'string' && typeof raw.length === 'string') {
    const len = raw.length;
    if (!VALID_LENGTHS.has(len)) return null;
    const rec = normalizeTierRecord(raw);
    return rec ? { [len]: rec } : null;
  }

  // New shape: keyed by tier.
  const entry = {};
  for (const len of VALID_LENGTHS) {
    if (raw[len]) {
      const rec = normalizeTierRecord(raw[len]);
      if (rec) entry[len] = rec;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(summariesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || !obj.summaries || typeof obj.summaries !== 'object') {
      return new Map();
    }
    const out = new Map();
    for (const [sid, rawEntry] of Object.entries(obj.summaries)) {
      if (typeof sid !== 'string') continue;
      const entry = normalizeEntry(rawEntry);
      if (entry) out.set(sid, entry);
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    console.warn(`sessionSummaries: failed to read ${summariesFile()}: ${e.message}`);
    return new Map();
  }
}

// Returns { short?, medium?, long? } — empty object when no summaries exist.
export async function getSummaries(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return {};
  const map = await loadAll();
  return map.get(sessionId) ?? {};
}

// Serialise concurrent writers behind a per-process promise chain.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map) {
  const file = summariesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
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
export function setSummary(sessionId, length, record) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (!VALID_LENGTHS.has(length)) return null;
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
export function deleteSummaries(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
  });
}
