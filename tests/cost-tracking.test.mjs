// Integration tests for the cost-tracking feature.
//
// Tests:
//  1. Row append — a synthetic turn_end via initCostTracking writes a valid JSONL row.
//  2. Summary aggregation — by_project, by_model, daily_trend, total_usd.
//  3. Missing file — getCostSummary() returns zeros/empty without throwing.
//  4. Route smoke — GET /api/costs/summary returns 200 with the right shape.

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

// Build a synthetic turn_end event.
function turnEndEv({ costDelta = 0.01, usage } = {}) {
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

    // Emit a turn_end event.
    emitter.emit('event', { id: 'inst-1', ev: turnEndEv({ costDelta: 0.0123 }) });

    // Wait briefly for the async appendFile to complete.
    await new Promise(r => setTimeout(r, 50));

    const storeDir = path.join(dir, '.code-conductor');
    await fs.mkdir(storeDir, { recursive: true }); // ensure readable even if absent
    const raw = await fs.readFile(costsPath(), 'utf8').catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one JSONL row written');
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

// ── 4. Route smoke ────────────────────────────────────────────────────────────

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
