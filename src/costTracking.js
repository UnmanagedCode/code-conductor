// Per-turn cost persistence. Subscribes to instance events and appends one
// JSONL row per turn_end to <orchStoreRoot()>/costs.jsonl. Append-only so
// writes are a single fs.appendFile — no parse/rewrite of the whole file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

export function costsPath() {
  return path.join(orchStoreRoot(), 'costs.jsonl');
}

async function appendCostRow(inst, ev) {
  const usage = ev.usage ?? {};
  const row = {
    ts: Date.now(),
    project: inst.project ?? null,
    model: inst.model ?? null,
    sessionId: inst.sessionId ?? null,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cost_usd: ev.costDelta ?? ev.cost ?? 0,
  };
  try {
    const p = costsPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    console.warn('cost-tracking: failed to append row:', e.message ?? e);
  }
}

export function initCostTracking(instances) {
  if (!instances) return;
  instances.on('event', ({ id, ev }) => {
    if (ev.kind !== 'turn_end') return;
    if (ev.costDelta == null && ev.cost == null) return;
    const inst = instances.get(id);
    if (!inst) return;
    appendCostRow(inst, ev);
  });
}

// Session-relative cache-flush detector. Normal follow-up turns write
// ~1k-25k cache-creation tokens (incremental cache extension); a full
// cache-prefix rewrite after the ~5-min TTL lapses writes 100k-1M. Both
// constants were tuned against production costs.jsonl.
const FLUSH_ABS_FLOOR = 50000;
const FLUSH_K = 4;

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Rows with no sessionId can't be attributed to a conversation lineage
// (first-turn/non-first semantics don't apply), so they're excluded.
function computeCacheFlushes(rows) {
  const bySession = new Map();
  for (const r of rows) {
    if (r.sessionId == null) continue;
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }

  let count = 0;
  let non_first_turns = 0;
  let flush_cache_creation_tokens = 0;
  const sessionsAffected = new Set();

  for (const [sessionId, sessionRows] of bySession) {
    if (sessionRows.length < 2) continue; // only a cold start, nothing to evaluate
    sessionRows.sort((a, b) => a.ts - b.ts);
    const nonFirst = sessionRows.slice(1);
    non_first_turns += nonFirst.length;

    const creationTokens = nonFirst.map(r => r.cache_creation_tokens ?? 0);
    const threshold = Math.max(FLUSH_ABS_FLOOR, FLUSH_K * median(creationTokens));

    for (const r of nonFirst) {
      const tokens = r.cache_creation_tokens ?? 0;
      if (tokens >= threshold) {
        count += 1;
        flush_cache_creation_tokens += tokens;
        sessionsAffected.add(sessionId);
      }
    }
  }

  return {
    count,
    sessions_affected: sessionsAffected.size,
    non_first_turns,
    rate: non_first_turns > 0 ? count / non_first_turns : 0,
    flush_cache_creation_tokens,
  };
}

export async function getCostSummary() {
  let raw;
  try {
    raw = await fs.readFile(costsPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        total_usd: 0, row_count: 0, by_project: [], by_model: [], daily_trend: [],
        cache_flushes: { count: 0, sessions_affected: 0, non_first_turns: 0, rate: 0, flush_cache_creation_tokens: 0 },
      };
    }
    throw e;
  }

  const rows = raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  const total_usd = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  // By project (with nested per-model breakdown)
  const projectMap = new Map();
  for (const r of rows) {
    const key = r.project ?? '(unknown)';
    if (!projectMap.has(key)) {
      projectMap.set(key, { project: key, cost_usd: 0, turns: 0, _modelMap: new Map() });
    }
    const entry = projectMap.get(key);
    entry.cost_usd += r.cost_usd ?? 0;
    entry.turns += 1;

    const mKey = r.model ?? '(unknown)';
    const mEntry = entry._modelMap.get(mKey) ?? {
      model: mKey, cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0,
    };
    mEntry.cost_usd += r.cost_usd ?? 0;
    mEntry.input_tokens += r.input_tokens ?? 0;
    mEntry.output_tokens += r.output_tokens ?? 0;
    mEntry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    mEntry.cache_read_tokens += r.cache_read_tokens ?? 0;
    mEntry.turns += 1;
    entry._modelMap.set(mKey, mEntry);
  }
  const by_project = [...projectMap.values()].map(e => {
    const by_model = [...e._modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);
    return { project: e.project, cost_usd: e.cost_usd, turns: e.turns, by_model };
  }).sort((a, b) => b.cost_usd - a.cost_usd);

  // By model
  const modelMap = new Map();
  for (const r of rows) {
    const key = r.model ?? '(unknown)';
    const entry = modelMap.get(key) ?? {
      model: key, cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0,
    };
    entry.cost_usd += r.cost_usd ?? 0;
    entry.input_tokens += r.input_tokens ?? 0;
    entry.output_tokens += r.output_tokens ?? 0;
    entry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    entry.cache_read_tokens += r.cache_read_tokens ?? 0;
    entry.turns += 1;
    modelMap.set(key, entry);
  }
  const by_model = [...modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);

  // Daily trend — all days that have data, sorted chronologically
  const dayMap = new Map();
  for (const r of rows) {
    const date = new Date(r.ts).toISOString().slice(0, 10);
    const entry = dayMap.get(date) ?? { date, cost_usd: 0 };
    entry.cost_usd += r.cost_usd ?? 0;
    dayMap.set(date, entry);
  }
  const daily_trend = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const cache_flushes = computeCacheFlushes(rows);

  return { total_usd, row_count: rows.length, by_project, by_model, daily_trend, cache_flushes };
}
