// GET /api/instances/:id/events — paged history with jsonl-replay fallback
// for events evicted from the capped ring. Covers ring-only pages, the
// archive boundary (no-overlap/no-gap at prompt granularity), the
// giant-turn degenerate case (gap, never duplication), cursor termination,
// forward (`after`) mode, limit clamping, and error statuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

async function seedSession({ ctx, projectName, sid, lines }) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const projectPath = path.join(ctx.projectsRoot, projectName);
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `${sid}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
  return { projectPath, sessionDir };
}

function turnLines(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `prompt ${i}` } });
    lines.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [
      { type: 'text', text: `reply ${i}` },
    ] } });
  }
  return lines;
}

async function bootResumed({ ctx, projectName, sid, lines }) {
  await seedSession({ ctx, projectName, sid, lines });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
    project: projectName, mode: 'bypassPermissions', resume: sid,
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  return id;
}

// Page backward from the tail until hasMore goes false; returns all events
// oldest-first. Bounded so a cursor bug fails the test instead of hanging.
async function pageAll(ctx, id, { limit = 10 } = {}) {
  let all = [];
  let before; // first request: no params except limit → trailing page
  for (let i = 0; i < 100; i++) {
    const q = before == null ? `?limit=${limit}` : `?before=${before}&limit=${limit}`;
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events${q}`);
    assert.equal(r.status, 200);
    all = r.body.events.concat(all);
    if (!r.body.hasMore) return { all, last: r.body };
    assert.ok(r.body.events.length > 0 || !r.body.hasMore, 'no empty page with hasMore');
    before = r.body.nextBefore;
  }
  throw new Error('pageAll: cursor never terminated');
}

test('untrimmed ring: backward pages reproduce the full ring, cursor terminates', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaaa-2222-3333-4444-555555555555';
    const id = await bootResumed({ ctx, projectName: 'pageable', sid, lines: turnLines(4) });

    const ring = ctx.instances.get(id).ringSnapshot();
    const { all, last } = await pageAll(ctx, id, { limit: 5 });
    assert.equal(last.trimmedBefore, 0);
    assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq), 'pages cover the ring exactly');
    // Oldest-first within and across pages.
    for (let i = 1; i < all.length; i++) assert.ok(all[i]._seq > all[i - 1]._seq);
  } finally { await ctx.close(); }
});

test('trimmed ring: archive fallback yields no overlap and no gap at prompt granularity', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'bbbbbbbb-2222-3333-4444-555555555555';
    const id = await bootResumed({ ctx, projectName: 'archived', sid, lines: turnLines(12) });

    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    const { all } = await pageAll(ctx, id, { limit: 7 });

    // Every prompt appears exactly once, in order — across the boundary.
    const echoes = all.filter(e => e.kind === 'user_echo').map(e => e.text);
    assert.deepEqual(echoes, Array.from({ length: 12 }, (_, i) => `prompt ${i}`));
    // Every reply appears exactly once (no duplicated assistant content).
    const texts = all.filter(e => e.kind === 'text_delta').map(e => e.text);
    for (let i = 0; i < 12; i++) {
      assert.equal(texts.filter(t => t === `reply ${i}`).length, 1, `reply ${i} served exactly once`);
    }
    // Archive echoes carry the absolute userIndex too.
    for (const e of all.filter(e => e.kind === 'user_echo')) {
      assert.ok(Number.isInteger(e.userIndex));
    }
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('giant single turn: paging produces a gap, never duplication', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'cccccccc-2222-3333-4444-555555555555';
    // One prompt, then a single assistant message with 40 text blocks —
    // replays to ~80 events, far over the cap, with no snappable echo.
    const blocks = Array.from({ length: 40 }, (_, i) => ({ type: 'text', text: `block ${i}` }));
    const id = await bootResumed({
      ctx, projectName: 'giant', sid,
      lines: [
        { type: 'user', uuid: 'u0', message: { role: 'user', content: 'prompt 0' } },
        { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: blocks } },
      ],
    });

    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');
    assert.ok(!inst.ringSnapshot().some(e => e.kind === 'user_echo'), 'echo evicted (mid-turn head)');

    const { all } = await pageAll(ctx, id, { limit: 7 });
    // The prompt bubble is recovered from the archive, exactly once.
    assert.deepEqual(all.filter(e => e.kind === 'user_echo').map(e => e.text), ['prompt 0']);
    // No block text duplicated; some blocks ARE missing (the gap).
    const texts = all.filter(e => e.kind === 'text_delta').map(e => e.text);
    assert.equal(new Set(texts).size, texts.length, 'no duplicated assistant blocks');
    assert.ok(texts.length < 40, 'gap exists (partial turn was evicted, not reconstructed)');
    // The retained tail is intact through to the newest event.
    assert.ok(texts.includes('block 39'));
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('trimmed ring without a jsonl (nothing to replay): cursor terminates cleanly', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-instance.json') });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'nojsonl' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'nojsonl', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);

    // Trim the ring with synthetic events (fake-claude writes no jsonl, so
    // the archive will come back empty).
    const inst = ctx.instances.get(id);
    for (let i = 0; i < 60; i++) inst._emitUi({ kind: 'text_delta', msgId: 'mX', blockIdx: 0, text: `e${i}` });
    assert.ok(inst.ring.trimmedBefore > 0);

    const { all, last } = await pageAll(ctx, id, { limit: 9 });
    assert.equal(last.hasMore, false);
    // Only the retained ring could be served.
    assert.equal(all[0]._seq, inst.ring.trimmedBefore);
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('after= pages forward, mirroring sinceSeq semantics', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'dddddddd-2222-3333-4444-555555555555';
    const id = await bootResumed({ ctx, projectName: 'forward', sid, lines: turnLines(4) });
    const ring = ctx.instances.get(id).ringSnapshot();

    const r1 = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?after=-1&limit=3`);
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.events.map(e => e._seq), ring.slice(0, 3).map(e => e._seq));
    assert.equal(r1.body.hasMore, true);

    const lastSeq = ring[ring.length - 1]._seq;
    const r2 = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?after=${lastSeq}&limit=3`);
    assert.deepEqual(r2.body.events, []);
    assert.equal(r2.body.hasMore, false);
  } finally { await ctx.close(); }
});

test('limit is clamped; bad params 400; unknown instance 404', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'eeeeeeee-2222-3333-4444-555555555555';
    const id = await bootResumed({ ctx, projectName: 'clampy', sid, lines: turnLines(2) });

    // limit far above the max is clamped server-side, not an error.
    const big = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?limit=99999`);
    assert.equal(big.status, 200);
    assert.ok(big.body.events.length <= 500);

    const bad = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?before=xyz`);
    assert.equal(bad.status, 400);

    const missing = await api(ctx.baseUrl, 'GET', `/api/instances/nope/events`);
    assert.equal(missing.status, 404);
  } finally { await ctx.close(); }
});
