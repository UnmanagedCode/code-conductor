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
    // Decisive cache-flush verdict + per-request evidence, captured live from
    // the turn's first message_start (src/instances.js). Additive — rows
    // written before this feature lack them and are backfilled (heuristically)
    // by migration 0014.
    cache_flush: ev.cacheFlush ?? false,
    first_req_cache_read: ev.firstReqCacheRead ?? 0,
    first_req_cache_creation: ev.firstReqCacheCreation ?? 0,
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

export async function getCostSummary() {
  let raw;
  try {
    raw = await fs.readFile(costsPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        total_usd: 0, row_count: 0, by_project: [], by_model: [], daily_trend: [],
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
      projectMap.set(key, { project: key, cost_usd: 0, turns: 0, cache_flushes: 0, _modelMap: new Map() });
    }
    const entry = projectMap.get(key);
    entry.cost_usd += r.cost_usd ?? 0;
    entry.turns += 1;
    if (r.cache_flush === true) entry.cache_flushes += 1;

    const mKey = r.model ?? '(unknown)';
    const mEntry = entry._modelMap.get(mKey) ?? {
      model: mKey, cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0, cache_flushes: 0,
    };
    mEntry.cost_usd += r.cost_usd ?? 0;
    mEntry.input_tokens += r.input_tokens ?? 0;
    mEntry.output_tokens += r.output_tokens ?? 0;
    mEntry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    mEntry.cache_read_tokens += r.cache_read_tokens ?? 0;
    mEntry.turns += 1;
    if (r.cache_flush === true) mEntry.cache_flushes += 1;
    entry._modelMap.set(mKey, mEntry);
  }
  const by_project = [...projectMap.values()].map(e => {
    const by_model = [...e._modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);
    return { project: e.project, cost_usd: e.cost_usd, turns: e.turns, cache_flushes: e.cache_flushes, by_model };
  }).sort((a, b) => b.cost_usd - a.cost_usd);

  // By model
  const modelMap = new Map();
  for (const r of rows) {
    const key = r.model ?? '(unknown)';
    const entry = modelMap.get(key) ?? {
      model: key, cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0, cache_flushes: 0,
    };
    entry.cost_usd += r.cost_usd ?? 0;
    entry.input_tokens += r.input_tokens ?? 0;
    entry.output_tokens += r.output_tokens ?? 0;
    entry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    entry.cache_read_tokens += r.cache_read_tokens ?? 0;
    entry.turns += 1;
    if (r.cache_flush === true) entry.cache_flushes += 1;
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

  return { total_usd, row_count: rows.length, by_project, by_model, daily_trend };
}
