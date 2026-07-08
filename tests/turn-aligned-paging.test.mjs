// Turn-aligned lazy paging & tail snapshots (src/parser.js
// snapStartToTurnStart, used by src/eventArchive.js pageInstanceEvents and
// src/instances.js snapshotTail): backward pages and the WS tail open on an
// outer user_echo even when a turn is longer than the window, extending the
// window backward to the owning echo — the client renders each page through
// an isolated Conversation instance, so a mid-turn cut used to split an
// assistant bubble in two and strand its straddling block un-finalized.
// Covers: over-long-turn backward extension, the TURN_SNAP_MULT backstop
// (bounded, no dup/no gap even when it trips), snapshotTail extension past
// ORCH_SNAPSHOT_TAIL, in-window forward snap preserved, and the
// group-integrity backward pull re-snapping to the pulled-in head's echo.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { pageInstanceEvents } from '../src/eventArchive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

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

function smallTurn(tag) {
  return [
    { type: 'user', uuid: `u${tag}`, message: { role: 'user', content: `prompt ${tag}` } },
    { type: 'assistant', uuid: `a${tag}`, message: { id: `m${tag}`, role: 'assistant', content: [
      { type: 'text', text: `reply ${tag}` },
    ] } },
  ];
}

function bigTurn(tag, blocks) {
  return [
    { type: 'user', uuid: `u${tag}`, message: { role: 'user', content: `prompt ${tag}` } },
    { type: 'assistant', uuid: `a${tag}`, message: { id: `m${tag}`, role: 'assistant', content:
      Array.from({ length: blocks }, (_, i) => ({ type: 'text', text: `${tag} block ${i}` })),
    } },
  ];
}

// Returns each backward page as its own array, newest page first.
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

test('a turn longer than the page window is served whole — every page opens on a user_echo', async () => {
  const sid = 'aaaa1111-2222-3333-4444-555555555555';
  // Turn B replays to ~25 events (12 blocks), well over limit=10 but under
  // the 5× backstop (50) — the page must extend backward to B\'s echo.
  const id = await bootResumed({ ctx, projectName: 'wholeturn', sid, lines: [
    ...smallTurn('A'), ...bigTurn('B', 12), ...smallTurn('C'),
  ] });

  const pages = await pageAllPages(ctx, id, { limit: 10 });
  assert.ok(pages.length >= 2, 'history actually paged');
  // Every page opens on a turn boundary; the oldest page may instead open at
  // the very start of history (nothing below it to split from).
  for (let p = 0; p < pages.length; p++) {
    const isOldest = p === pages.length - 1;
    if (!isOldest) {
      assert.equal(pages[p][0].kind, 'user_echo',
        `page[${p}] opens on a user_echo (got ${pages[p][0].kind})`);
    }
  }
  // Turn B lives entirely within ONE page: its echo and all its blocks.
  const pageOfB = pages.find(p => p.some(e => e.kind === 'user_echo' && e.text === 'prompt B'));
  assert.ok(pageOfB, 'turn B echo found');
  for (let i = 0; i < 12; i++) {
    assert.ok(pageOfB.some(e => e.kind === 'text_delta' && e.text === `B block ${i}`),
      `B block ${i} in the same page as turn B's echo`);
  }
  // No dup / no gap: reassembled pages reproduce the ring exactly.
  const all = pages.slice().reverse().flat().filter(e => e._seq != null);
  const ring = ctx.instances.get(id).ringSnapshot();
  assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq));
});

test('backstop: a turn beyond 5×limit pages mid-turn but stays bounded — no dup, no gap, terminates', async () => {
  const sid = 'aaaa2222-2222-3333-4444-555555555555';
  // ~61 replay events for one turn; limit=7 → snap reach 35 < 61, so the
  // backward extension gives up somewhere inside the turn.
  const id = await bootResumed({ ctx, projectName: 'backstop', sid, lines: [
    ...bigTurn('G', 30), ...smallTurn('Z'),
  ] });

  const pages = await pageAllPages(ctx, id, { limit: 7 });
  // The backstop actually tripped: some non-oldest page opens mid-turn.
  assert.ok(pages.slice(0, -1).some(p => p[0].kind !== 'user_echo'),
    'at least one page opens mid-turn (backstop hit)');
  // Pages stay bounded by the backstop.
  for (const p of pages) assert.ok(p.length <= 7 * 5, `page bounded (got ${p.length})`);
  // Cursor contiguity: coverage is still exact.
  const all = pages.slice().reverse().flat().filter(e => e._seq != null);
  const ring = ctx.instances.get(id).ringSnapshot();
  assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq));
});

test('snapshotTail extends past ORCH_SNAPSHOT_TAIL to the turn\'s echo; in-window echo still snaps forward', async () => {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'tailsnap' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'tailsnap', mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);

    // One turn far bigger than the tail cap: echo + 20 deltas.
    inst._emitUi({ kind: 'user_echo', text: 'giant prompt' });
    for (let i = 0; i < 20; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'mG', blockIdx: 0, text: `g${i}` });
    }
    const snap = inst.snapshotTail();
    assert.equal(snap[0].kind, 'user_echo', 'tail extended back to the turn boundary');
    assert.equal(snap[0].text, 'giant prompt');
    assert.equal(snap.length, 21, 'the whole turn, nothing above it');

    // A later small turn: the window now holds an echo — forward snap keeps
    // the tail small (no over-extension to the giant turn).
    inst._emitUi({ kind: 'user_echo', text: 'small prompt' });
    for (let i = 0; i < 3; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'mS', blockIdx: 0, text: `s${i}` });
    }
    const snap2 = inst.snapshotTail();
    assert.equal(snap2[0].kind, 'user_echo');
    assert.equal(snap2[0].text, 'small prompt');
    assert.equal(snap2.length, 4, 'forward snap inside the window preserved');
  } finally {
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
  }
});

test('group pull-back re-snaps to the pulled-in head\'s turn boundary', async () => {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'grouppull' });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'grouppull', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  const inst = ctx.instances.get(id);

  // Turn 1: a background Task head (result returns immediately).
  inst._emitUi({ kind: 'user_echo', text: 'first' });
  inst._emitUi({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_bg', name: 'Task' });
  inst._emitUi({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_bg', name: 'Task', input: {} });
  inst._emitUi({ kind: 'tool_result', toolUseId: 'tu_bg', content: 'running in background', isError: false });
  // Turn 2: the background sub-agent's children stream in mid-later-turn.
  inst._emitUi({ kind: 'user_echo', text: 'second' });
  inst._emitUi({ kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'working' });
  for (let i = 0; i < 6; i++) {
    inst._emitUi({ kind: 'text_delta', msgId: 'msub', blockIdx: 0, text: `bg ${i}`, parentToolUseId: 'tu_bg' });
  }
  inst._emitUi({ kind: 'text_delta', msgId: 'm2', blockIdx: 1, text: 'still working' });

  // A 5-event window ends deep in turn 2: echo snap reaches 'second', the
  // group pull drags start back to the tu_bg head (mid-turn-1), and the
  // re-snap must land on 'first' — a turn boundary that includes the head.
  const page = await pageInstanceEvents(inst, { limit: 5 });
  assert.equal(page.events[0].kind, 'user_echo', 'page opens on a turn boundary, not a bare tool head');
  assert.equal(page.events[0].text, 'first');
  assert.ok(page.events.some(e => e.kind === 'tool_use' && e.toolUseId === 'tu_bg'),
    'the owning head is inside the page (group integrity)');
});
