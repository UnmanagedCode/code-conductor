// Per-turn cost persistence. Subscribes to instance events and appends one
// JSONL row per turn_end to <orchStoreRoot()>/costs.jsonl. Append-only so
// writes are a single fs.appendFile — no parse/rewrite of the whole file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

export function costsPath() {
  return path.join(orchStoreRoot(), 'costs.jsonl');
}

async function appendCostRow(inst, ev, parentSessionId) {
  // Per-turn token totals come ONLY from the SDK `result.usage` (a genuine
  // per-turn sum). The Ollama backend (`ollama launch claude`) omits `usage`
  // from its `result` frames, so ev.usage is null there — we OMIT the four
  // token fields rather than persist fabricated 0s. (The only other token
  // signal, message_start.usage, is a last-value-wins context-size snapshot,
  // not a summable per-turn total — summing it would double-count.) Mirrors the
  // client UsageTracker guard in public/usage.js. The conditional spread keeps
  // the fields in-position so Anthropic rows (usage always present) serialize
  // byte-identically. Read side treats an ollama row (no cost_usd) as
  // token-unknown, so the omission drives an honest `—` in the #costs dashboard.
  const usage = ev.usage;
  const tokenFields = usage ? {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
  } : {};
  const row = {
    ts: Date.now(),
    project: inst.project ?? null,
    model: inst.model ?? null,
    sessionId: inst.sessionId ?? null,
    // Durable link to the spawning conductor's CURRENT sessionId (resolved at
    // write-time from the ephemeral callerInstanceId). null for UI/HTTP-created
    // sessions. Drives the tree rollup in getSessionStats. Additive.
    parentSessionId: parentSessionId ?? null,
    // Turn timing from the SDK result. duration_ms is the turn walltime (incl.
    // tool exec) and is genuinely per-turn. duration_api_ms (LLM/inference time)
    // is stored as the PER-TURN DELTA the parser derives from a cumulative SDK
    // counter (mirrors cost_usd/costDelta) — NOT the raw cumulative reading.
    // Additive: summed directly in the aggregates. Rows written before these
    // fields lack them (treated as 0); pre-fix rows carry the old cumulative
    // duration_api_ms and are left as-is (fix-forward, no per-row repair).
    duration_ms: ev.durationMs ?? null,
    duration_api_ms: ev.durationApiMsDelta ?? ev.durationApiMs ?? null,
    ...tokenFields,
    // Cache-miss verdict + per-request evidence, captured live from the turn's
    // first message_start (src/instances.js). `cache_miss` means "a cross-turn
    // eviction (full or partial) was detected": the turn's first-request
    // cache_read was below the prior turn's cached prefix, or (turn 1 / after a
    // compaction/model-switch/rewind re-baseline) creation>read. `first_req_evicted`
    // is the evicted-token estimate (P_{N-1} - first read) on the cross-turn path,
    // 0 otherwise. Additive — rows written before these fields lack them; the
    // cache_miss flag on legacy rows is backfilled (heuristically) by migration 0014.
    cache_miss: ev.cacheMiss ?? false,
    first_req_cache_read: ev.firstReqCacheRead ?? 0,
    first_req_cache_creation: ev.firstReqCacheCreation ?? 0,
    first_req_evicted: ev.firstReqEvicted ?? 0,
  };
  // ollama's total_cost_usd is Anthropic list pricing applied to a free local
  // backend — meaningless, so omit the field rather than persist a bogus number.
  if (inst.backendKind !== 'ollama') {
    row.cost_usd = ev.costDelta ?? ev.cost ?? 0;
  }
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
    // Resolve the spawning conductor's current sessionId from the worker's
    // stable callerInstanceId (see InstanceManager.callerSessionId).
    const parentSessionId = inst.callerInstanceId
      ? instances.callerSessionId(inst.callerInstanceId)
      : null;
    appendCostRow(inst, ev, parentSessionId);
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
    // A row's token counts are trustworthy only for Anthropic rows. Ollama rows
    // carry no summable per-turn token total and omit `cost_usd` (see
    // appendCostRow) — so `'cost_usd' in r` is the canonical current-format
    // Anthropic marker, and it also correctly classifies legacy ollama rows
    // that carry stale `input_tokens: 0` (they lack cost_usd). Rows without
    // trustworthy tokens are excluded from the token sums and leave `_hasTokens`
    // false, so an ollama-only group reports tokens_known:false → `—` in the UI,
    // while a mixed group keeps its real Anthropic token totals.
    const tokensKnown = 'cost_usd' in r;
    const key = r.project ?? '(unknown)';
    if (!projectMap.has(key)) {
      projectMap.set(key, { project: key, cost_usd: 0, duration_ms: 0, duration_api_ms: 0, turns: 0, cache_misses: 0, _hasTokens: false, _sessionSet: new Set(), _modelMap: new Map() });
    }
    const entry = projectMap.get(key);
    entry.cost_usd += r.cost_usd ?? 0;
    entry.duration_ms += r.duration_ms ?? 0;
    entry.duration_api_ms += r.duration_api_ms ?? 0;
    entry.turns += 1;
    if (r.cache_miss === true) entry.cache_misses += 1;
    if (r.sessionId != null) entry._sessionSet.add(r.sessionId);

    const mKey = r.model ?? '(unknown)';
    const mEntry = entry._modelMap.get(mKey) ?? {
      model: mKey, cost_usd: 0, duration_ms: 0, duration_api_ms: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0, cache_misses: 0, _hasTokens: false, _sessionSet: new Set(),
    };
    mEntry.cost_usd += r.cost_usd ?? 0;
    mEntry.duration_ms += r.duration_ms ?? 0;
    mEntry.duration_api_ms += r.duration_api_ms ?? 0;
    if (tokensKnown) {
      entry._hasTokens = true;
      mEntry._hasTokens = true;
      mEntry.input_tokens += r.input_tokens ?? 0;
      mEntry.output_tokens += r.output_tokens ?? 0;
      mEntry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
      mEntry.cache_read_tokens += r.cache_read_tokens ?? 0;
    }
    mEntry.turns += 1;
    if (r.cache_miss === true) mEntry.cache_misses += 1;
    if (r.sessionId != null) mEntry._sessionSet.add(r.sessionId);
    entry._modelMap.set(mKey, mEntry);
  }
  const by_project = [...projectMap.values()].map(e => {
    const by_model = [...e._modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).map(m => {
      const { _sessionSet, _hasTokens, ...rest } = m;
      return { ...rest, sessions: _sessionSet.size, tokens_known: _hasTokens };
    });
    return { project: e.project, cost_usd: e.cost_usd, duration_ms: e.duration_ms, duration_api_ms: e.duration_api_ms, turns: e.turns, cache_misses: e.cache_misses, sessions: e._sessionSet.size, tokens_known: e._hasTokens, by_model };
  }).sort((a, b) => b.cost_usd - a.cost_usd);

  // By model
  const modelMap = new Map();
  for (const r of rows) {
    const tokensKnown = 'cost_usd' in r; // see the by_project loop for rationale
    const key = r.model ?? '(unknown)';
    const entry = modelMap.get(key) ?? {
      model: key, cost_usd: 0, duration_ms: 0, duration_api_ms: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0, cache_misses: 0, _hasTokens: false, _sessionSet: new Set(),
    };
    entry.cost_usd += r.cost_usd ?? 0;
    entry.duration_ms += r.duration_ms ?? 0;
    entry.duration_api_ms += r.duration_api_ms ?? 0;
    if (tokensKnown) {
      entry._hasTokens = true;
      entry.input_tokens += r.input_tokens ?? 0;
      entry.output_tokens += r.output_tokens ?? 0;
      entry.cache_creation_tokens += r.cache_creation_tokens ?? 0;
      entry.cache_read_tokens += r.cache_read_tokens ?? 0;
    }
    entry.turns += 1;
    if (r.cache_miss === true) entry.cache_misses += 1;
    if (r.sessionId != null) entry._sessionSet.add(r.sessionId);
    modelMap.set(key, entry);
  }
  const by_model = [...modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).map(m => {
    const { _sessionSet, _hasTokens, ...rest } = m;
    return { ...rest, sessions: _sessionSet.size, tokens_known: _hasTokens };
  });

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

// Read + JSON-parse the cost log into rows (empty array when the log is absent).
async function readCostRows() {
  let raw;
  try {
    raw = await fs.readFile(costsPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Per-session cost/timing, both for the session alone (`own`) and rolled up to
// include every worker session it spawned, recursively (`rolled`, via the
// parentSessionId tree). `workerSessions` counts the distinct descendant
// sessions folded into the rollup.
export async function getSessionStats(sessionId) {
  const zero = () => ({ cost_usd: 0, duration_ms: 0, duration_api_ms: 0, turns: 0 });
  const rows = await readCostRows();

  // Per-session totals + the parent→children adjacency for the tree walk.
  const bySession = new Map();
  const children = new Map();
  for (const r of rows) {
    const sid = r.sessionId;
    if (sid == null) continue;
    const s = bySession.get(sid) ?? zero();
    s.cost_usd += r.cost_usd ?? 0;
    s.duration_ms += r.duration_ms ?? 0;
    s.duration_api_ms += r.duration_api_ms ?? 0;
    s.turns += 1;
    bySession.set(sid, s);

    const parent = r.parentSessionId;
    if (parent != null && parent !== sid) {
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(sid);
    }
  }

  const own = bySession.get(sessionId) ?? zero();

  // DFS over the descendant tree; `visited` guards against cycles.
  const rolled = zero();
  const visited = new Set();
  const stack = [sessionId];
  while (stack.length) {
    const sid = stack.pop();
    if (visited.has(sid)) continue;
    visited.add(sid);
    const s = bySession.get(sid);
    if (s) {
      rolled.cost_usd += s.cost_usd;
      rolled.duration_ms += s.duration_ms;
      rolled.duration_api_ms += s.duration_api_ms;
      rolled.turns += s.turns;
    }
    for (const child of children.get(sid) ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }

  return { sessionId, own, rolled, workerSessions: Math.max(0, visited.size - 1) };
}
