// Per-turn cost persistence. Subscribes to instance events and appends one
// JSONL row per turn_end to <orchStoreRoot()>/costs.jsonl. Append-only so
// writes are a single fs.appendFile — no parse/rewrite of the whole file —
// serialised behind a per-process chain so same-tick turn_ends land in emit
// order (see `serialize` below).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { CLAUDE_BACKEND_ID } from './modelVersions.ts';
import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';
import type { UiEvent } from './parser.ts';

export function costsPath(): string {
  return path.join(orchStoreRoot(), 'costs.jsonl');
}

// Serialise appends behind a per-process promise chain. The event listener is
// synchronous so it cannot await the write; two turn_ends in one tick would
// otherwise start two independent mkdir→open→write chains whose threadpool
// completion order is undefined, landing the rows in either order (and racing
// two concurrent recursive mkdirs, where any throw silently drops a row).
// The chain advances on both outcomes and is never left rejected, so one failed
// write can't poison every later append.
let writeChain: Promise<void> = Promise.resolve();
function serialize(fn: () => Promise<void>): void {
  writeChain = writeChain.then(fn, fn).catch(() => {});
}

// Append one built row to an already-resolved path. mkdir stays per-write: the
// store dir is absent before the first row and can be removed underneath us.
async function writeCostRow(p: string, row: CostRow): Promise<void> {
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    console.warn('cost-tracking: failed to append row:', errMsg(e));
  }
}

interface CostRow {
  ts: number;
  project: string | null;
  model: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  cache_miss: boolean;
  first_req_cache_read: number;
  first_req_cache_creation: number;
  first_req_evicted: number;
  cost_usd?: number;
}

// The event fields beyond `kind` reach the listener through UiEvent's index
// signature (untyped), so every numeric/boolean read is validated here. The
// SDK/parser contract supplies numbers, nulls, and booleans; anything else is
// coerced fail-safe (0 / false) rather than persisted as garbage. See the
// commit message for the exact coercions.
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// SYNCHRONOUS by design: the row and the target path are snapshotted in the
// emit tick, and only the write is queued. `inst` is the live Instance (its
// sessionId/model move on renewal/rewind/model-switch) and costsPath() reads
// PROJECTS_ROOT live — resolving either at write time would capture whatever
// they had become by the time the queue drained.
function appendCostRow(inst: InstanceLike, ev: UiEvent, parentSessionId: string | null): void {
  // Per-turn token totals come ONLY from the SDK `result.usage` (a genuine
  // per-turn sum). A substitution backend (e.g. the built-in `ollama` row) omits
  // `usage` from its `result` frames, so ev.usage is null there — we OMIT the four
  // token fields rather than persist fabricated 0s. (The only other token
  // signal, message_start.usage, is a last-value-wins context-size snapshot,
  // not a summable per-turn total — summing it would double-count.) Mirrors the
  // client UsageTracker guard in public/usage.js. The conditional spread keeps
  // the fields in-position so Anthropic rows (usage always present) serialize
  // byte-identically. Read side treats a non-Claude row (no cost_usd) as
  // token-unknown, so the omission drives an honest `—` in the #costs dashboard.
  const rawUsage = ev.usage;
  const usage = rawUsage != null && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
    ? rawUsage as { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown }
    : null;
  const tokenFields = usage ? {
    input_tokens: numOrNull(usage.input_tokens) ?? 0,
    output_tokens: numOrNull(usage.output_tokens) ?? 0,
    cache_creation_tokens: numOrNull(usage.cache_creation_input_tokens) ?? 0,
    cache_read_tokens: numOrNull(usage.cache_read_input_tokens) ?? 0,
  } : {};
  const row: CostRow = {
    ts: Date.now(),
    project: inst.project ?? null,
    model: inst.model ?? null,
    sessionId: inst.sessionId ?? null,
    // Durable link to the spawning conductor's CURRENT sessionId (resolved in
    // the emit tick from the ephemeral callerInstanceId). null for UI/HTTP-created
    // sessions. Drives the tree rollup in getSessionStats. Additive.
    parentSessionId: parentSessionId ?? null,
    // Turn timing from the SDK result. duration_ms is the turn walltime (incl.
    // tool exec) and is genuinely per-turn. duration_api_ms (LLM/inference time)
    // is stored as the PER-TURN DELTA the parser derives from a cumulative SDK
    // counter (mirrors cost_usd/costDelta) — NOT the raw cumulative reading.
    // Additive: summed directly in the aggregates. Rows written before these
    // fields lack them (treated as 0); pre-fix rows carry the old cumulative
    // duration_api_ms and are left as-is (fix-forward, no per-row repair).
    duration_ms: numOrNull(ev.durationMs) ?? null,
    duration_api_ms: numOrNull(ev.durationApiMsDelta) ?? numOrNull(ev.durationApiMs) ?? null,
    ...tokenFields,
    // Cache-miss verdict + per-request evidence, captured live from the turn's
    // first message_start (src/instances.js). `cache_miss` means "a cross-turn
    // eviction (full or partial) was detected": the turn's first-request
    // cache_read was below the prior turn's cached prefix, or (turn 1 / after a
    // compaction/model-switch/rewind re-baseline) creation>read. `first_req_evicted`
    // is the evicted-token estimate (P_{N-1} - first read) on the cross-turn path,
    // 0 otherwise. Additive — rows written before these fields lack them; the
    // cache_miss flag on legacy rows is backfilled (heuristically) by migration 0014.
    cache_miss: ev.cacheMiss === true,
    first_req_cache_read: numOrNull(ev.firstReqCacheRead) ?? 0,
    first_req_cache_creation: numOrNull(ev.firstReqCacheCreation) ?? 0,
    first_req_evicted: numOrNull(ev.firstReqEvicted) ?? 0,
  };
  // A substitution backend's total_cost_usd is Anthropic list pricing applied to
  // someone else's model — meaningless, so omit the field rather than persist a
  // bogus number. Only the identity `claude` backend bills the Anthropic account.
  if (inst.backend === CLAUDE_BACKEND_ID) {
    row.cost_usd = numOrNull(ev.costDelta) ?? numOrNull(ev.cost) ?? 0;
  }
  const p = costsPath();
  serialize(() => writeCostRow(p, row));
}

export function initCostTracking(instances: InstanceManagerLike | null | undefined): void {
  if (!instances) return;
  instances.on('event', ({ id, ev }) => {
    if (!ev || ev.kind !== 'turn_end') return;
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

// ── Read side ──────────────────────────────────────────────────────────
// The log is a JSONL boundary: every row is parsed as unknown and the fields
// below are narrowed per-read. Numeric reads coerce non-numbers to 0 (the
// writers normalize already; foreign/legacy garbage is not allowed to poison
// the aggregates with string concatenation).

type Row = Record<string, unknown>;

function rowNum(r: Row, key: string): number {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function rowStr(r: Row, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : '(unknown)';
}

interface ModelAccumulator {
  model: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  turns: number;
  cache_misses: number;
  _hasTokens: boolean;
  _sessionSet: Set<string>;
}

interface ProjectAccumulator {
  project: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  turns: number;
  cache_misses: number;
  _hasTokens: boolean;
  _sessionSet: Set<string>;
  _modelMap: Map<string, ModelAccumulator>;
}

interface ModelSummary {
  model: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  turns: number;
  cache_misses: number;
  sessions: number;
  tokens_known: boolean;
}

interface CostSummary {
  total_usd: number;
  row_count: number;
  by_project: Array<{
    project: string;
    cost_usd: number;
    duration_ms: number;
    duration_api_ms: number;
    turns: number;
    cache_misses: number;
    sessions: number;
    tokens_known: boolean;
    by_model: ModelSummary[];
  }>;
  by_model: ModelSummary[];
  daily_trend: Array<{ date: string; cost_usd: number }>;
}

function newModelAccumulator(key: string): ModelAccumulator {
  return {
    model: key, cost_usd: 0, duration_ms: 0, duration_api_ms: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0, turns: 0, cache_misses: 0, _hasTokens: false, _sessionSet: new Set(),
  };
}

function accumulateModel(m: ModelAccumulator, r: Row): void {
  m.cost_usd += rowNum(r, 'cost_usd');
  m.duration_ms += rowNum(r, 'duration_ms');
  m.duration_api_ms += rowNum(r, 'duration_api_ms');
  if ('cost_usd' in r) {
    m._hasTokens = true;
    m.input_tokens += rowNum(r, 'input_tokens');
    m.output_tokens += rowNum(r, 'output_tokens');
    m.cache_creation_tokens += rowNum(r, 'cache_creation_tokens');
    m.cache_read_tokens += rowNum(r, 'cache_read_tokens');
  }
  m.turns += 1;
  if (r.cache_miss === true) m.cache_misses += 1;
  if (typeof r.sessionId === 'string') m._sessionSet.add(r.sessionId);
}

function modelSummary(m: ModelAccumulator): ModelSummary {
  const { _sessionSet, _hasTokens, ...rest } = m;
  return { ...rest, sessions: _sessionSet.size, tokens_known: _hasTokens };
}

export async function getCostSummary(): Promise<CostSummary> {
  let raw: string;
  try {
    raw = await fs.readFile(costsPath(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') {
      return {
        total_usd: 0, row_count: 0, by_project: [], by_model: [], daily_trend: [],
      };
    }
    throw e;
  }

  const rows = raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }).filter((r): r is Row => typeof r === 'object' && r !== null);

  const total_usd = rows.reduce((s, r) => s + rowNum(r, 'cost_usd'), 0);

  // By project (with nested per-model breakdown)
  const projectMap = new Map<string, ProjectAccumulator>();
  for (const r of rows) {
    // A row's token counts are trustworthy only for Anthropic rows. Non-Claude
    // rows carry no summable per-turn token total and omit `cost_usd` (see
    // appendCostRow) — so `'cost_usd' in r` is the canonical current-format
    // Anthropic marker, and it also correctly classifies legacy non-Claude rows
    // that carry stale `input_tokens: 0` (they lack cost_usd). Rows without
    // trustworthy tokens are excluded from the token sums and leave `_hasTokens`
    // false, so a non-Claude-only group reports tokens_known:false → `—` in the UI,
    // while a mixed group keeps its real Anthropic token totals.
    const tokensKnown = 'cost_usd' in r;
    const key = rowStr(r, 'project');
    let entry = projectMap.get(key);
    if (!entry) {
      entry = { project: key, cost_usd: 0, duration_ms: 0, duration_api_ms: 0, turns: 0, cache_misses: 0, _hasTokens: false, _sessionSet: new Set(), _modelMap: new Map() };
      projectMap.set(key, entry);
    }
    entry.cost_usd += rowNum(r, 'cost_usd');
    entry.duration_ms += rowNum(r, 'duration_ms');
    entry.duration_api_ms += rowNum(r, 'duration_api_ms');
    entry.turns += 1;
    if (r.cache_miss === true) entry.cache_misses += 1;
    if (typeof r.sessionId === 'string') entry._sessionSet.add(r.sessionId);

    const mKey = rowStr(r, 'model');
    const mEntry = entry._modelMap.get(mKey) ?? newModelAccumulator(mKey);
    accumulateModel(mEntry, r);
    if (tokensKnown) entry._hasTokens = true;
    entry._modelMap.set(mKey, mEntry);
  }
  const by_project = [...projectMap.values()].map(e => {
    const by_model = [...e._modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).map(modelSummary);
    return { project: e.project, cost_usd: e.cost_usd, duration_ms: e.duration_ms, duration_api_ms: e.duration_api_ms, turns: e.turns, cache_misses: e.cache_misses, sessions: e._sessionSet.size, tokens_known: e._hasTokens, by_model };
  }).sort((a, b) => b.cost_usd - a.cost_usd);

  // By model
  const modelMap = new Map<string, ModelAccumulator>();
  for (const r of rows) {
    const tokensKnown = 'cost_usd' in r; // see the by_project loop for rationale
    const key = rowStr(r, 'model');
    const entry = modelMap.get(key) ?? newModelAccumulator(key);
    accumulateModel(entry, r);
    if (tokensKnown) entry._hasTokens = true;
    modelMap.set(key, entry);
  }
  const by_model = [...modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).map(modelSummary);

  // Daily trend — all days that have data, sorted chronologically
  const dayMap = new Map<string, { date: string; cost_usd: number }>();
  for (const r of rows) {
    const ts = r.ts;
    const date = new Date(typeof ts === 'number' ? ts : 0).toISOString().slice(0, 10);
    const entry = dayMap.get(date) ?? { date, cost_usd: 0 };
    entry.cost_usd += rowNum(r, 'cost_usd');
    dayMap.set(date, entry);
  }
  const daily_trend = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { total_usd, row_count: rows.length, by_project, by_model, daily_trend };
}

// Read + JSON-parse the cost log into rows (empty array when the log is absent).
async function readCostRows(): Promise<Row[]> {
  let raw: string;
  try {
    raw = await fs.readFile(costsPath(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }).filter((r): r is Row => typeof r === 'object' && r !== null);
}

interface SessionAccumulator {
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  turns: number;
}

// Per-session cost/timing, both for the session alone (`own`) and rolled up to
// include every worker session it spawned, recursively (`rolled`, via the
// parentSessionId tree). `workerSessions` counts the distinct descendant
// sessions folded into the rollup.
export async function getSessionStats(sessionId: string): Promise<{
  sessionId: string;
  own: SessionAccumulator;
  rolled: SessionAccumulator;
  workerSessions: number;
}> {
  const zero = (): SessionAccumulator => ({ cost_usd: 0, duration_ms: 0, duration_api_ms: 0, turns: 0 });
  const rows = await readCostRows();

  // Per-session totals + the parent→children adjacency for the tree walk.
  const bySession = new Map<string, SessionAccumulator>();
  const children = new Map<string, Set<string>>();
  for (const r of rows) {
    const sid = r.sessionId;
    if (typeof sid !== 'string') continue;
    const s = bySession.get(sid) ?? zero();
    s.cost_usd += rowNum(r, 'cost_usd');
    s.duration_ms += rowNum(r, 'duration_ms');
    s.duration_api_ms += rowNum(r, 'duration_api_ms');
    s.turns += 1;
    bySession.set(sid, s);

    const parent = r.parentSessionId;
    if (typeof parent === 'string' && parent !== sid) {
      let kids = children.get(parent);
      if (!kids) { kids = new Set(); children.set(parent, kids); }
      kids.add(sid);
    }
  }

  const own = bySession.get(sessionId) ?? zero();

  // DFS over the descendant tree; `visited` guards against cycles.
  const rolled = zero();
  const visited = new Set<string>();
  const stack: string[] = [sessionId];
  while (stack.length) {
    const sid = stack.pop();
    if (sid === undefined) continue;
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
