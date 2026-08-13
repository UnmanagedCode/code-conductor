// GET /api/instances/:id/events — paged history with jsonl-replay fallback
// for events evicted from the capped ring. Covers ring-only pages, the
// archive boundary (no-overlap/no-gap at prompt granularity), the
// giant-turn degenerate case (gap, never duplication), cursor termination,
// forward (`after`) mode, limit clamping, and error statuses.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { buildArchive, pageInstanceEvents } from '../src/eventArchive.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_SUBAGENT_DEPTH2 = path.join(__dirname, 'fixtures', 'scenario-subagent-depth2.json');

// One server shared across the file. Each test gets a fresh PROJECTS_ROOT;
// rather than re-thread it through every helper, we mutate ctx.projectsRoot /
// ctx.claudeProjectsRoot in beforeEach so existing `ctx.*` references resolve to
// the per-test roots (ctx.baseUrl / ctx.instances stay stable). Spawned
// instances are cleared between tests. See helpers → freshProjectsRoot.
let ctx, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

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
  {
    const sid = 'aaaaaaaa-2222-3333-4444-555555555555';
    const id = await bootResumed({ ctx, projectName: 'pageable', sid, lines: turnLines(4) });

    const ring = ctx.instances.get(id).ringSnapshot();
    const { all, last } = await pageAll(ctx, id, { limit: 5 });
    assert.equal(last.trimmedBefore, 0);
    assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq), 'pages cover the ring exactly');
    // Oldest-first within and across pages.
    for (let i = 1; i < all.length; i++) assert.ok(all[i]._seq > all[i - 1]._seq);
  }
});

test('trimmed ring: archive fallback yields no overlap and no gap at prompt granularity', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
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
    // T4 (pins R3/R5): the paged history's very first event is _seq 0 and is
    // the opening prompt's user_echo — makes the _seq 0 boundary explicit
    // rather than implied by the "all 12 prompts" check above.
    assert.equal(all[0]._seq, 0, 'first served event is _seq 0');
    assert.equal(all[0].kind, 'user_echo', '_seq 0 is a user_echo');
    assert.equal(all[0].text, 'prompt 0', '_seq 0 is the opening prompt');
  } finally {    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// T20 — Phase B (2026-0146): a giant single turn is now FULLY reconstructed,
// not collapsed to a gap. Same fixture the pre-Phase-B echo-ordinal anchor
// used to fail on (ORCH_EVENT_RING_CAP=10, 1 prompt + 40 text blocks, no
// snappable echo in the trimmed ring) — the content correlator stitches the
// archive to the ring head's own (msgId, blockIdx) exactly, so nothing
// between them is lost. Renamed: the old name asserted the defect.
test('giant single turn: paging fully reconstructs the turn, no gap', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
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
    // All 40 blocks served, each exactly once — the correlated cut means
    // nothing between the archive and the ring head is dropped.
    const texts = all.filter(e => e.kind === 'text_delta').map(e => e.text);
    assert.equal(new Set(texts).size, texts.length, 'no duplicated assistant blocks');
    assert.equal(texts.length, 40, 'every block reconstructed — no gap');
    assert.ok(texts.includes('block 0') && texts.includes('block 39'));
    // No eviction was left unreconstructed, so no marker at all.
    assert.equal(all.filter(e => e.kind === 'history_gap').length, 0,
      'a correlated cut means no history_gap — the turn is whole');
    // Every served text_delta has its text_end (whole blocks throughout).
    for (const d of all.filter(e => e.kind === 'text_delta')) {
      assert.ok(all.some(e => e.kind === 'text_end'
        && e.msgId === d.msgId && e.blockIdx === d.blockIdx),
        `block ${d.text} served whole`);
    }
  } finally {    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('trimmed ring without a jsonl (nothing to replay): cursor terminates cleanly', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  // This case needs the scenario-instance fixture (fake-claude writes no jsonl);
  // the shared server booted with scenario-resume, so swap the env for this
  // spawn — the subprocess reads FAKE_CLAUDE_SCENARIO live at spawn time.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'nojsonl' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'nojsonl', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);

    // Trim the ring with synthetic events (fake-claude writes no jsonl, so
    // the archive will come back empty). A DISTINCT blockIdx per delta: the ring
    // folds consecutive same-(msgId, blockIdx) deltas into one slot, so a shared
    // blockIdx would occupy 1 slot and never trim at all. No text_end — every
    // block stays open, so the ring head stays mid-turn exactly as before and
    // the gap marker this test is about is still produced.
    const inst = ctx.instances.get(id);
    for (let i = 0; i < 60; i++) inst._emitUi({ kind: 'text_delta', msgId: 'mX', blockIdx: i, text: `e${i}` });
    assert.ok(inst.ring.trimmedBefore > 0);

    const { all, last } = await pageAll(ctx, id, { limit: 9 });
    assert.equal(last.hasMore, false);
    // T2 (Step 3): the jsonl-missing branch of buildArchive must mark the
    // seam with a history_gap rather than silently dropping the evicted
    // span — exactly one marker, no _seq, sitting immediately before the
    // first ring-side event.
    const gaps = all.filter(e => e.kind === 'history_gap');
    assert.equal(gaps.length, 1, 'exactly one gap marker served');
    assert.equal(gaps[0]._seq, undefined, 'marker carries no _seq');
    const gi = all.findIndex(e => e.kind === 'history_gap');
    assert.equal(all[gi + 1]._seq, inst.ring.trimmedBefore,
      'marker sits right before the first ring-side event');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('after= pages forward, exclusive (REST-only convention, unrelated to get_transcript\'s fromSeq)', async () => {
  {
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
  }
});

// Returns each backward page as its own array (not flattened).
async function pageAllPages(ctx, id, { limit = 10 } = {}) {
  const pages = [];
  let before;
  for (let i = 0; i < 200; i++) {
    const q = before == null ? `?limit=${limit}` : `?before=${before}&limit=${limit}`;
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events${q}`);
    assert.equal(r.status, 200);
    if (r.body.events.length > 0) pages.push(r.body.events);
    if (!r.body.hasMore) return pages;
    before = r.body.nextBefore;
  }
  throw new Error('pageAllPages: cursor never terminated');
}

// Assert that every child event (parentToolUseId != null) in the array is
// PRECEDED by its owning tool-call head (a tool_use_start or tool_use event
// with the same toolUseId). Order-aware: the renderer nests a child under an
// already-built head, so a child ahead of its head is as broken as a missing
// one.
// `headlessIds` is an opt-in allowance (same purpose as
// quiescent-paging.test.mjs's assertPageIntegrity) for ids a fixture
// deliberately builds with no head anywhere — after A3 such a child can
// legitimately ride along on a served page instead of being dropped with its
// whole component. Use ONLY where the fixture builds a headless group on
// purpose.
function assertGroupIntegrity(events, label = '', { headlessIds = new Set() } = {}) {
  const headIds = new Set();
  for (const ev of events) {
    // Registered BEFORE this event's own child check, and for child events
    // too — a sub-agent tool head is ITSELF a child of its outer group, so
    // skipping heads that carry a parentToolUseId would make a nested head
    // unable to satisfy its own children. This deliberately WEAKENS the check
    // (more ids in `headIds` at each assertion): it tolerates "child of B
    // where B's head is itself a child of A". That shape is legitimate, and
    // it is not a hole — if A's head were missing, the assertion still fires
    // on B's own line. Do not "fix" this back to registering only outer heads.
    if (ev.toolUseId && (ev.kind === 'tool_use_start' || ev.kind === 'tool_use')) {
      headIds.add(ev.toolUseId);
    }
    if (ev.parentToolUseId) {
      if (headlessIds.has(ev.parentToolUseId)) continue;
      assert.ok(headIds.has(ev.parentToolUseId),
        `${label}orphaned child: parentToolUseId=${ev.parentToolUseId} has no ` +
        `matching head at or before it; seqs=[${events.map(e => e._seq).join(',')}]`);
    }
  }
}

test('group integrity: backward paging never splits a sub-agent tool-call group across page boundaries', async () => {
  {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'grouppage' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'grouppage', mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const inst = ctx.instances.get(id);

    // Inject one outer turn: a Task tool call with 20 sub-agent child events.
    // 20 children >> the page limit of 5, so a fixed boundary falls inside the
    // group and at least one page would contain orphaned children without the fix.
    inst._emitUi({ kind: 'user_echo', text: 'run task' });
    inst._emitUi({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_task', name: 'Task' });
    inst._emitUi({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_task', name: 'Task', input: {} });
    // Distinct blockIdx per child: the ring coalesces consecutive same-block
    // deltas, so a shared blockIdx would collapse all 20 into ONE slot and the
    // "20 children >> the page limit of 5" premise above would silently vanish.
    // Sub-agent events are invisible to the quiescence scan and the group
    // resolver keys on parentToolUseId, so nothing else about this setup moves.
    for (let i = 0; i < 20; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'msub', blockIdx: i, text: `sub ${i}`, parentToolUseId: 'tu_task' });
    }
    inst._emitUi({ kind: 'tool_result', toolUseId: 'tu_task', content: 'done', isError: false });

    const pages = await pageAllPages(ctx, id, { limit: 5 });
    assert.ok(pages.length > 0, 'at least one page returned');
    for (let p = 0; p < pages.length; p++) {
      assertGroupIntegrity(pages[p], `page[${p}] `);
    }
  }
});

test('group integrity: snapshotTail never includes orphaned sub-agent children', async () => {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'groupsnap' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'groupsnap', mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const inst = ctx.instances.get(id);

    // Inject a Task group with 20 children. The snapshot tail is 8 events,
    // so the tail window starts deep inside the group without the head.
    inst._emitUi({ kind: 'user_echo', text: 'run task' });
    inst._emitUi({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_snap', name: 'Task' });
    inst._emitUi({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_snap', name: 'Task', input: {} });
    // Distinct blockIdx per child — see the paging test above; a shared one
    // would fold the group to a single slot and the tail of 8 would no longer
    // start deep inside it.
    for (let i = 0; i < 20; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'msub', blockIdx: i, text: `sub ${i}`, parentToolUseId: 'tu_snap' });
    }
    inst._emitUi({ kind: 'tool_result', toolUseId: 'tu_snap', content: 'done', isError: false });

    // Call snapshotTail directly — it reads ORCH_SNAPSHOT_TAIL from env.
    const snap = inst.snapshotTail();
    assert.ok(snap.length > 0, 'snapshot is non-empty');
    assertGroupIntegrity(snap, 'snapshot ');
  } finally {    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
  }
});

// Page backward capturing each RESPONSE (not just its events), so cursor
// mechanics can be asserted alongside page contents. Each body is tagged with
// the `before` that produced it (`_requestedBefore`, null on the first,
// param-less request) — an empty page's [nextBefore, before) interval is the
// only externally visible statement of which window the resolver rejected.
async function pageResponses(ctx, id, { limit = 10 } = {}) {
  const responses = [];
  let before;
  for (let i = 0; i < 100; i++) {
    const q = before == null ? `?limit=${limit}` : `?before=${before}&limit=${limit}`;
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events${q}`);
    assert.equal(r.status, 200);
    responses.push({ ...r.body, _requestedBefore: before ?? null });
    if (!r.body.hasMore) return responses;
    before = r.body.nextBefore;
  }
  throw new Error('pageResponses: cursor never terminated');
}

test('archive/ring seam: overlapping groups page whole, cursor progresses, no orphans', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '12';
  try {
    const sid = 'ffffffff-1111-2222-3333-444444444444';
    const agentToolUseId = 'toolu_seam_agent';
    // The Agent head lives ONLY in the jsonl. Trailing turns push it out of
    // the ring, so on resume it is reconstructed archive-side while the
    // children emitted below stay ring-side — the head/children split that
    // makes group ownership have to cross the seam.
    const plainTurn = (tag) => ([
      { type: 'user', uuid: `u_${tag}`, message: { role: 'user', content: `prompt ${tag}` } },
      { type: 'assistant', uuid: `a_${tag}`, message: { id: `m_${tag}`, role: 'assistant', content: [
        { type: 'text', text: `reply ${tag}` },
      ] } },
    ]);
    const lines = [
      ...plainTurn('p0'), ...plainTurn('p1'),
      { type: 'user', uuid: 'u_agent', message: { role: 'user', content: 'run the agent' } },
      { type: 'assistant', uuid: 'a_agent', message: { id: 'm_agent', role: 'assistant', content: [
        { type: 'tool_use', id: agentToolUseId, name: 'Agent', input: { description: 'bg' } },
      ] } },
      { type: 'user', uuid: 'u_agent_res', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: agentToolUseId, content: 'started', is_error: false },
      ] } },
      ...plainTurn('p2'), ...plainTurn('p3'), ...plainTurn('p4'),
      ...plainTurn('p5'), ...plainTurn('p6'), ...plainTurn('p7'),
    ];
    const id = await bootResumed({ ctx, projectName: 'seamgroup', sid, lines });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring trimmed');
    assert.ok(!inst.ring.buf.some(e => e.toolUseId === agentToolUseId),
      'the Agent head really is archive-side, not still in the ring');

    // Ring turn 1: a group whose head is nowhere at all (never emitted).
    inst._emitUi({ kind: 'user_echo', text: 'headless turn' });
    for (let i = 0; i < 3; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'msG', blockIdx: i, text: `g${i}`, parentToolUseId: 'GONE' });
    }
    inst._emitUi({ kind: 'turn_end', subtype: 'success' });
    // Ring turn 2: late children of the ARCHIVE-side Agent head.
    inst._emitUi({ kind: 'user_echo', text: 'seam turn' });
    inst._emitUi({ kind: 'text_delta', msgId: 'mz', blockIdx: 0, text: 'outer' });
    // Distinct blockIdx in both ring turns above: a folded 3-child group would
    // stop exercising the multi-event headless/seam windows these limits probe.
    for (let i = 0; i < 3; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'msq', blockIdx: i, text: `q${i}`,
        parentToolUseId: agentToolUseId });
    }
    inst._emitUi({ kind: 'text_end', msgId: 'mz', blockIdx: 0 });
    inst._emitUi({ kind: 'turn_end', subtype: 'success' });

    // The whole seq space this fixture can serve, derived the same way
    // pageInstanceEvents derives it. Note it is NOT a contiguous range: the
    // archive is cut below `trimmedBefore`, so at least one seq exists in
    // neither array and a range-based expectation would be wrong.
    const arch = await buildArchive({
      cwd: inst.cwd, sessionId: inst.backingSessionId, ring: inst.ringSnapshot(),
      trimmedBefore: inst.ring.trimmedBefore, userEchoCount: inst._userEchoCount,
    });
    const universe = arch.events.slice(0, arch.cut).concat(inst.ringSnapshot());
    const universeSeqs = new Set(universe.map(e => e._seq));

    for (const limit of [3, 5, 7]) {
      const responses = await pageResponses(ctx, id, { limit });
      assert.ok(responses.length > 0, `limit=${limit}: at least one response`);

      let prevBefore = Infinity;
      for (let p = 0; p < responses.length; p++) {
        const body = responses[p];
        // GONE is deliberately headless (the fixture's whole point). Its
        // component starts at index 0 (every headless component does) and
        // merges by adjacency with the Agent component, carrying the
        // `headless` flag onto the merge — so the Agent's own children can
        // also ride along on a page that doesn't carry the Agent head (the
        // head is archive-side and reachable elsewhere in the walk, pinned
        // below). Pre-A3 this whole merged window was simply an empty page;
        // post-A3 it is served, and an unresolved child parks client-side
        // (Conversation.orphanChildEvents) until a later page brings its head
        // — see A3's note in src/eventArchive.ts. Both ids are the allowance.
        assertGroupIntegrity(body.events, `limit=${limit} page[${p}] `,
          { headlessIds: new Set(['GONE', agentToolUseId]) });
        assert.ok(!(body.hasMore && body.events.length === 0),
          `limit=${limit} page[${p}]: no page may be empty while hasMore is true`);
        if (body.hasMore) {
          assert.ok(body.nextBefore < prevBefore,
            `limit=${limit} page[${p}]: nextBefore must strictly progress ` +
            `(${body.nextBefore} !< ${prevBefore})`);
          prevBefore = body.nextBefore;
        }
      }

      const all = responses.flatMap(b => b.events);
      const served = all.filter(e => e._seq != null).map(e => e._seq).sort((a, b) => a - b);

      // The empty-page / rejected-window partition this test used to assert
      // is gone: A3's backstop means no window is ever rejected outright, so
      // the invariant collapses to the strictly stronger statement it was
      // always standing in for — every seq in the universe is served exactly
      // once, GONE's children included (they ride along and park client-side
      // rather than vanishing into an empty page).
      assert.deepEqual(served, [...universeSeqs].sort((a, b) => a - b),
        `limit=${limit}: served seqs equal the universe exactly — no empties, no rejections, no duplicates`);

      assert.ok(all.some(e => e.toolUseId === agentToolUseId && e.kind === 'tool_use'),
        `limit=${limit}: the archive-side Agent head is reachable`);
    }
  } finally {
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// 2026-0037: the ring window that holds a sub-agent child whose `tool_use` head
// was evicted is the ONLY window that will ever cover that child, so if it
// resolves without the archive the child is served by no page at all. Driven
// through pageInstanceEvents with a stub instance (same shape as the T3 tests
// below) plus a real jsonl, so ring seqs and trimmedBefore are exact.
test('archive-side Agent head reunites with its ring-side children on one page', async () => {
  const sid = 'a9a9a9a9-1111-2222-3333-444444444444';
  const TU = 'toolu_arch_agent';
  const plainTurn = (tag) => ([
    { type: 'user', uuid: `u_${tag}`, message: { role: 'user', content: `prompt ${tag}` } },
    { type: 'assistant', uuid: `a_${tag}`, message: { id: `m_${tag}`, role: 'assistant', content: [
      { type: 'text', text: `reply ${tag}` },
    ] } },
  ]);
  const { projectPath } = await seedSession({ ctx, projectName: 'archhead', sid, lines: [
    ...plainTurn('p0'), ...plainTurn('p1'),
    { type: 'user', uuid: 'u_agent', message: { role: 'user', content: 'run the agent' } },
    { type: 'assistant', uuid: 'a_agent', message: { id: 'm_agent', role: 'assistant', content: [
      { type: 'tool_use', id: TU, name: 'Agent', input: { description: 'bg' } },
    ] } },
    { type: 'user', uuid: 'u_agent_res', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TU, content: 'started', is_error: false },
    ] } },
    ...plainTurn('p3'), ...plainTurn('p4'),
  ] });

  // Replay shape, pinned so the seq arithmetic below stays honest: 16 events,
  // the Agent head at index 8, 5 outer echoes (#0..#4).
  const probe = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [], trimmedBefore: Number.MAX_SAFE_INTEGER, userEchoCount: 5,
  });
  assert.equal(probe.events.length, 16);
  assert.equal(probe.events[8].kind, 'tool_use');
  assert.equal(probe.events[8].toolUseId, TU);

  // Ring head is echo #5, so the archive cuts at its own length: archive seqs
  // 0..15, ring seqs 16..26, no gap. The Agent head is archive-side; three of
  // its children sit ring-side at 22/23/24.
  const tb = probe.events.length;
  const ring = [
    { kind: 'user_echo', text: 'prompt 5', userIndex: 5, _seq: 16 },
    { kind: 'text_delta', msgId: 'm5', blockIdx: 0, text: 'reply 5', _seq: 17 },
    { kind: 'text_end', msgId: 'm5', blockIdx: 0, _seq: 18 },
    { kind: 'turn_end', subtype: 'success', _seq: 19 },
    { kind: 'user_echo', text: 'seam turn', userIndex: 6, _seq: 20 },
    { kind: 'text_delta', msgId: 'mz', blockIdx: 0, text: 'outer', _seq: 21 },
    // Distinct blockIdx: three separate child events, not one folded block.
    { kind: 'text_delta', msgId: 'msq', blockIdx: 0, text: 'q0', parentToolUseId: TU, _seq: 22 },
    { kind: 'text_delta', msgId: 'msq', blockIdx: 1, text: 'q1', parentToolUseId: TU, _seq: 23 },
    { kind: 'text_delta', msgId: 'msq', blockIdx: 2, text: 'q2', parentToolUseId: TU, _seq: 24 },
    { kind: 'text_end', msgId: 'mz', blockIdx: 0, _seq: 25 },
    { kind: 'turn_end', subtype: 'success', _seq: 26 },
  ];
  const stubInst = {
    cwd: projectPath, backingSessionId: sid, _userEchoCount: 7,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  const LIMIT = 5;
  const childSeqs = ring.filter(e => e.parentToolUseId === TU).map(e => e._seq);
  // What decorrelates this fixture from the pre-fix behaviour: any page whose
  // window can cover the children requests `before >= min(childSeqs) + 1`, and
  // that leaves `before - LIMIT >= tb` — so the seq-extent arm of needArchive
  // can NEVER fire on it. Only the headless-child arm can load the archive
  // here. (At limit 12 the extent arm fires on its own and the assertions below
  // pass with or without the fix — the limit is load-bearing, not incidental.)
  assert.ok(Math.min(...childSeqs) + 1 - LIMIT >= tb,
    'fixture must sit above the seq-extent reach of needArchive');

  const pages = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = await pageInstanceEvents(stubInst, { limit: LIMIT, before });
    pages.push(page);
    if (!page.hasMore) break;
    before = page.nextBefore;
    if (i === 49) throw new Error('cursor never terminated');
  }

  const reunited = pages.find(p =>
    p.events.some(e => e.kind === 'tool_use' && e.toolUseId === TU)
    && childSeqs.every(seq => p.events.some(e => e._seq === seq)));
  assert.ok(reunited,
    'some page serves the archive-side Agent head together with all three of its ring-side children, '
    + `pages: ${JSON.stringify(pages.map(p => p.events.map(e => e._seq)))}`);
});

// The other half of 2026-0037's predicate: it must fire ONLY for the tentative
// window, and only for children the ring genuinely cannot resolve. Over-firing
// is observable, not just wasteful — a replay this page has no reason to do
// pulls the archive into `reconstructTasks(combined)`, so a batch whose
// `TaskCreate` is archive-side reconstructs and injects a `task_completion`
// bubble that a ring-only page never produces. That bubble is the witness used
// below: its absence means no replay happened.
test('a window whose sub-agent children all have ring-side heads triggers no archive replay', async () => {
  const sid = 'b7b7b7b7-1111-2222-3333-444444444444';
  const TU = 'toolu_arch_agent';
  const { projectPath } = await seedSession({ ctx, projectName: 'selective', sid, lines: [
    { type: 'user', uuid: 'u_p0', message: { role: 'user', content: 'prompt p0' } },
    { type: 'assistant', uuid: 'a_p0', message: { id: 'm_p0', role: 'assistant', content: [
      { type: 'text', text: 'reply p0' },
    ] } },
    // The batch's TaskCreate lives ONLY in the jsonl.
    { type: 'user', uuid: 'utc', message: { role: 'user', content: 'do the tasks' } },
    { type: 'assistant', uuid: 'atc', message: { id: 'mtc', role: 'assistant', content: [
      { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'Alpha' } },
    ] } },
    { type: 'user', uuid: 'urc', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created successfully: Alpha' },
    ] } },
    // ...as does this Agent head, whose children are ring-side and headless.
    { type: 'user', uuid: 'u_agent', message: { role: 'user', content: 'run the agent' } },
    { type: 'assistant', uuid: 'a_agent', message: { id: 'm_agent', role: 'assistant', content: [
      { type: 'tool_use', id: TU, name: 'Agent', input: { description: 'bg' } },
    ] } },
    { type: 'user', uuid: 'u_agent_res', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TU, content: 'started', is_error: false },
    ] } },
  ] });

  const probe = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [], trimmedBefore: Number.MAX_SAFE_INTEGER, userEchoCount: 3,
  });
  assert.ok(probe.events.some(e => e.kind === 'tool_use' && e.name === 'TaskCreate'),
    'the batch is created archive-side only');
  const tb = probe.events.length;

  let s = tb;
  const seq = () => s++;
  const ring = [
    { kind: 'user_echo', text: 'prompt 3', userIndex: 3, _seq: seq() },
    // Headless over the ring (head is the archive-side Agent) — and BELOW the
    // window probed at the end. Widening the predicate's window start to 0
    // makes it see these and fire when it must not.
    { kind: 'text_delta', msgId: 'msq', blockIdx: 0, text: 'q0', parentToolUseId: TU, _seq: seq() },
    { kind: 'text_delta', msgId: 'msq', blockIdx: 1, text: 'q1', parentToolUseId: TU, _seq: seq() },
    { kind: 'turn_end', subtype: 'success', _seq: seq() },
    // The probed turn: a ring-side group that resolves itself, plus the
    // batch's completing TaskUpdate.
    { kind: 'user_echo', text: 'finish it', userIndex: 4, _seq: seq() },
    { kind: 'tool_use', msgId: 'mr', blockIdx: 0, toolUseId: 'tu_R', name: 'Agent', input: {}, _seq: seq() },
    { kind: 'tool_result', toolUseId: 'tu_R', content: 'ok', isError: false, _seq: seq() },
    { kind: 'text_delta', msgId: 'mrc', blockIdx: 0, text: 'r0', parentToolUseId: 'tu_R', _seq: seq() },
    { kind: 'tool_use', msgId: 'mtu', blockIdx: 0, toolUseId: 'tu1', name: 'TaskUpdate',
      input: { taskId: '1', status: 'completed' }, _seq: seq() },
    { kind: 'tool_result', toolUseId: 'tu1', content: 'ok', isError: false, _seq: seq() },
    { kind: 'turn_end', subtype: 'success', _seq: seq() },
  ];
  for (let t = 0; t < 3; t++) {
    ring.push({ kind: 'user_echo', text: `late ${t}`, userIndex: 5 + t, _seq: seq() });
    ring.push({ kind: 'text_delta', msgId: `ml${t}`, blockIdx: 0, text: `l${t}`, _seq: seq() });
    ring.push({ kind: 'text_end', msgId: `ml${t}`, blockIdx: 0, _seq: seq() });
    ring.push({ kind: 'turn_end', subtype: 'success', _seq: seq() });
  }
  const stubInst = {
    cwd: projectPath, backingSessionId: sid, _userEchoCount: 8,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  const LIMIT = 7;
  const updateSeq = ring.find(e => e.name === 'TaskUpdate')._seq;
  const servableChildSeq = ring.find(e => e.parentToolUseId === 'tu_R')._seq;
  const pages = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = await pageInstanceEvents(stubInst, { limit: LIMIT, before });
    pages.push({ before: before ?? null, page });
    if (!page.hasMore) break;
    before = page.nextBefore;
    if (i === 49) throw new Error('cursor never terminated');
  }

  const probed = pages.find(p => p.page.events.some(e => e._seq === updateSeq));
  assert.ok(probed, 'some page serves the completing TaskUpdate');
  // Fixture preconditions, asserted so the test cannot go vacuous: this
  // window holds a servable child (its head `tu_R` is right there in the
  // ring), the headless children sit BELOW it, and its seq extent stays
  // clear of `trimmedBefore` — so nothing about it justifies a replay.
  assert.ok(probed.page.events.some(e => e._seq === servableChildSeq),
    'the probed window holds the ring-side-headed child');
  assert.ok(probed.before - LIMIT >= tb,
    'the probed window is clear of the seq-extent arm of needArchive');
  assert.ok(Math.max(...ring.filter(e => e.parentToolUseId === TU).map(e => e._seq)) < probed.before - LIMIT,
    'the headless children sit strictly below the probed window');

  assert.equal(probed.page.events.filter(e => e.kind === 'task_completion').length, 0,
    'no archive replay for a self-resolving window (a task_completion bubble here '
    + 'could only come from the archive-side TaskCreate): '
    + JSON.stringify(probed.page.events.map(e => e._seq ?? `<${e.kind}>`)));
});

// 2026-0039(a) — the cursor collapse. When the quiescent snap rejects a whole
// backward window the page is empty, and `nextBefore` used to fall all the way
// to `trimmedBefore`, silently skipping every seq between there and the
// requested `before`. Deliberately decorrelated from the archive: `sessionId`
// is null, so no jsonl exists and `needArchive` can never fire — the missing
// events can only be recovered by the cursor arithmetic, never by a replay.
test('a rejected window is served, and coverage is total', async () => {
  const ring = [];
  let s = 100;
  for (let t = 0; t < 5; t++) {
    ring.push({ kind: 'user_echo', text: `prompt ${t}`, userIndex: t, _seq: s++ });
    ring.push({ kind: 'text_delta', msgId: `m${t}`, blockIdx: 0, text: `reply ${t}`, _seq: s++ });
    ring.push({ kind: 'text_end', msgId: `m${t}`, blockIdx: 0, _seq: s++ });
  }
  // The trailing window is nothing but children of a head that exists nowhere.
  // Distinct blockIdx per child — a shared one folds them into a single slot.
  for (let i = 0; i < 5; i++) {
    ring.push({ kind: 'text_delta', msgId: 'msG', blockIdx: i, text: `g${i}`,
      parentToolUseId: 'GONE', _seq: s++ });
  }
  const tb = 100;
  const stubInst = {
    cwd: '/fake', backingSessionId: null, _userEchoCount: 5,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  const LIMIT = 5;
  const servedSeqs = [];
  const pages = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = await pageInstanceEvents(stubInst, { limit: LIMIT, before });
    pages.push({ before: before ?? null, page });
    // (i) no page is empty while claiming more history exists — the A3
    // backstop guarantees any non-empty window is served, and the window
    // here (end > 0) is never empty.
    assert.ok(!(page.hasMore && page.events.length === 0),
      `page must never be empty while hasMore is true — ${JSON.stringify(page)}`);
    for (const ev of page.events) if (ev._seq != null) servedSeqs.push(ev._seq);
    if (page.hasMore && before != null) {
      assert.ok(page.nextBefore < before,
        `nextBefore must strictly progress (${page.nextBefore} !< ${before})`);
    }
    if (!page.hasMore) break;
    before = page.nextBefore;
    if (i === 49) throw new Error('cursor never terminated');
  }

  // (ii) + (iii): the union of served seqs is exactly [100,120) — no holes
  // (the old cursor's collapse-past-the-rejected-window regression) and no
  // duplicates (pages must still tile, not overlap).
  const expected = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.deepEqual(servedSeqs.slice().sort((a, b) => a - b), expected,
    'every seq in [100,120) is served exactly once: '
    + JSON.stringify(pages.map(p => [p.before, p.page.events.map(e => e._seq ?? `<${e.kind}>`)])));
});

// 2026-0039(b) — the cursor stall, and the standing refutation of the card's
// "unreachable" claim. `loadSubAgentTranscript` emits the sub-agent's events
// from the parent's `tool_result` LINE, while the owning `tool_use` head comes
// from an earlier `assistant` line; nothing couples the two, so a jsonl
// carrying the result line without the head replays to an ARCHIVE-side headless
// component. With `before <= trimmedBefore` the old fallback returned `before`
// itself, and a client echoing `nextBefore` re-requested it forever.
test('an archive-side headless component is served and the cursor strictly progresses', async () => {
  const sid = 'd0d0d0d0-1111-2222-3333-444444444444';
  const TU = 'tu_headless_agent';
  const plainTurn = (tag, i) => ([
    { type: 'user', uuid: `u_${tag}`, message: { role: 'user', content: `prompt ${i}` } },
    { type: 'assistant', uuid: `a_${tag}`, message: { id: `m_${tag}`, role: 'assistant', content: [
      { type: 'text', text: `reply ${i}` },
    ] } },
  ]);
  const { projectPath, sessionDir } = await seedSession({ ctx, projectName: 'headlessarch', sid, lines: [
    ...plainTurn('p0', 0),
    { type: 'user', uuid: 'u_p1', message: { role: 'user', content: 'prompt 1' } },
    // The Agent's tool_result WITHOUT any assistant line holding `tool_use` TU.
    { type: 'user', uuid: 'u_res', toolUseResult: { agentId: 'ag1' }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TU, content: 'done', is_error: false },
    ] } },
    ...plainTurn('p2', 2), ...plainTurn('p3', 3),
  ] });
  await fs.mkdir(path.join(sessionDir, sid, 'subagents'), { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, sid, 'subagents', 'agent-ag1.jsonl'),
    Array.from({ length: 3 }, (_, i) => JSON.stringify({
      type: 'assistant', uuid: `s${i}`, isSidechain: true,
      message: { id: `ms${i}`, role: 'assistant', content: [{ type: 'text', text: `sub ${i}` }] },
    })).join('\n') + '\n',
  );

  // Replay shape, pinned so the arithmetic below stays honest: 17 events, the
  // headless component at 4..9, its tool_result at 10, echo #2 at 11.
  const probe = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [], trimmedBefore: Number.MAX_SAFE_INTEGER, userEchoCount: 4,
  });
  assert.equal(probe.events.length, 17);
  assert.equal(probe.events.filter(e => e.parentToolUseId === TU).length, 6);
  assert.equal(probe.events.filter(e => e.toolUseId === TU && e.kind === 'tool_use').length, 0,
    'the component really is headless ARCHIVE-side — no tool_use head anywhere in the replay');

  // Ring head is echo #2, so cut === trimmedBefore === 11: the headless
  // component sits entirely archive-side, below every backward window that
  // reaches it, which is what forces `before <= trimmedBefore`.
  const tb = 11;
  const ring = [
    { kind: 'user_echo', text: 'prompt 2', userIndex: 2, _seq: 11 },
    { kind: 'text_delta', msgId: 'm_p2', blockIdx: 0, text: 'reply 2', _seq: 12 },
    { kind: 'text_end', msgId: 'm_p2', blockIdx: 0, _seq: 13 },
    { kind: 'user_echo', text: 'prompt 3', userIndex: 3, _seq: 14 },
    { kind: 'text_delta', msgId: 'm_p3', blockIdx: 0, text: 'reply 3', _seq: 15 },
    { kind: 'text_end', msgId: 'm_p3', blockIdx: 0, _seq: 16 },
  ];
  const stubInst = {
    cwd: projectPath, backingSessionId: sid, _userEchoCount: 4,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  for (const limit of [2, 3, 4, 5]) {
    let before;
    let terminated = false;
    const trace = [];
    const servedSeqs = [];
    for (let i = 0; i < 40; i++) {
      const page = await pageInstanceEvents(stubInst, { limit, before });
      trace.push([before ?? null, page.events.map(e => e._seq ?? `<${e.kind}>`), page.hasMore, page.nextBefore]);
      for (const ev of page.events) if (ev._seq != null) servedSeqs.push(ev._seq);
      if (page.hasMore && before != null) {
        assert.notEqual(page.nextBefore, before,
          `limit=${limit} page[${i}]: cursor stalled at ${before} — ${JSON.stringify(trace)}`);
        assert.ok(page.nextBefore < before,
          `limit=${limit} page[${i}]: nextBefore must strictly progress — ${JSON.stringify(trace)}`);
      }
      if (!page.hasMore) { terminated = true; break; }
      before = page.nextBefore;
    }
    assert.ok(terminated, `limit=${limit}: cursor never terminated — ${JSON.stringify(trace)}`);
    // Exact coverage: the headless component (archive seqs 4..9) is no longer
    // dropped along with the empty-page cursor — every seq in the combined
    // archive+ring space [0,17) is served exactly once.
    const expected = Array.from({ length: 17 }, (_, i) => i);
    assert.deepEqual(servedSeqs.slice().sort((a, b) => a - b), expected,
      `limit=${limit}: every combined seq served exactly once, including the archive-side headless component — ${JSON.stringify(trace)}`);
  }
});

// 2026-0054 — the gap marker's POSITION. The fixture the card's TEST GAP names
// and nothing else covered: a mid-turn ring head on a NON-FIRST turn, paged at a
// `limit` below the ring size. Both are load-bearing. A non-first turn puts real
// archive content BELOW the seam, so the seam-carrying page and the terminal page
// are different pages; a limit under the ring size forces the walk to reach the
// seam on a page of its own rather than serving everything at once. Relax either
// and the fixture stops distinguishing seam-anchored from head-anchored.
// Phase B (2026-0146): the stub ring's `msgId` ('mG') is foreign to the
// jsonl, so the content correlator abandons and this fixture keeps falling
// back to the echo anchor — `gap === true` here is now deliberate, not
// vacuous. Do not "fix" the fixture into a correlator hit.
test('mid-turn ring head on a non-first turn: gap marker sits at the archive/ring seam', async () => {
  const sid = 'c0c0c0c0-1111-2222-3333-444444444444';
  const { projectPath } = await seedSession({ ctx, projectName: 'seammarker', sid, lines: turnLines(5) });

  // Replay shape, pinned so the arithmetic below stays honest: 5 plain turns →
  // 15 events, echo #4 at index 12.
  const probe = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [], trimmedBefore: Number.MAX_SAFE_INTEGER, userEchoCount: 5,
  });
  assert.equal(probe.events.length, 15);
  assert.equal(probe.events[12].kind, 'user_echo');
  assert.equal(probe.events[12].userIndex, 4);

  // The giant 5th turn: its content overran the ring, so the trim could not
  // reach turn 4's echo and the head is mid-turn. Distinct blockIdx per delta
  // (the ring folds same-block deltas) and no text_end — every block stays open,
  // which is what keeps the head off a turn boundary.
  const tb = 13;
  const ring = Array.from({ length: 9 }, (_, i) => (
    { kind: 'text_delta', msgId: 'mG', blockIdx: i, text: `g${i}`, _seq: tb + i }
  ));
  const stubInst = {
    cwd: projectPath, backingSessionId: sid, _userEchoCount: 5,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  const arch = await buildArchive({
    cwd: projectPath, sessionId: sid, ring, trimmedBefore: tb, userEchoCount: 5,
  });
  assert.equal(arch.cut, tb, 'archive is cut just after turn 4\'s echo, level with the ring head');
  assert.equal(arch.gap, true, 'mid-turn head means a real gap — the fixture is not vacuous');
  // The seam, stated in seq terms: the last archive event served, and the first
  // ring event. Everything below is asserted against THIS boundary, never
  // against a page index — an off-by-one page would satisfy an index assertion.
  const lastArchiveSeq = arch.events[arch.cut - 1]._seq;
  assert.equal(lastArchiveSeq, 12);

  const LIMIT = 7;
  assert.ok(LIMIT < ring.length, 'limit must sit below the ring size');

  const pages = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = await pageInstanceEvents(stubInst, { limit: LIMIT, before });
    pages.push(page.events);
    if (!page.hasMore) break;
    before = page.nextBefore;
    if (i === 49) throw new Error('cursor never terminated');
  }
  const trace = () => JSON.stringify(pages.map(p => p.map(e => e._seq ?? `<${e.kind}>`)));

  // (a) Exactly one marker. Kills a "splice on every page that computes gap"
  // mutant, and kills leaving the terminal append unnarrowed (the seam page and
  // the terminal page are distinct here, so both would fire).
  // Backward paging walks newest-first, so reassembling the stream means
  // reversing the page order.
  const all = pages.slice().reverse().flat();
  assert.equal(all.filter(e => e.kind === 'history_gap').length, 1,
    `exactly one gap marker across all pages — ${trace()}`);

  // (b) It sits ON the seam within its own page: last event of the page whose
  // newest served event is the last archive event. Pre-fix the marker is
  // appended to the terminal page, whose newest event is _seq 5.
  const marked = pages.find(p => p.some(e => e.kind === 'history_gap'));
  const real = marked.filter(e => e._seq != null);
  assert.equal(real[real.length - 1]._seq, lastArchiveSeq,
    `the marker's page must be the one ending at the archive cut — ${trace()}`);
  assert.equal(marked[marked.length - 1].kind, 'history_gap',
    `the marker must be that page's last event, on the seam — ${trace()}`);

  // (c) In the reassembled stream the marker separates the two seq spaces: the
  // last archive event, the marker, then the ring head.
  const gi = all.findIndex(e => e.kind === 'history_gap');
  assert.equal(all[gi - 1]._seq, lastArchiveSeq, `marker follows the last archive event — ${trace()}`);
  assert.equal(all[gi + 1]._seq, tb, `marker sits right before the first ring-side event — ${trace()}`);
});

// 2026-0054 C1 — the composition of the empty-page cursor (slice 2) with the
// seam-anchored marker (slice 3). The marker rule needs SOME page to end at the
// seam or straddle it, which holds because backward pages tile — except on an
// empty page, whose cursor is the pre-snap window start rather than its served
// start. When that back-off lands strictly BELOW the seam the seam is neither a
// page boundary nor interior to any served slice, and the marker is dropped on
// every page of the walk: a silent hole, and a regression against pre-slice-2
// behaviour. Every other gap fixture in this file has the back-off landing
// exactly ON the seam (the `resetIdx` fiat cut), which is why they stay green
// either way; this one is built so it lands below it.
// Phase B (2026-0146): the stub ring's `msgId` ('mG') is foreign to the
// jsonl, so the content correlator abandons and this fixture keeps falling
// back to the echo anchor — `gap === true` here is now deliberate, not
// vacuous. Do not "fix" the fixture into a correlator hit.
test('a window straddling the seam is served whole, with exactly one gap marker at the seam', async () => {
  const sid = 'c1c1c1c1-1111-2222-3333-444444444444';
  const { projectPath } = await seedSession({ ctx, projectName: 'straddle', sid, lines: turnLines(5) });

  // Same mid-turn-head shape as the seam test above (5 turns → 15 archive
  // events, cut 13, gap true), but two of the ring's deltas are children of a
  // head that exists nowhere — the same truly-headless shape the seam fixture
  // uses. That is what makes the trailing window unservable, hence empty, hence
  // routed through the empty-page cursor.
  const tb = 13;
  const ring = Array.from({ length: 8 }, (_, i) => {
    const ev = { kind: 'text_delta', msgId: 'mG', blockIdx: i, text: `g${i}`, _seq: tb + i };
    if (tb + i === 15 || tb + i === 16) ev.parentToolUseId = 'GONE';
    return ev;
  });
  const stubInst = {
    cwd: projectPath, backingSessionId: sid, _userEchoCount: 5,
    ring: { get trimmedBefore() { return tb; } },
    ringSnapshot: () => ring.slice(),
  };

  const arch = await buildArchive({
    cwd: projectPath, sessionId: sid, ring, trimmedBefore: tb, userEchoCount: 5,
  });
  assert.equal(arch.cut, tb);
  assert.equal(arch.gap, true, 'mid-turn head means a real gap — the fixture is not vacuous');
  const lastArchiveSeq = arch.events[arch.cut - 1]._seq;
  assert.equal(lastArchiveSeq, 12);

  // THE fixture property, stated before the walk so it cannot silently rot:
  // the trailing page's pre-snap window start sits strictly BELOW the seam
  // while its `end` sits above it — the window straddles the seam, so an empty
  // page here hands out a cursor that would jump clean over it.
  const LIMIT = 9;
  const combinedLen = arch.cut + ring.length;
  assert.ok(combinedLen - LIMIT < arch.cut && combinedLen > arch.cut,
    'the trailing window must straddle the seam (pre-snap start below arch.cut, end above it)');

  const pages = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = await pageInstanceEvents(stubInst, { limit: LIMIT, before });
    pages.push({ before: before ?? null, page });
    if (page.hasMore && before != null) {
      assert.ok(page.nextBefore < before,
        `nextBefore must strictly progress (${page.nextBefore} !< ${before})`);
    }
    if (!page.hasMore) break;
    before = page.nextBefore;
    if (i === 49) throw new Error('cursor never terminated');
  }
  const trace = () => JSON.stringify(pages.map(p =>
    [p.before, p.page.events.map(e => e._seq ?? `<${e.kind}>`), p.page.nextBefore]));

  // The straddling window is now SERVED — A3's backstop means no window with
  // end > 0 is ever rejected outright, so this is the inverse of the old
  // "must produce an empty page" precondition.
  assert.ok(!pages.some(p => p.page.hasMore && p.page.events.length === 0),
    `no page may be empty while hasMore is true — ${trace()}`);

  // (1) The marker survives the walk. Zero here is the C1 defect.
  const all = pages.map(p => p.page.events).reverse().flat();
  assert.equal(all.filter(e => e.kind === 'history_gap').length, 1,
    `exactly one gap marker across all pages — ${trace()}`);

  // (2) It sits exactly between the last archive event and the first ring
  // event — interior to whichever page serves that span now, not necessarily
  // that page's last event (the straddling window is served whole).
  const gi = all.findIndex(e => e.kind === 'history_gap');
  assert.equal(all[gi - 1]._seq, lastArchiveSeq,
    `marker follows the last archive event — ${trace()}`);
  assert.equal(all[gi + 1]._seq, tb,
    `marker precedes the first ring-side event — ${trace()}`);
});

test('limit is clamped; bad params 400; unknown instance 404', async () => {
  {
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
  }
});

test('T3 (Step 4): buildArchive marks a gap when the trimmedBefore clamp discards archive content', async () => {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'clampgap' });
  const projectPath = path.join(ctx.projectsRoot, 'clampgap');
  const sid = 'aaaabbbb-2222-3333-4444-555555555555';
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  // Two plain turns: replay flattens to [echo0, text_delta, text_end, echo1,
  // text_delta, text_end] — echo1 (userIndex 1) lands at flat index 3.
  await fs.writeFile(
    path.join(sessionDir, `${sid}.jsonl`),
    turnLines(2).map(l => JSON.stringify(l)).join('\n') + '\n',
  );
  const head = { kind: 'user_echo', text: 'prompt 1', userIndex: 1, _seq: 2 };

  // trimmedBefore (2) sits BELOW the anchor echo's archive index (3): the
  // clamp discards flat[2] (turn 0's text_end) without the fix, silently.
  const clamped = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [head], trimmedBefore: 2, userEchoCount: 2,
  });
  assert.equal(clamped.cut, 2, 'cut is clamped down to trimmedBefore');
  assert.equal(clamped.gap, true, 'clamp discarding real archive content must mark gap (Step 4)');

  // trimmedBefore (3) matches the anchor cut exactly — the normal
  // turn-aligned case — and must NOT be marked as a gap.
  const aligned = await buildArchive({
    cwd: projectPath, sessionId: sid, ring: [head], trimmedBefore: 3, userEchoCount: 2,
  });
  assert.equal(aligned.cut, 3);
  assert.equal(aligned.gap, false, 'cut === trimmedBefore is the healthy turn-aligned case, no gap');
});

test('T3 (Step 5): pageInstanceEvents marks a gap for a trimmed ring with no sessionId to replay from', async () => {
  const ring = [
    { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'e0', _seq: 5 },
    { kind: 'text_delta', msgId: 'm', blockIdx: 1, text: 'e1', _seq: 6 },
  ];
  const stubInst = {
    cwd: '/fake', backingSessionId: null, _userEchoCount: 0,
    ring: { get trimmedBefore() { return 5; } },
    ringSnapshot: () => ring.slice(),
  };
  const page = await pageInstanceEvents(stubInst, { limit: 10 });
  assert.equal(page.hasMore, false, 'nothing more IS fetchable (no sessionId to replay from) — the marker is the honest signal');
  const gaps = page.events.filter(e => e.kind === 'history_gap');
  assert.equal(gaps.length, 1, 'exactly one gap marker for the unreplayable evicted span');
  assert.equal(page.events[0].kind, 'history_gap', 'marker sits right before the retained ring head');
  assert.equal(page.events[1]._seq, 5, 'the ring head follows immediately after the marker');
});

// The narrowed terminal-page backstop (2026-0054, mutant `mutG`). Once the
// marker is anchored to the seam's position, a page whose window sits above the
// seam has no offset to splice at — and a BACKWARD such page always has a lower
// page coming that does (its `!hasMore` implies `start === 0`). Forward paging
// has no such page: `after` past the ring head serves the top of the stream and
// stops, so without the append the eviction would go unmarked entirely. Deleting
// the append must fail here; widening it back to "any page that missed the seam"
// must fail the mid-turn-head test above with two markers.
test('a terminal forward page above the seam still surfaces the gap marker', async () => {
  const ring = Array.from({ length: 6 }, (_, i) => (
    { kind: 'text_delta', msgId: 'm', blockIdx: i, text: `e${i}`, _seq: 5 + i }
  ));
  const stubInst = {
    cwd: '/fake', backingSessionId: null, _userEchoCount: 0,
    ring: { get trimmedBefore() { return 5; } },
    ringSnapshot: () => ring.slice(),
  };
  // after=7 starts the window at _seq 8, strictly above the seam (the ring head
  // at _seq 5 === trimmedBefore), and the whole remainder fits in one page.
  const page = await pageInstanceEvents(stubInst, { after: 7, limit: 10 });
  assert.equal(page.hasMore, false, 'terminal page — nothing below will carry the marker');
  assert.deepEqual(page.events.map(e => e._seq).filter(s => s != null), [8, 9, 10],
    'the served window really is above the seam (no _seq === trimmedBefore in it)');
  assert.equal(page.events.filter(e => e.kind === 'history_gap').length, 1,
    'the evicted span is still marked');
  // POSITION, not just presence: this page sits above the seam, so the marker
  // is the APPEND, at the tail. Dropping `servedStart = start` from the forward
  // branch turns `at` into 0 and routes the marker through the splice instead,
  // emitting `[GAP, 8, 9, 10]` — same count, same `_seq` list, wrong place.
  assert.equal(page.events[page.events.length - 1].kind, 'history_gap',
    'the marker is appended below the served window, not spliced above it');
});

// A task batch that lives in older history must render its finished-task bubble
// when paged back — the server injects a synthetic {kind:'task_completion'}
// after the completing TaskUpdate (client no longer synthesizes it for the
// lazy path). See src/eventArchive.ts injectTaskCompletions + taskReconstruct.ts.
function taskBatchLines() {
  return [
    { type: 'user', uuid: 'utc', message: { role: 'user', content: 'do the tasks' } },
    { type: 'assistant', uuid: 'atc', message: { id: 'mtc', role: 'assistant', content: [
      { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'Alpha' } },
    ] } },
    { type: 'user', uuid: 'urc', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created successfully: Alpha' },
    ] } },
    { type: 'assistant', uuid: 'atu1', message: { id: 'mtu1', role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
    ] } },
    { type: 'assistant', uuid: 'atu2', message: { id: 'mtu2', role: 'assistant', content: [
      { type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
    ] } },
  ];
}

function findCompletionAfterUpdate(events) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_use' && e.name === 'TaskUpdate' && e.input?.status === 'completed') {
      return events[i + 1] ?? null;
    }
  }
  return null;
}

test('paged history injects a task_completion bubble after the completing update', async () => {
  {
    const sid = 'ffffffff-2222-3333-4444-555555555555';
    // Batch is older; trailing turns push it back so it is genuinely history.
    const id = await bootResumed({ ctx, projectName: 'tasky',
      sid, lines: [...taskBatchLines(), ...turnLines(3)] });

    const { all } = await pageAll(ctx, id, { limit: 50 });
    const completions = all.filter(e => e.kind === 'task_completion');
    assert.equal(completions.length, 1, 'exactly one synthesized bubble');
    assert.deepEqual(completions[0].tasks.map(t => ({ id: t.id, status: t.status })),
      [{ id: '1', status: 'completed' }]);
    // Placed immediately after the completing TaskUpdate, in chronological order.
    const after = findCompletionAfterUpdate(all);
    assert.ok(after && after.kind === 'task_completion',
      'bubble sits right after the completing update');
    // Synthetic bubbles carry no _seq (like the client synthesis), so they
    // never collide with real event dedup.
    assert.equal(completions[0]._seq, undefined);
  }
});

test('a batch spanning a page boundary still gets its bubble in the completing page', async () => {
  {
    const sid = 'ffffffff-3333-4444-5555-666666666666';
    const id = await bootResumed({ ctx, projectName: 'tasky2',
      sid, lines: [...taskBatchLines(), ...turnLines(3)] });

    // A small limit splits the create and the completing update across pages;
    // injection derives over the full combined history, so the bubble still
    // lands with the completing update (verified via the reassembled stream).
    const { all } = await pageAll(ctx, id, { limit: 2 });
    const completions = all.filter(e => e.kind === 'task_completion');
    assert.equal(completions.length, 1, 'no dup / no drop across page seams');
    const after = findCompletionAfterUpdate(all);
    assert.ok(after && after.kind === 'task_completion');
  }
});

// T14 — acceptance #1, end-to-end: a depth-2 sub-agent session renders its
// full history and pages to seq 0. Real subprocess path (not a stub ring),
// so this exercises the LIVE parser's A1 fix directly: a top-level Agent
// tool_use (tu_a1), forwarded as a finals-only envelope tagged
// parent_tool_use_id, whose OWN content spawns a second Agent (tu_a2) —
// exactly the depth-2 shape the card was filed against.
test('a depth-2 sub-agent session renders its full history and pages to seq 0', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_SUBAGENT_DEPTH2;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  let inst;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'subagentdepth2' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'subagentdepth2', mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    inst = ctx.instances.get(id);

    inst.prompt('go explore deeply');
    await waitFor(() => inst.status === 'idle' && inst.ringSnapshot().some(e => e.kind === 'turn_end'));

    // (i) The depth-2 head exists in the ring at all — the whole point of A1.
    const ring = inst.ringSnapshot();
    assert.ok(ring.some(e => e.kind === 'tool_use' && e.toolUseId === 'tu_a2'),
      'the forwarded sub-agent envelope produced a head event for its own tool_use');

    // (ii) snapshotTail (the WS subscribe path) is not the pre-fix "one
    // rendered bubble, no prompt" tail.
    const snap = inst.snapshotTail();
    assert.ok(snap.some(e => e.kind === 'user_echo' && !e.parentToolUseId),
      'the tail contains the outer prompt echo, not just a mid-turn fragment');

    // (iii) Backward paging reaches seq 0 with no empty page and no holes.
    const pages = await pageAllPages(ctx, id, { limit: 3 });
    for (let p = 0; p < pages.length; p++) assertGroupIntegrity(pages[p], `page[${p}] `);
    const all = pages.slice().reverse().flat();
    assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq),
      'pageAll reaches seq 0 with full coverage, no empty page, no holes');
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
  }
});
