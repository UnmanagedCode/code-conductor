// Quiescent-point lazy paging & tail snapshots (src/parser.js
// snapStartToQuiescent, used by src/eventArchive.js pageInstanceEvents and
// src/instances.js snapshotTail): backward pages and the WS tail open where
// reconstruction has no open block and no unresolved tool, so the client's
// isolated per-page renderer only ever sees whole blocks and complete tool
// round-trips. A turn longer than the window now SPLITS across ~limit-sized
// pages (no whole-turn extension, no TURN_SNAP_MULT backstop) — the client
// merges the seam bubbles back into one. Sub-agent groups (whose block parts
// interleave with the outer turn's) stay whole per chunk via the
// group-integrity pull, which is the sole guarantee for nested blocks.

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
const SCENARIO_BACKGROUND_TASK = path.join(__dirname, 'fixtures', 'scenario-background-task.json');

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

async function bootIdle(projectName) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: projectName, mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  return ctx.instances.get(id);
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

// Replay one served page and assert it is self-contained: every outer block
// that opens inside it closes inside it, every outer tool_use resolves inside
// it (unless a later in-page echo/turn_end force-reset — the interrupt case),
// and no sub-agent child appears without its owning head. This is the client
// renderer's whole-block contract.
function assertPageIntegrity(events, label) {
  const open = new Map();
  const pending = new Map();
  const heads = new Set();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.parentToolUseId) {
      assert.ok(heads.has(ev.parentToolUseId),
        `${label}: child event #${i} (${ev.kind}) has no head ${ev.parentToolUseId} in-page`);
      continue;
    }
    if ((ev.kind === 'tool_use_start' || ev.kind === 'tool_use') && ev.toolUseId) heads.add(ev.toolUseId);
    const key = `${ev.msgId}:${ev.blockIdx}`;
    switch (ev.kind) {
      case 'user_echo': case 'turn_end': open.clear(); pending.clear(); break;
      case 'text_delta': open.set(`${key}:t`, i); break;
      case 'text_end': open.delete(`${key}:t`); break;
      case 'thinking_start': case 'thinking_delta': open.set(`${key}:k`, i); break;
      case 'thinking_end': open.delete(`${key}:k`); break;
      case 'tool_use_start': case 'tool_use_input_delta': case 'tool_use':
        if (ev.toolUseId) pending.set(ev.toolUseId, i); break;
      case 'tool_result': if (ev.toolUseId) pending.delete(ev.toolUseId); break;
      default: break;
    }
  }
  assert.equal(open.size, 0, `${label}: blocks left open at page end: ${[...open.keys()]}`);
  assert.equal(pending.size, 0, `${label}: tools left unresolved at page end: ${[...pending.keys()]}`);
}

test('a turn longer than the window splits into ~limit-sized, self-contained pages', async () => {
  const sid = 'aaaa1111-2222-3333-4444-555555555555';
  // Turn B replays to ~25 events (12 blocks), well over limit=10. It must
  // now SPLIT across pages (no whole-turn extension) — every page whole-block.
  const id = await bootResumed({ ctx, projectName: 'wholeturn', sid, lines: [
    ...smallTurn('A'), ...bigTurn('B', 12), ...smallTurn('C'),
  ] });

  const pages = await pageAllPages(ctx, id, { limit: 10 });
  assert.ok(pages.length >= 2, 'history actually paged');
  for (let p = 0; p < pages.length; p++) {
    assertPageIntegrity(pages[p], `page[${p}]`);
    // No whole-turn extension: the quiescent snap reaches at most one block
    // span past the tentative window.
    assert.ok(pages[p].length <= 10 + 4, `page[${p}] stays ~limit-sized (got ${pages[p].length})`);
  }
  // Turn B genuinely split across pages (superseding the old served-whole
  // behavior) — the client's bubble merge reassembles it.
  const pagesWithB = pages.filter(p => p.some(e => e.kind === 'text_delta' && /^B block /.test(e.text ?? '')));
  assert.ok(pagesWithB.length >= 2, `turn B spans multiple pages (got ${pagesWithB.length})`);
  // No dup / no gap: reassembled pages reproduce the ring exactly.
  const all = pages.slice().reverse().flat().filter(e => e._seq != null);
  const ring = ctx.instances.get(id).ringSnapshot();
  assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq));
});

test('a giant turn pages bounded with zero mid-block cuts — no dup, no gap, terminates', async () => {
  const sid = 'aaaa2222-2222-3333-4444-555555555555';
  // ~61 replay events for one turn at limit=7: the old design's backstop
  // territory. Quiescent paging needs no backstop — every page is
  // self-contained and near the limit.
  const id = await bootResumed({ ctx, projectName: 'giantturn', sid, lines: [
    ...bigTurn('G', 30), ...smallTurn('Z'),
  ] });

  const pages = await pageAllPages(ctx, id, { limit: 7 });
  assert.ok(pages.length >= 5, 'the giant turn split into several pages');
  for (let p = 0; p < pages.length; p++) {
    assertPageIntegrity(pages[p], `page[${p}]`);
    assert.ok(pages[p].length <= 7 + 4, `page[${p}] bounded without a backstop (got ${pages[p].length})`);
  }
  const all = pages.slice().reverse().flat().filter(e => e._seq != null);
  const ring = ctx.instances.get(id).ringSnapshot();
  assert.deepEqual(all.map(e => e._seq), ring.map(e => e._seq));
});

test('snapshotTail opens on a quiescent point; an in-window boundary still snaps forward', async () => {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  try {
    const inst = await bootIdle('tailsnap');

    // One giant OPEN text block (a single delta run, no text_end yet): the
    // only quiescent point below the window is right after the echo — the
    // tail opens there (whole-block), the prompt bubble itself arrives via
    // the first lazy page.
    inst._emitUi({ kind: 'user_echo', text: 'giant prompt' });
    for (let i = 0; i < 20; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'mG', blockIdx: 0, text: `g${i}` });
    }
    const snap = inst.snapshotTail();
    assert.equal(snap[0].kind, 'text_delta', 'tail opens at the block run start, not mid-run');
    assert.equal(snap[0].text, 'g0', 'the whole delta run, from its first part');
    assert.equal(snap.length, 20, 'echo stays below the tail (lazy-loaded later)');

    // A later small turn: the window now holds a boundary — forward snap
    // keeps the tail small (no over-extension into the giant turn).
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

test('group pull-back drags the window to the head, then re-snaps quiescent', async () => {
  const inst = await bootIdle('grouppull');

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

  // A 5-event window ends deep in turn 2: the group pull drags start back to
  // the tu_bg head, and the re-snap lands on the quiescent point at/below it
  // — head + every child in ONE page.
  const page = await pageInstanceEvents(inst, { limit: 5 });
  assert.ok(page.events.some(e => e.kind === 'tool_use' && e.toolUseId === 'tu_bg'),
    'the owning head is inside the page (group integrity)');
  const childIdx = page.events.findIndex(e => e.parentToolUseId === 'tu_bg');
  const headIdx = page.events.findIndex(e => e.toolUseId === 'tu_bg');
  assert.ok(headIdx !== -1 && headIdx < childIdx, 'head precedes its children in-page');
  assert.equal(page.events.filter(e => e.parentToolUseId === 'tu_bg').length, 6,
    'ALL children in the same page — the group is never split');
});

test('seam forced mid-Task: interleaved sub-agent parts never split across pages', async () => {
  // First-class async-interleaving case: a backgrounded sub-agent emits its
  // block parts BETWEEN the outer turn's parts. However small the window,
  // no page may hold a child without its head, and both the outer and the
  // nested blocks must be whole per page.
  const inst = await bootIdle('midtask');

  inst._emitUi({ kind: 'user_echo', text: 'kick off' });
  inst._emitUi({ kind: 'tool_use_start', msgId: 'mH', blockIdx: 0, toolUseId: 'T', name: 'Task' });
  inst._emitUi({ kind: 'tool_use', msgId: 'mH', blockIdx: 0, toolUseId: 'T', name: 'Task', input: { description: 'bg' } });
  inst._emitUi({ kind: 'tool_result', toolUseId: 'T', content: 'running in background', isError: false });
  inst._emitUi({ kind: 'turn_end', subtype: 'success' });
  inst._emitUi({ kind: 'user_echo', text: 'next question' });
  // Outer text parts interleaved with nested finals-only parts.
  inst._emitUi({ kind: 'text_delta', msgId: 'mO', blockIdx: 0, text: 'outer part 1 ' });
  inst._emitUi({ kind: 'assistant_message', msgId: 'cm1', parentToolUseId: 'T',
    message: { id: 'cm1', content: [{ type: 'text', text: 'nested text' }] } });
  inst._emitUi({ kind: 'text_delta', msgId: 'mO', blockIdx: 0, text: 'outer part 2' });
  inst._emitUi({ kind: 'assistant_message', msgId: 'cm1', parentToolUseId: 'T',
    message: { id: 'cm1', content: [{ type: 'tool_use', id: 'ct1', name: 'Bash', input: { command: 'pwd' } }] } });
  inst._emitUi({ kind: 'text_end', msgId: 'mO', blockIdx: 0 });
  inst._emitUi({ kind: 'tool_result', toolUseId: 'ct1', content: '/root', isError: false, parentToolUseId: 'T' });
  inst._emitUi({ kind: 'turn_end', subtype: 'success' });
  inst._emitUi({ kind: 'user_echo', text: 'third turn' });
  inst._emitUi({ kind: 'text_delta', msgId: 'mZ', blockIdx: 0, text: 'closing' });
  inst._emitUi({ kind: 'text_end', msgId: 'mZ', blockIdx: 0 });
  inst._emitUi({ kind: 'turn_end', subtype: 'success' });

  for (const limit of [3, 4, 6]) {
    const pages = await pageAllPages(ctx, inst.id, { limit });
    for (let p = 0; p < pages.length; p++) {
      assertPageIntegrity(pages[p], `limit=${limit} page[${p}]`);
    }
    // The whole T group (head + interleaved children) sits in exactly one page.
    const withChildren = pages.filter(pg => pg.some(e => e.parentToolUseId === 'T'));
    assert.equal(withChildren.length, 1, `limit=${limit}: group in exactly one page`);
    const g = withChildren[0];
    assert.ok(g.some(e => e.kind === 'tool_use' && e.toolUseId === 'T'), `limit=${limit}: head with its children`);
    assert.equal(g.filter(e => e.parentToolUseId === 'T').length, 3,
      `limit=${limit}: all three child parts together`);
    // The outer block whose parts interleave with the children is whole too.
    assert.ok(g.some(e => e.kind === 'text_delta' && e.msgId === 'mO')
      && g.some(e => e.kind === 'text_end' && e.msgId === 'mO'),
      `limit=${limit}: interleaved outer block whole in the same page`);
    // Coverage stays exact.
    const all = pages.slice().reverse().flat().filter(e => e._seq != null);
    assert.deepEqual(all.map(e => e._seq), inst.ringSnapshot().map(e => e._seq));
  }
});

test('real async round-trip (scenario-background-task): pages and tail stay self-contained', async () => {
  // Real subprocess path: the fake CLI emits an Agent tool_use whose
  // tool_result returns async ("running in the background"), then turn_end
  // and a trailing task_updated. Page it with a tiny window: the async tool
  // span must never split.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_BACKGROUND_TASK;
  let inst;
  try {
    inst = await bootIdle('bgtaskreal');
    inst.prompt('kick off a background agent');
    // The scenario's trailing task_updated lands AFTER turn_end (spaced by
    // delay_ms) — wait it out so the ring is stable before paging.
    await waitFor(() => inst.status === 'idle'
      && inst.ringSnapshot().some(e => e.kind === 'system' && e.subtype === 'task_updated'));
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }

  const pages = await pageAllPages(ctx, inst.id, { limit: 3 });
  for (let p = 0; p < pages.length; p++) {
    assertPageIntegrity(pages[p], `bg page[${p}]`);
  }
  // The Agent tool_use and its async tool_result share a page.
  const toolPage = pages.find(pg => pg.some(e => e.kind === 'tool_use' && e.toolUseId === 'tu_agent1'));
  assert.ok(toolPage, 'agent head served');
  assert.ok(toolPage.some(e => e.kind === 'tool_result' && e.toolUseId === 'tu_agent1'),
    'async tool_result in the same page as its tool_use');
  const all = pages.slice().reverse().flat().filter(e => e._seq != null);
  assert.deepEqual(all.map(e => e._seq), inst.ringSnapshot().map(e => e._seq));
});
