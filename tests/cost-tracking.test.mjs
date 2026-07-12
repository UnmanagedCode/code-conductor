// Integration tests for the cost-tracking feature.
//
// Tests:
//  1. Row append — a synthetic turn_end via initCostTracking writes a valid JSONL row.
//  2. Summary aggregation — by_project, by_model, daily_trend, total_usd.
//  3. Missing file — getCostSummary() returns zeros/empty without throwing.
//  4. Cache-flush detection — first-turn exclusion, spike detection, normal
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
function fakeInst({ project = 'proj-a', model = 'claude-opus-4-8', sessionId = 'sess-1' } = {}) {
  return { project, model, sessionId };
}

// Build a synthetic turn_end event. The cacheFlush / firstReq* fields mirror
// the decisive verdict instances.js enriches onto turn_end before it's
// persisted (see appendCostRow).
function turnEndEv({ costDelta = 0.01, usage, cacheFlush, firstReqCacheRead, firstReqCacheCreation } = {}) {
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
    cacheFlush,
    firstReqCacheRead,
    firstReqCacheCreation,
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

    // Emit a turn_end event carrying a decisive cache-flush verdict.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({
      costDelta: 0.0123, cacheFlush: true, firstReqCacheRead: 300, firstReqCacheCreation: 180000,
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
    // Decisive cache-flush fields persist from the enriched event.
    assert.equal(row.cache_flush, true);
    assert.equal(row.first_req_cache_read, 300);
    assert.equal(row.first_req_cache_creation, 180000);
    // The plain turn_end defaults to no-flush / zeroed evidence.
    const row2 = JSON.parse(lines[1]);
    assert.equal(row2.cache_flush, false);
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
      { ts: new Date('2026-06-01').getTime(), project: 'alpha', model: 'claude-opus-4-8',   sessionId: 's1', input_tokens: 100, output_tokens: 50, cache_creation_tokens: 10, cache_read_tokens: 200, cost_usd: 0.05 },
      { ts: new Date('2026-06-01').getTime(), project: 'alpha', model: 'claude-opus-4-8',   sessionId: 's1', input_tokens: 80,  output_tokens: 40, cache_creation_tokens:  5, cache_read_tokens: 100, cost_usd: 0.03 },
      { ts: new Date('2026-06-02').getTime(), project: 'beta',  model: 'claude-sonnet-4-6', sessionId: 's2', input_tokens: 200, output_tokens: 80, cache_creation_tokens: 20, cache_read_tokens: 300, cost_usd: 0.02 },
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
    assert.equal(summary.by_project[1].project, 'beta');

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

    const betaModels = summary.by_project[1].by_model;
    assert.ok(Array.isArray(betaModels), 'beta.by_model should be an array');
    assert.equal(betaModels.length, 1, 'beta has 1 model');
    assert.equal(betaModels[0].model, 'claude-sonnet-4-6');

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

    // daily_trend — sorted chronologically
    assert.equal(summary.daily_trend.length, 2);
    assert.equal(summary.daily_trend[0].date, '2026-06-01');
    assert.ok(Math.abs(summary.daily_trend[0].cost_usd - 0.08) < 1e-9);
    assert.equal(summary.daily_trend[1].date, '2026-06-02');
    assert.ok(Math.abs(summary.daily_trend[1].cost_usd - 0.02) < 1e-9);

    // cache_flushes — s1 has 1 non-first turn (5 tokens, well under any threshold),
    // s2 is a single-row session (cold start only, contributes nothing)
    assert.equal(summary.cache_flushes.count, 0);
    assert.equal(summary.cache_flushes.sessions_affected, 0);
    assert.equal(summary.cache_flushes.non_first_turns, 1);
    assert.equal(summary.cache_flushes.rate, 0);
    assert.equal(summary.cache_flushes.flush_cache_creation_tokens, 0);
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
    assert.deepEqual(summary.cache_flushes, {
      count: 0, sessions_affected: 0, non_first_turns: 0, rate: 0, flush_cache_creation_tokens: 0,
    });
  } finally {
    process.env.PROJECTS_ROOT = prevRoot ?? '';
    if (!prevRoot) delete process.env.PROJECTS_ROOT;
    await rmrf(dir);
  }
});

// ── 4. Cache-flush summary counts persisted flags ─────────────────────────────

test('cost-tracking: cache_flushes summary counts persisted cache_flush flags', async () => {
  const dir = await makeTmpDir();
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = dir;

  try {
    const { getCostSummary, costsPath } = await import('../src/costTracking.js');

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true });

    // ts spacing (seconds) fixes per-session ordering unambiguously.
    const T = (s) => new Date('2026-06-01T00:00:00Z').getTime() + s * 1000;
    const filler = { project: 'p', model: 'm', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };

    // The summary is a pure count over the persisted `cache_flush` flag — the
    // heuristic no longer runs at read time (it lives in migration 0014). Rows
    // carry explicit flags; the summarizer must not re-derive them.
    const rows = [
      // s1 — 3 turns; the third is a flush. First row is a big non-flush.
      { ts: T(0), sessionId: 's1', cache_flush: false, cache_creation_tokens: 200000, ...filler },
      { ts: T(1), sessionId: 's1', cache_flush: false, cache_creation_tokens: 5000,   ...filler },
      { ts: T(2), sessionId: 's1', cache_flush: true,  cache_creation_tokens: 180000, ...filler },

      // s2 — single row (cold start only): non-first count 0, not flagged.
      { ts: T(3), sessionId: 's2', cache_flush: false, cache_creation_tokens: 3000,   ...filler },

      // s3 — 4 turns; one flush.
      { ts: T(4), sessionId: 's3', cache_flush: false, cache_creation_tokens: 3000,   ...filler },
      { ts: T(5), sessionId: 's3', cache_flush: false, cache_creation_tokens: 20000,  ...filler },
      { ts: T(6), sessionId: 's3', cache_flush: true,  cache_creation_tokens: 250000, ...filler },
      { ts: T(7), sessionId: 's3', cache_flush: false, cache_creation_tokens: 22000,  ...filler },

      // Null sessionId — excluded from non_first_turns and sessions_affected.
      { ts: T(8), sessionId: null, cache_flush: false, cache_creation_tokens: 999999, ...filler },
    ];
    await fs.writeFile(costsPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const summary = await getCostSummary();
    const cf = summary.cache_flushes;

    assert.equal(cf.count, 2, 'two rows carry cache_flush:true');
    assert.equal(cf.sessions_affected, 2, 's1 and s3');
    // non-first turns via plain group-count: s1=2, s2=0, s3=3 (null row excluded).
    assert.equal(cf.non_first_turns, 5);
    assert.ok(Math.abs(cf.rate - 2 / 5) < 1e-9);
    assert.equal(cf.flush_cache_creation_tokens, 180000 + 250000);
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
