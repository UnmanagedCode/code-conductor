// Integration tests for the cost-tracking feature.
//
// Tests:
//  1. Row append — a synthetic turn_end via initCostTracking writes a valid JSONL row.
//  2. Summary aggregation — by_project, by_model, daily_trend, total_usd.
//  3. Missing file — getCostSummary() returns zeros/empty without throwing.
//  4. Cache-miss detection — first-turn exclusion, spike detection, normal
//     extension, multi-session aggregation, null-sessionId exclusion.
//  5. Route smoke — GET /api/costs/summary returns 200 with the right shape.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { bootServer, api } from './helpers.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cost-test-'));
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// Build a minimal fake instance object.
function fakeInst({ project = 'proj-a', model = 'claude-opus-4-8', sessionId = 'sess-1', callerInstanceId = null } = {}) {
  return { project, model, sessionId, callerInstanceId };
}

// Build a synthetic turn_end event. The cacheMiss / firstReq* fields mirror
// the decisive verdict instances.js enriches onto turn_end before it's
// persisted (see appendCostRow).
function turnEndEv({ costDelta = 0.01, usage, cacheMiss, firstReqCacheRead, firstReqCacheCreation, durationMs, durationApiMs, durationApiMsDelta } = {}) {
  return {
    kind: 'turn_end',
    cost: costDelta,      // cumulative total (same as delta for single-turn tests)
    costDelta,
    usage: usage ?? {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 200,
    },
    cacheMiss,
    firstReqCacheRead,
    firstReqCacheCreation,
    durationMs,
    durationApiMs,        // raw cumulative session API time
    durationApiMsDelta,   // per-turn LLM time (preferred when persisting)
  };
}

// ── 1. Row append ─────────────────────────────────────────────────────────────

test('cost-tracking: turn_end appends a valid JSONL row', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    // Dynamically import with fresh module cache is not straightforward in
    // node:test isolation mode, so we import the module functions directly.
    // Each test boots with its own PROJECTS_ROOT so costsPath() resolves to dir.
    const { initCostTracking, costsPath } = await import('../src/costTracking.js');

    // Create a minimal EventEmitter acting as InstanceManager.
    const emitter = new EventEmitter();
    emitter.get = () => fakeInst();
    initCostTracking(emitter);

    // Emit a turn_end event carrying a decisive cache-miss verdict.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({
      costDelta: 0.0123, cacheMiss: true, firstReqCacheRead: 300, firstReqCacheCreation: 180000,
    }) });
    // And a plain turn_end with no verdict fields — should persist the defaults.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.001 }) });

    // Wait briefly for the async appendFile to complete.
    await new Promise(r => setTimeout(r, 50));

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true }); // ensure readable even if absent
    const raw = await fs.readFile(costsPath(), 'utf8').catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'two JSONL rows written');
    const row = JSON.parse(lines[0]);
    assert.equal(row.project, 'proj-a');
    assert.equal(row.model, 'claude-opus-4-8');
    assert.equal(row.sessionId, 'sess-1');
    assert.ok(Math.abs(row.cost_usd - 0.0123) < 1e-9, `cost_usd should be 0.0123, got ${row.cost_usd}`);
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 50);
    assert.equal(row.cache_creation_tokens, 20);
    assert.equal(row.cache_read_tokens, 200);
    assert.ok(typeof row.ts === 'number' && row.ts > 0, 'ts should be a positive number');
    // Decisive cache-miss fields persist from the enriched event.
    assert.equal(row.cache_miss, true);
    assert.equal(row.first_req_cache_read, 300);
    assert.equal(row.first_req_cache_creation, 180000);
    // The plain turn_end defaults to no-miss / zeroed evidence.
    const row2 = JSON.parse(lines[1]);
    assert.equal(row2.cache_miss, false);
    assert.equal(row2.first_req_cache_read, 0);
    assert.equal(row2.first_req_cache_creation, 0);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 2. Summary aggregation ────────────────────────────────────────────────────

test('cost-tracking: getCostSummary aggregates correctly', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getCostSummary, costsPath } = await import('../src/costTracking.js');

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });

    const rows = [
      { ts: new Date('2026-06-01').getTime(), project: 'alpha', model: 'claude-opus-4-8',   sessionId: 's1', input_tokens: 100, output_tokens: 50, cache_creation_tokens: 10, cache_read_tokens: 200, cost_usd: 0.05, cache_miss: false },
      { ts: new Date('2026-06-01').getTime(), project: 'alpha', model: 'claude-opus-4-8',   sessionId: 's1', input_tokens: 80,  output_tokens: 40, cache_creation_tokens:  5, cache_read_tokens: 100, cost_usd: 0.03, cache_miss: true },
      { ts: new Date('2026-06-02').getTime(), project: 'beta',  model: 'claude-sonnet-4-6', sessionId: 's2', input_tokens: 200, output_tokens: 80, cache_creation_tokens: 20, cache_read_tokens: 300, cost_usd: 0.02, cache_miss: false },
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const summary = await getCostSummary();
    assert.ok(Math.abs(summary.total_usd - 0.10) < 1e-9, `total_usd should be 0.10, got ${summary.total_usd}`);
    assert.equal(summary.row_count, 3);

    // by_project — alpha first (0.08 > 0.02)
    assert.equal(summary.by_project.length, 2);
    assert.equal(summary.by_project[0].project, 'alpha');
    assert.ok(Math.abs(summary.by_project[0].cost_usd - 0.08) < 1e-9);
    assert.equal(summary.by_project[0].turns, 2);
    assert.equal(summary.by_project[0].cache_misses, 1, 'alpha has 1 miss (row 2)');
    assert.equal(summary.by_project[0].sessions, 1, 'alpha: both rows are session s1');
    assert.equal(summary.by_project[1].project, 'beta');
    assert.equal(summary.by_project[1].cache_misses, 0, 'beta has no misses');
    assert.equal(summary.by_project[1].sessions, 1);

    // by_project[*].by_model — nested per-model breakdown
    const alphaModels = summary.by_project[0].by_model;
    assert.ok(Array.isArray(alphaModels), 'alpha.by_model should be an array');
    assert.equal(alphaModels.length, 1, 'alpha has 1 model');
    assert.equal(alphaModels[0].model, 'claude-opus-4-8');
    assert.ok(Math.abs(alphaModels[0].cost_usd - 0.08) < 1e-9);
    assert.equal(alphaModels[0].input_tokens, 180);
    assert.equal(alphaModels[0].output_tokens, 90);
    assert.equal(alphaModels[0].cache_creation_tokens, 15);
    assert.equal(alphaModels[0].cache_read_tokens, 300);
    assert.equal(alphaModels[0].turns, 2);
    assert.equal(alphaModels[0].cache_misses, 1);
    assert.equal(alphaModels[0].sessions, 1);

    const betaModels = summary.by_project[1].by_model;
    assert.ok(Array.isArray(betaModels), 'beta.by_model should be an array');
    assert.equal(betaModels.length, 1, 'beta has 1 model');
    assert.equal(betaModels[0].model, 'claude-sonnet-4-6');
    assert.equal(betaModels[0].cache_misses, 0);

    // by_model
    assert.equal(summary.by_model.length, 2);
    const opus = summary.by_model.find(m => m.model === 'claude-opus-4-8');
    assert.ok(opus, 'opus entry should exist');
    assert.ok(Math.abs(opus.cost_usd - 0.08) < 1e-9);
    assert.equal(opus.input_tokens, 180);
    assert.equal(opus.output_tokens, 90);
    assert.equal(opus.cache_creation_tokens, 15);
    assert.equal(opus.cache_read_tokens, 300);
    assert.equal(opus.turns, 2);
    assert.equal(opus.cache_misses, 1);
    assert.equal(opus.sessions, 1);

    // daily_trend — sorted chronologically
    assert.equal(summary.daily_trend.length, 2);
    assert.equal(summary.daily_trend[0].date, '2026-06-01');
    assert.ok(Math.abs(summary.daily_trend[0].cost_usd - 0.08) < 1e-9);
    assert.equal(summary.daily_trend[1].date, '2026-06-02');
    assert.ok(Math.abs(summary.daily_trend[1].cost_usd - 0.02) < 1e-9);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 3. Missing file ───────────────────────────────────────────────────────────

test('cost-tracking: getCostSummary returns zeros when costs.jsonl is absent', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getCostSummary } = await import('../src/costTracking.js');
    const summary = await getCostSummary();
    assert.equal(summary.total_usd, 0);
    assert.equal(summary.row_count, 0);
    assert.deepEqual(summary.by_project, []);
    assert.deepEqual(summary.by_model, []);
    assert.deepEqual(summary.daily_trend, []);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 4. Per-model / per-project miss counts ───────────────────────────────────

test('cost-tracking: by_model and by_project entries carry correct cache_misses counts', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getCostSummary, costsPath } = await import('../src/costTracking.js');

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });

    const T = (s) => new Date('2026-06-01T00:00:00Z').getTime() + s * 1000;
    const filler = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };

    // s1 — project alpha / model opus, 3 turns, 1 miss.
    // s2 — project beta / model sonnet, 1 turn, 0 misses.
    // s3 — project alpha / model haiku (same project as s1, different model), 4 turns, 1 miss.
    // null sessionId row — project gamma / model unknown-model, 0 misses (still folds into
    // its project/model bucket even without a sessionId — miss counting doesn't key on session).
    const rows = [
      { ts: T(0), sessionId: 's1', project: 'alpha', model: 'opus',   cache_miss: false, ...filler },
      { ts: T(1), sessionId: 's1', project: 'alpha', model: 'opus',   cache_miss: false, ...filler },
      { ts: T(2), sessionId: 's1', project: 'alpha', model: 'opus',   cache_miss: true,  ...filler },

      { ts: T(3), sessionId: 's2', project: 'beta',  model: 'sonnet', cache_miss: false, ...filler },

      { ts: T(4), sessionId: 's3', project: 'alpha', model: 'haiku',  cache_miss: false, ...filler },
      { ts: T(5), sessionId: 's3', project: 'alpha', model: 'haiku',  cache_miss: false, ...filler },
      { ts: T(6), sessionId: 's3', project: 'alpha', model: 'haiku',  cache_miss: true,  ...filler },
      { ts: T(7), sessionId: 's3', project: 'alpha', model: 'haiku',  cache_miss: false, ...filler },

      { ts: T(8), sessionId: null, project: 'gamma', model: 'unknown-model', cache_miss: false, ...filler },
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const summary = await getCostSummary();

    // by_model — one entry per model, misses/sessions counted regardless of project.
    const opus = summary.by_model.find(m => m.model === 'opus');
    const haiku = summary.by_model.find(m => m.model === 'haiku');
    const sonnet = summary.by_model.find(m => m.model === 'sonnet');
    const unknownModel = summary.by_model.find(m => m.model === 'unknown-model');
    assert.equal(opus.turns, 3);
    assert.equal(opus.cache_misses, 1);
    assert.equal(opus.sessions, 1, 'opus: all 3 rows are session s1');
    assert.equal(haiku.turns, 4);
    assert.equal(haiku.cache_misses, 1);
    assert.equal(haiku.sessions, 1, 'haiku: all 4 rows are session s3');
    assert.equal(sonnet.turns, 1);
    assert.equal(sonnet.cache_misses, 0);
    assert.equal(sonnet.sessions, 1);
    assert.equal(unknownModel.cache_misses, 0);
    assert.equal(unknownModel.sessions, 0, 'null sessionId is excluded from the count');

    // by_project — alpha aggregates misses across its two models (opus + haiku).
    const alpha = summary.by_project.find(p => p.project === 'alpha');
    const beta = summary.by_project.find(p => p.project === 'beta');
    const gamma = summary.by_project.find(p => p.project === 'gamma');
    assert.equal(alpha.turns, 7);
    assert.equal(alpha.cache_misses, 2, 'alpha: 1 miss from opus + 1 from haiku');
    assert.equal(alpha.sessions, 2, 'alpha: s1 (opus) + s3 (haiku) — distinct despite 7 turns');
    assert.equal(beta.cache_misses, 0);
    assert.equal(beta.sessions, 1);
    assert.equal(gamma.cache_misses, 0);
    assert.equal(gamma.sessions, 0, 'null sessionId is excluded from the count');

    // by_project[*].by_model — nested per-model breakdown carries its own count too.
    const alphaOpus = alpha.by_model.find(m => m.model === 'opus');
    const alphaHaiku = alpha.by_model.find(m => m.model === 'haiku');
    assert.equal(alphaOpus.cache_misses, 1);
    assert.equal(alphaOpus.sessions, 1);
    assert.equal(alphaHaiku.cache_misses, 1);
    assert.equal(alphaHaiku.sessions, 1);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 5. Route smoke ────────────────────────────────────────────────────────────

test('GET /api/costs/summary returns 200 with correct shape (no data)', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const { status, body } = await api(baseUrl, 'GET', '/api/costs/summary');
    assert.equal(status, 200);
    assert.equal(body.total_usd, 0);
    assert.equal(body.row_count, 0);
    assert.ok(Array.isArray(body.by_project), 'by_project should be array');
    assert.ok(Array.isArray(body.by_model), 'by_model should be array');
    assert.ok(Array.isArray(body.daily_trend), 'daily_trend should be array');
  } finally {
    await close();
  }
});

// ── 6. Timing persistence + parent-session resolution ────────────────────────

test('cost-tracking: turn_end persists timing + resolves parentSessionId', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { initCostTracking, costsPath } = await import('../src/costTracking.js');

    // Emitter doubling as InstanceManager: a worker whose callerInstanceId
    // (the conductor's stable instanceId) resolves live to its current sessionId.
    const worker = fakeInst({ sessionId: 'worker-1', callerInstanceId: 'cond-inst' });
    const emitter = new EventEmitter();
    emitter.get = () => worker;
    emitter.callerSessionId = (handle) => (handle === 'cond-inst' ? 'conductor-1' : null);
    initCostTracking(emitter);

    // Turn with timing fields.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.02, durationMs: 8000, durationApiMs: 3200 }) });
    // Turn missing timing — should default to null (legacy shape).
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.01 }) });

    await new Promise(r => setTimeout(r, 50));

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });
    const lines = (await fs.readFile(costsPath(), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const row = JSON.parse(lines[0]);
    assert.equal(row.duration_ms, 8000);
    assert.equal(row.duration_api_ms, 3200);
    assert.equal(row.parentSessionId, 'conductor-1', 'callerInstanceId resolved to conductor sessionId');

    const row2 = JSON.parse(lines[1]);
    assert.equal(row2.duration_ms, null, 'missing timing defaults to null');
    assert.equal(row2.duration_api_ms, null);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

test('cost-tracking: persists per-turn durationApiMsDelta as duration_api_ms', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { initCostTracking, costsPath } = await import('../src/costTracking.js');
    const emitter = new EventEmitter();
    emitter.get = () => fakeInst();
    initCostTracking(emitter);

    // Both fields present: the per-turn delta wins over the raw cumulative value.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.02, durationApiMs: 54626, durationApiMsDelta: 12430 }) });
    // Only the raw cumulative present (legacy in-flight event): falls back to it.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.01, durationApiMs: 3200 }) });

    await new Promise(r => setTimeout(r, 50));

    await fs.mkdir(path.join(dir, '.code-conductor'), { recursive: true });
    const lines = (await fs.readFile(costsPath(), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    assert.equal(JSON.parse(lines[0]).duration_api_ms, 12430, 'stores the per-turn delta, not the cumulative total');
    assert.equal(JSON.parse(lines[1]).duration_api_ms, 3200, 'falls back to raw when no delta present');
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 7. Summary timing aggregation (with legacy rows) ─────────────────────────

test('cost-tracking: getCostSummary sums timing and tolerates legacy rows', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getCostSummary, costsPath } = await import('../src/costTracking.js');
    await fs.mkdir(path.join(dir, '.code-conductor'), { recursive: true });

    const rows = [
      { ts: Date.now(), project: 'alpha', model: 'opus', sessionId: 's1', cost_usd: 0.05, duration_ms: 6000, duration_api_ms: 2000 },
      { ts: Date.now(), project: 'alpha', model: 'opus', sessionId: 's1', cost_usd: 0.03, duration_ms: 4000, duration_api_ms: 1500 },
      // Legacy row — no duration fields at all.
      { ts: Date.now(), project: 'alpha', model: 'opus', sessionId: 's1', cost_usd: 0.01 },
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const summary = await getCostSummary();
    const alpha = summary.by_project.find(p => p.project === 'alpha');
    assert.equal(alpha.duration_ms, 10000, 'walltime sums; legacy row contributes 0');
    assert.equal(alpha.duration_api_ms, 3500, 'LLM time sums; legacy row contributes 0');
    assert.equal(alpha.by_model[0].duration_ms, 10000);
    assert.equal(alpha.by_model[0].duration_api_ms, 3500);

    const opus = summary.by_model.find(m => m.model === 'opus');
    assert.equal(opus.duration_ms, 10000);
    assert.equal(opus.duration_api_ms, 3500);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 8. Per-session stats + worker-tree rollup ────────────────────────────────

test('cost-tracking: getSessionStats rolls up the worker tree', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getSessionStats, costsPath } = await import('../src/costTracking.js');
    await fs.mkdir(path.join(dir, '.code-conductor'), { recursive: true });

    // Tree: conductor → w1, w2; w1 → w1a (grandchild). A legacy row (no
    // timing/parent) belongs to the conductor and must still count.
    const rows = [
      { ts: Date.now(), sessionId: 'cond', parentSessionId: null, cost_usd: 0.10, duration_ms: 5000, duration_api_ms: 2000 },
      { ts: Date.now(), sessionId: 'cond', cost_usd: 0.01 }, // legacy conductor row
      { ts: Date.now(), sessionId: 'w1', parentSessionId: 'cond', cost_usd: 0.20, duration_ms: 8000, duration_api_ms: 3000 },
      { ts: Date.now(), sessionId: 'w2', parentSessionId: 'cond', cost_usd: 0.30, duration_ms: 9000, duration_api_ms: 4000 },
      { ts: Date.now(), sessionId: 'w1a', parentSessionId: 'w1', cost_usd: 0.05, duration_ms: 1000, duration_api_ms: 500 },
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const stats = await getSessionStats('cond');
    // own = conductor's two rows only.
    assert.ok(Math.abs(stats.own.cost_usd - 0.11) < 1e-9, `own cost 0.11, got ${stats.own.cost_usd}`);
    assert.equal(stats.own.duration_ms, 5000, 'own walltime excludes legacy-null row');
    assert.equal(stats.own.duration_api_ms, 2000);
    assert.equal(stats.own.turns, 2);
    // rolled = conductor + w1 + w2 + w1a (recursive).
    assert.ok(Math.abs(stats.rolled.cost_usd - 0.66) < 1e-9, `rolled cost 0.66, got ${stats.rolled.cost_usd}`);
    assert.equal(stats.rolled.duration_ms, 23000);
    assert.equal(stats.rolled.duration_api_ms, 9500);
    assert.equal(stats.rolled.turns, 5);
    assert.equal(stats.workerSessions, 3, 'w1, w2, w1a folded into the rollup');

    // A leaf session with no children: own == rolled, no workers.
    const leaf = await getSessionStats('w2');
    assert.ok(Math.abs(leaf.rolled.cost_usd - 0.30) < 1e-9);
    assert.equal(leaf.workerSessions, 0);

    // Unknown session: zeros, no throw.
    const none = await getSessionStats('nope');
    assert.equal(none.own.cost_usd, 0);
    assert.equal(none.rolled.cost_usd, 0);
    assert.equal(none.workerSessions, 0);
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

test('cost-tracking: getSessionStats terminates on a parent cycle', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getSessionStats, costsPath } = await import('../src/costTracking.js');
    await fs.mkdir(path.join(dir, '.code-conductor'), { recursive: true });

    // a → b and b → a: a mutual cycle. Also a self-parent row.
    const rows = [
      { ts: Date.now(), sessionId: 'a', parentSessionId: 'b', cost_usd: 0.10, duration_ms: 1000, duration_api_ms: 500 },
      { ts: Date.now(), sessionId: 'b', parentSessionId: 'a', cost_usd: 0.20, duration_ms: 2000, duration_api_ms: 900 },
      { ts: Date.now(), sessionId: 'a', parentSessionId: 'a', cost_usd: 0.05 }, // self-parent ignored
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const stats = await getSessionStats('a');
    // Walk from a visits {a, b} once each — no infinite loop.
    assert.ok(Math.abs(stats.rolled.cost_usd - 0.35) < 1e-9, `rolled cost 0.35, got ${stats.rolled.cost_usd}`);
    assert.equal(stats.rolled.duration_ms, 3000);
    assert.equal(stats.workerSessions, 1, 'only b is a distinct descendant');
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 9. Session-stats route smoke ─────────────────────────────────────────────

test('GET /api/costs/session/:sessionId returns own + rolled stats', async () => {
  const { baseUrl, close, tmpHome } = await bootServer();
  try {
    const { costsPath } = await import('../src/costTracking.js');
    const storeDir = path.join(tmpHome, 'project', '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });

    const rows = [
      { ts: Date.now(), sessionId: 'c1', parentSessionId: null, cost_usd: 0.10, duration_ms: 4000, duration_api_ms: 1500 },
      { ts: Date.now(), sessionId: 'w1', parentSessionId: 'c1', cost_usd: 0.20, duration_ms: 6000, duration_api_ms: 2500 },
    ];
    await fs.writeFile(path.join(storeDir, 'costs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const { status, body } = await api(baseUrl, 'GET', '/api/costs/session/c1');
    assert.equal(status, 200);
    assert.equal(body.sessionId, 'c1');
    assert.ok(Math.abs(body.own.cost_usd - 0.10) < 1e-9);
    assert.ok(Math.abs(body.rolled.cost_usd - 0.30) < 1e-9);
    assert.equal(body.rolled.duration_ms, 10000);
    assert.equal(body.rolled.duration_api_ms, 4000);
    assert.equal(body.workerSessions, 1);
  } finally {
    await close();
  }
});

test('GET /api/costs/summary returns aggregated data when rows exist', async () => {
  const { baseUrl, close, tmpHome } = await bootServer();
  try {
    const { costsPath } = await import('../src/costTracking.js');
    const storeDir = path.join(tmpHome, 'project', '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });

    const row = { ts: Date.now(), project: 'foo', model: 'claude-haiku-4-5', sessionId: 's1',
      input_tokens: 50, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.001 };
    await fs.writeFile(
      path.join(storeDir, 'costs.jsonl'),
      JSON.stringify(row) + '\n',
    );

    const { status, body } = await api(baseUrl, 'GET', '/api/costs/summary');
    assert.equal(status, 200);
    assert.equal(body.row_count, 1);
    assert.ok(Math.abs(body.total_usd - 0.001) < 1e-9);
    assert.equal(body.by_project.length, 1);
    assert.equal(body.by_project[0].project, 'foo');
    assert.ok(Array.isArray(body.by_project[0].by_model), 'by_project[0].by_model should be array');
    assert.equal(body.by_project[0].by_model.length, 1);
    assert.equal(body.by_project[0].by_model[0].model, 'claude-haiku-4-5');
    assert.equal(body.by_model.length, 1);
    assert.equal(body.by_model[0].model, 'claude-haiku-4-5');
    assert.equal(body.daily_trend.length, 1);
  } finally {
    await close();
  }
});
