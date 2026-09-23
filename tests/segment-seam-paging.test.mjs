// Paging a LIVE instance whose backing jsonl rotated underneath it (a managed
// renew or a typed `/clear`). The ring and its echo ordinals run on across the
// rotation while the archive replays only the CURRENT segment's file, so the
// pager must (1) never cut the current file against ordinals from another
// segment, (2) calibrate the live→file ordinal offset from content, and (3) mark
// evicted earlier-segment events with one honest floor `history_gap`.
//
// Vocabulary used below:
//   case A — the ring head predates the current segment: no archive is loaded.
//   case B — the ring head is inside the current segment: its file is cut at
//            the head with the calibrated offset.
//   floor  — the marker for evicted EARLIER-segment events, before the first
//            event this pager can serve.
//   seam   — the existing marker between the archive cut and the ring head,
//            for current-segment history the cut could not reach.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { segmentsFor } from '../src/sessionLineage.ts';
import { buildArchive, pagePersistedEvents } from '../src/eventArchive.ts';
import { adoptProject, localPlace } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { reconstructTasks } from '../src/taskReconstruct.ts';
import {
  RENEW_HEAD, segmentTurns, bootLiveAcrossSeams, rotate, replaySlice, emitLive, crossSeam,
  writeSegmentFile, withRingCap,
} from './segmentChain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const MIRROR_FIXTURE = path.join(__dirname, 'fixtures', 'mirrorFixtureProvider.mjs');

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

const PRE = 'aaaa0471-0000-4000-8000-000000000001';
const POST = 'bbbb0471-0000-4000-8000-000000000002';
const THIRD = 'cccc0471-0000-4000-8000-000000000003';
const PUBLIC = PRE.slice(0, 8);

// Loaded per call, not statically: this file must link on a tree without the
// export so every other test reds through its own assertions there.
async function currentSegmentScope(inst) {
  return (await import('../src/eventArchive.ts')).currentSegmentScope(inst);
}

const GAP = 'history_gap';
const isGap = (e) => e.kind === GAP;
const gapCount = (evs) => evs.filter(isGap).length;
const textsOf = (evs, kind) => evs.filter(e => e.kind === kind).map(e => e.text);

// Page backward from the tail until hasMore goes false; oldest-first.
async function pageAll(id, { limit = 7 } = {}) {
  let all = [];
  let cursor;
  for (let i = 0; i < 200; i++) {
    const q = cursor == null ? `?limit=${limit}` : `?before=${cursor}&limit=${limit}`;
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events${q}`);
    assert.equal(r.status, 200);
    all = r.body.events.concat(all);
    if (!r.body.hasMore) return all;
    cursor = r.body.nextBefore;
  }
  throw new Error('pageAll: cursor never terminated');
}

// Page forward with REST `after=` (exclusive) from `after` until hasMore is false.
async function forwardAll(id, { after = -1, limit = 7 } = {}) {
  let all = [];
  let cursor = after;
  for (let i = 0; i < 200; i++) {
    const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?after=${cursor}&limit=${limit}`);
    assert.equal(r.status, 200);
    all = all.concat(r.body.events);
    if (!r.body.hasMore) return all;
    const seqs = r.body.events.filter(e => typeof e._seq === 'number');
    cursor = seqs[seqs.length - 1]._seq;
  }
  throw new Error('forwardAll: cursor never terminated');
}

// The client collapses the seam marker's known backward double
// (`[…, GAP][GAP, …]` when a page start snaps exactly onto the seam) into one
// divider; positional assertions read the walk the way the client renders it.
function collapseGaps(evs) {
  return evs.filter((e, i) => !(isGap(e) && i > 0 && isGap(evs[i - 1])));
}

let nextRpcId = 1;
async function getTranscript(args) {
  const res = await fetch(ctx.baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name: 'get_transcript', arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `get_transcript returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

// Forward walk over live get_transcript from `fromSeq`, following `nextFrom`.
async function mcpForwardAll(sessionId, { fromSeq = 0, limit = 7 } = {}) {
  let all = [];
  let from = fromSeq;
  for (let i = 0; i < 200; i++) {
    const page = await getTranscript({ sessionId, fromSeq: from, limit });
    assert.equal(page.source, 'ring', 'a live instance is read from the ring');
    all = all.concat(page.events);
    if (!page.hasMore) return all;
    from = page.nextFrom;
  }
  throw new Error('mcpForwardAll: cursor never terminated');
}

// Case A fixture: 12 `pre` turns, then a live renew onto a 1-turn `post`.
async function bootCaseA(project) {
  return bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 10,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 12) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 1) },
    ],
  });
}

function assertCaseAPreconditions(inst) {
  const ring = inst.ringSnapshot();
  const tb = inst.ring.trimmedBefore;
  assert.ok(tb > 0, 'precondition: the ring trimmed');
  assert.equal(ring[0].kind, 'user_echo', 'precondition: the ring head is an echo');
  assert.match(ring[0].text, /^pre prompt /, 'precondition: the ring head predates the renew');
  assert.ok(ring.some(e => e.kind === 'user_echo' && e.text === 'post prompt 0'), 'precondition: the ring holds a post echo');
  return { ring, tb };
}

// Case B fixture: 3 `pre` turns, then a live renew onto a 12-turn `post`.
async function bootCaseB(project) {
  return bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 10,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 3) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 12) },
    ],
  });
}

function assertCaseBPreconditions(inst) {
  const ring = inst.ringSnapshot();
  assert.ok(!ring.some(e => e.kind === 'user_echo' && /^pre prompt /.test(e.text)), 'precondition: no pre echo in the ring');
  assert.equal(ring[0].kind, 'user_echo', 'precondition: the ring head is an echo');
  const k = Number(/^post prompt (\d+)$/.exec(ring[0].text)?.[1]);
  assert.ok(k > 0, `precondition: the ring head is post prompt k>0 (got ${ring[0].text})`);
  return { ring, k, tb: inst.ring.trimmedBefore };
}

// Every `post i` prompt and reply, i in [0, n), served exactly once and in order.
function assertPostOnceInOrder(all, n) {
  assert.deepEqual(textsOf(all, 'user_echo').filter(t => /^post prompt /.test(t)),
    Array.from({ length: n }, (_, i) => `post prompt ${i}`), 'every post prompt exactly once, in order');
  assert.deepEqual(textsOf(all, 'text_delta').filter(t => /^post reply /.test(t)),
    Array.from({ length: n }, (_, i) => `post reply ${i}`), 'every post reply exactly once, in order');
}

test('T1 case A backward: the ring head predates the renew — no other segment is spliced above it, one floor marker', async () => {
  const { inst, id } = await bootCaseA('t1');
  const { ring } = assertCaseAPreconditions(inst);

  const all = await pageAll(id);
  assertPostOnceInOrder(all, 1);
  const lastPre = all.findLastIndex(e => /^pre /.test(e.text ?? ''));
  const firstPost = all.findIndex(e => /^post /.test(e.text ?? ''));
  assert.ok(lastPre < firstPost, 'all pre content precedes all post content');
  // Real: pre-renew events [0, tb) were evicted from the ring, and the current
  // file cannot serve them.
  assert.equal(all[0].kind, GAP, 'the walk opens on the floor marker');
  assert.equal(all[1]._seq, ring[0]._seq, 'directly followed by the ring head');
  assert.equal(gapCount(all), 1, 'and there is no other marker');
});

test('T2 case B backward: the current file is cut at the ring head with the offset measured from content', async () => {
  const { inst, id, crossed } = await bootCaseB('t2');
  const { ring, k } = assertCaseBPreconditions(inst);
  // Production live shape at the seam: the rotation init, then the first REAL
  // prompt — the live ring never carries RENEW_HEAD's replay-only echoes, so the
  // live ordinal of `post i` differs from its file ordinal and only a measured
  // offset cuts the file at the ring head.
  const headTexts = new Set(RENEW_HEAD.map(r => r.message?.content).filter(Boolean));
  assert.equal(crossed[0][0].subtype, 'init', 'precondition: the crossing opens on the rotation init');
  assert.equal(crossed[0][1].text, 'post prompt 0', 'precondition: directly followed by the first real prompt');
  assert.ok(!crossed[0].some(e => headTexts.has(e.text)), 'precondition: no RENEW_HEAD echo reached the live ring');
  const liveHead = ring[0].userIndex;
  assert.equal(liveHead, 3 + k, 'precondition: live ordinal of post k counts the 3 pre echoes');
  // Its file ordinal counts RENEW_HEAD's 2 echoes instead, so live ≠ file.

  const all = await pageAll(id);
  // Includes the evicted post turns, served from the file across RENEW_HEAD's
  // replay-only echoes — an ordinal rebase that ignores them lands off by their
  // count.
  assertPostOnceInOrder(all, 12);
  assert.ok(!all.some(e => /^pre /.test(e.text ?? '')), 'no pre content: its events were evicted and are not in this file');
  // Floor, real: the pre-renew ring events were evicted and this pager never
  // reads the pre file. It sits before the file's first event (the caveat echo).
  assert.equal(all[0].kind, GAP, 'the walk opens on the floor marker');
  assert.equal(all[1].kind, 'user_echo');
  assert.equal(all[1].text, RENEW_HEAD[0].message.content, 'directly followed by the file\'s first event');
  // No seam marker: the calibrated cut is exact, and it is not clamped because
  // tb − cut = <pre-renew ring events> + <the rotation init> − <RENEW_HEAD's
  // replay-only echoes>, and the pre span alone outnumbers those echoes.
  assert.equal(gapCount(all), 1, 'the floor is the only marker');
  const headAt = all.findIndex(e => e._seq === ring[0]._seq && e.kind === 'user_echo' && e.text === `post prompt ${k}`);
  assert.ok(headAt > 0, 'the ring head is served');
  assert.equal(all[headAt - 1].kind, 'text_end', 'the event before the ring head is post turn k−1\'s last event');
  assert.equal(all[headAt - 2].text, `post reply ${k - 1}`);
});

test('T3 live get_transcript shares the pager: forward walk from 0, default page, incremental poll', async (t) => {
  await t.test('case A', async () => {
    const { inst } = await bootCaseA('t3a');
    const { ring, tb } = assertCaseAPreconditions(inst);
    // (a) a forward walk from the floor carries the floor marker once, first.
    const walk = await mcpForwardAll(inst.sessionId);
    assertPostOnceInOrder(walk, 1);
    assert.equal(walk[0].kind, GAP, 'fromSeq 0 walk opens on the floor');
    assert.equal(walk[1]._seq, ring[0]._seq, 'directly followed by the ring head');
    assert.equal(gapCount(walk), 1);
    // (b) the default call is the newest backward page; on this fixture it
    // reaches combined[0], so it opens on the floor marker.
    const dflt = await getTranscript({ sessionId: inst.sessionId });
    assert.equal(dflt.events[0].kind, GAP);
    assert.equal(dflt.events[1]._seq, ring[0]._seq);
    assert.equal(gapCount(dflt.events), 1);
    // (c) an incremental poll from the ring head asks for nothing evicted.
    const poll = await getTranscript({ sessionId: inst.sessionId, fromSeq: tb });
    assert.equal(gapCount(poll.events), 0, 'a poll from the ring head carries no marker');
    assert.equal(poll.events[0]._seq, tb);
  });
  await t.test('case B', async () => {
    const { inst } = await bootCaseB('t3b');
    const { tb } = assertCaseBPreconditions(inst);
    const walk = await mcpForwardAll(inst.sessionId);
    assertPostOnceInOrder(walk, 12);
    assert.ok(!walk.some(e => /^pre /.test(e.text ?? '')));
    assert.equal(walk[0].kind, GAP, 'fromSeq 0 walk opens on the floor');
    assert.equal(walk[1].text, RENEW_HEAD[0].message.content, 'directly followed by the file\'s first event');
    assert.equal(gapCount(walk), 1);
    const dflt = await getTranscript({ sessionId: inst.sessionId });
    assert.equal(dflt.events[0].kind, GAP);
    assert.equal(dflt.events[1].text, RENEW_HEAD[0].message.content);
    assert.equal(gapCount(dflt.events), 1);
    const poll = await getTranscript({ sessionId: inst.sessionId, fromSeq: tb });
    assert.equal(gapCount(poll.events), 0, 'a poll from the ring head carries no marker');
    assert.equal(poll.events[0]._seq, tb);
  });
});

test('T3d case A forward from inside the evicted range: the requested window reaches evicted seqs, so it opens on the floor', async () => {
  const { inst, id } = await bootCaseA('t3d');
  const { ring, tb } = assertCaseAPreconditions(inst);
  assert.ok(tb >= 2, 'precondition: after = 0 lies in [0, tb − 2]');
  // after = 0 requests seqs from 1; seqs [1, tb) were evicted.
  const r = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?after=0&limit=7`);
  assert.equal(r.status, 200);
  assert.equal(r.body.events[0].kind, GAP, 'the floor marker is the page\'s first event');
  assert.equal(r.body.events[1]._seq, ring[0]._seq, 'directly followed by the ring head');
  assert.equal(gapCount(r.body.events), 1);
});

// T4/T5 fixture: 3 `pre` turns resumed live, then a renew onto a 12-turn `post`.
// The post file is seeded but not yet crossed: each test drives its own seam.
async function bootPreLive(project, ringCap) {
  const r = await bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap,
    segments: [{ id: PRE, reason: 'initial', records: segmentTurns('pre', 3) }],
  });
  await writeSegmentFile(r.place, { id: POST, reason: 'renew', records: segmentTurns('post', 12) });
  return r;
}

// Turn 5 runs on live past what the file recorded: its prompt and first reply
// are in the file, `live5`'s blocks are not. The ring trims inside `live5`.
async function bootMidTurnHead(project) {
  const r = await bootPreLive(project, 16);
  const { inst, place } = r;
  await rotate(inst, POST);
  await replaySlice(inst, place, POST, { to: 12 }); // post turns 0..5, through post 5's reply
  emitLive(inst, { msgId: 'live5', blocks: 10 });
  await replaySlice(inst, place, POST, { from: 12 }); // post turns 6..11
  const ring = inst.ringSnapshot();
  assert.equal(ring[0].kind, 'text_delta', 'precondition: the ring head is mid-turn');
  assert.equal(ring[0].msgId, 'live5', 'precondition: inside the live-only block run');
  assert.ok(ring.some(e => e.kind === 'user_echo' && e.text === 'post prompt 6'),
    'precondition: a later correlatable post turn is in the ring');
  return { ...r, ring, tb: inst.ring.trimmedBefore };
}


test('T4 case B, uncorrelated mid-turn head: calibrated fallback cut, floor and seam markers both placed', async () => {
  const { id, ring } = await bootMidTurnHead('t4');
  const all = collapseGaps(await pageAll(id));

  // Nothing duplicated. post reply 5 is the one current-segment loss: it lies
  // between the fallback cut (just after post 5's echo) and the ring head.
  assert.deepEqual(textsOf(all, 'user_echo').filter(t => /^post prompt /.test(t)),
    Array.from({ length: 12 }, (_, i) => `post prompt ${i}`), 'every post prompt exactly once, in order');
  assert.deepEqual(textsOf(all, 'text_delta').filter(t => /^post reply /.test(t)),
    Array.from({ length: 12 }, (_, i) => `post reply ${i}`).filter(t => t !== 'post reply 5'),
    'every other post reply exactly once, in order');
  const live = textsOf(all, 'text_delta').filter(t => /^live5 /.test(t));
  assert.equal(new Set(live).size, live.length, 'no live5 block served twice');
  assert.ok(!all.some(e => /^pre /.test(e.text ?? '')));

  assert.equal(gapCount(all), 2, 'two distinct losses, two markers');
  // Floor, real: the pre-renew ring events were evicted; it precedes the file's first event.
  assert.equal(all[0].kind, GAP);
  assert.equal(all[1].text, RENEW_HEAD[0].message.content);
  // Seam, real: the turn-5 span between post 5's echo and the live5 head is
  // gone from the ring and the file never had live5.
  const seam = all.findIndex((e, i) => i > 0 && isGap(e));
  assert.equal(all[seam - 1].kind, 'user_echo');
  assert.equal(all[seam - 1].text, 'post prompt 5', 'the seam marker follows post 5\'s echo');
  assert.equal(all[seam + 1]._seq, ring[0]._seq, 'and directly precedes the ring head');
});

test('T5 case B, nothing calibratable: nothing is served from the file, one marker before the ring head', async () => {
  const { inst, id, place } = await bootPreLive('t5', 10);
  const seamSeq = inst.ring.nextSeq;
  await rotate(inst, POST);
  for (let i = 0; i < 10; i++) emitLive(inst, { echo: `live prompt ${i}`, msgId: `live-m${i}`, blocks: 1 });
  const ring = inst.ringSnapshot();
  assert.ok(inst.ring.trimmedBefore > seamSeq, 'precondition: the ring trimmed past the seam');
  assert.equal(ring[0].kind, 'user_echo', 'precondition: the ring head is a live echo');
  assert.match(ring[0].text, /^live prompt /);
  assert.ok(place, 'the post file exists on disk');

  const all = await pageAll(id);
  assert.ok(!all.some(e => /^post /.test(e.text ?? '') || e.text === RENEW_HEAD[0].message.content),
    'no file content is served: no ring turn correlates, so no ordinal was measured');
  // Real: the earlier-segment events and the evicted live turns are adjacent
  // losses below the ring head, so one divider marks both.
  assert.equal(gapCount(all), 1, 'exactly one marker');
  assert.equal(all[0].kind, GAP);
  assert.equal(all[1]._seq, ring[0]._seq, 'directly before the ring head');
});

// jsonl record builders for the task fixtures (the shapes the real CLI persists).
const userText = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const asstToolUse = (uuid, msgId, tid, name, input) =>
  ({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
const asstText = (uuid, msgId, text) =>
  ({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] } });
const userToolResult = (uuid, toolUseId, content) =>
  ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }] } });
const taskView = (tasks) => tasks.map(t => ({ id: t.id, status: t.status, subject: t.subject }));

test('T6 reconstructActiveTasks, case A: no current-file task is folded into a pre-renew orphan update', async () => {
  const pre = [
    userText('p0', 'start'),
    asstToolUse('pa0', 'pm0', 'ptc', 'TaskCreate', { subject: 'Pre batch' }),
    userToolResult('pr0', 'ptc', 'Task #1 created successfully: Pre batch'),
    ...segmentTurns('pre', 8),
    userText('pF', 'please update'),
    asstToolUse('paF', 'pmF', 'ptu', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
  ];
  // The current file opens with turns the live ring never replays (its first
  // turn holds a TaskCreate), then one turn the ring does hold. That puts the
  // create below a calibrated cut taken at the pre-renew ring head: reading
  // this file for a head that predates it WOULD fold the create.
  const post = [
    userText('q0', 'post start'),
    asstToolUse('qa0', 'qm0', 'qtc', 'TaskCreate', { subject: 'Post batch' }),
    userToolResult('qr0', 'qtc', 'Task #1 created successfully: Post batch'),
    ...segmentTurns('unreplayed', 3),
    ...segmentTurns('post', 1),
  ];
  const liveFrom = 3 + 6; // record index of the `post` turn, after RENEW_HEAD
  const { inst } = await bootLiveAcrossSeams({
    ctx, project: 't6', publicId: PUBLIC, ringCap: 8,
    segments: [{ id: PRE, reason: 'initial', records: pre }],
  });
  await writeSegmentFile(inst.transcriptPlace, { id: POST, reason: 'renew', records: post });
  const seamSeq = inst.ring.nextSeq;
  await rotate(inst, POST);
  await replaySlice(inst, inst.transcriptPlace, POST, { from: liveFrom });

  const ring = inst.ringSnapshot();
  const below = ring.filter(e => e._seq < seamSeq);
  assert.ok(inst.ring.trimmedBefore > 0, 'precondition: eviction happened');
  assert.ok(ring[0]._seq < seamSeq, 'precondition: the ring head predates the renew');
  assert.ok(!ring.some(e => e.kind === 'tool_use' && e.toolUseId === 'ptc'), 'precondition: the pre TaskCreate was evicted');
  assert.ok(below.some(e => e.kind === 'tool_use' && e.toolUseId === 'ptu'), 'precondition: the pre TaskUpdate is ring-held below the seam');
  assert.equal(reconstructTasks(below).hadOrphanUpdate, true, 'precondition: the update is an orphan');
  // Discriminating precondition: the SAME read reconstructActiveTasks makes,
  // minus the case-A gate, folds the wrong segment's create into the update.
  const wrong = await buildArchive({
    place: inst.transcriptPlace, sessionId: POST, ring, trimmedBefore: inst.ring.trimmedBefore,
    userEchoCount: inst._userEchoCount, segmentStartSeq: seamSeq,
  });
  assert.deepEqual(taskView(reconstructTasks(wrong.events.slice(0, wrong.cut).concat(below)).activeAtEnd),
    [{ id: '1', status: 'in_progress', subject: 'Post batch' }],
    'precondition: an ungated read of the current file would fold its create');

  const active = await inst.reconstructActiveTasks(seamSeq);
  assert.deepEqual(active, reconstructTasks(below).activeAtEnd,
    'the result is the ring-only reconstruction — the post file never reaches a pre-renew update');
});

test('T7 seams partition the ring\'s seq space across two renews', async () => {
  const { inst, id, place } = await bootLiveAcrossSeams({
    ctx, project: 't7', publicId: PUBLIC, ringCap: 10,
    segments: [{ id: PRE, reason: 'initial', records: segmentTurns('pre', 3) }],
  });
  await writeSegmentFile(place, { id: POST, reason: 'renew', records: segmentTurns('post', 6) });
  await writeSegmentFile(place, { id: THIRD, reason: 'renew', records: segmentTurns('third', 1) });

  const s1 = inst.ring.nextSeq;
  await rotate(inst, POST);
  const init1 = inst.ringSnapshot().find(e => e._seq === s1);
  assert.equal(init1?.subtype, 'init');
  assert.equal(init1.data.session_id, POST, 'the event at s1 is the rotation init naming segment 1');
  await replaySlice(inst, place, POST);
  const s2 = inst.ring.nextSeq;
  await rotate(inst, THIRD);
  const init2 = inst.ringSnapshot().find(e => e._seq === s2);
  assert.equal(init2?.subtype, 'init');
  assert.equal(init2.data.session_id, THIRD, 'the event at s2 is the rotation init naming segment 2');
  await replaySlice(inst, place, THIRD);

  const expected = [{ segmentId: PRE, startSeq: 0 }, { segmentId: POST, startSeq: s1 }, { segmentId: THIRD, startSeq: s2 }];
  const tb = inst.ring.trimmedBefore;
  assert.ok(tb > s1 && tb < s2, `precondition: the ring head lies in [s1, s2) (tb=${tb}, s1=${s1}, s2=${s2})`);
  assert.deepEqual(inst.ring.seams, expected, 'one seam per segment, oldest first; s1 survives its own eviction');
  assert.equal(inst.ring.seams.at(-1).segmentId, inst.backingSessionId, 'the last seam names the current segment');
  const scope = await currentSegmentScope(inst);
  assert.equal(scope.segmentId, THIRD, 'the scope names the current segment (by the partition rule, backingSessionId)');
  assert.equal(scope.startSeq, s2);
  assert.equal(scope.archivable, false, 'a head in [s1, s2) predates the current segment');
  assert.equal(scope.priorEvicted, true);
  assert.deepEqual((await segmentsFor(PUBLIC)).map(g => [g.id, g.reason]),
    [[PRE, 'initial'], [POST, 'renew'], [THIRD, 'renew']], 'the lineage row equals the chain');

  // A head in [s1, s2) predates the current segment: no archive, floor first.
  const ring = inst.ringSnapshot();
  const all = await pageAll(id);
  assert.equal(all[0].kind, GAP);
  assert.equal(all[1]._seq, ring[0]._seq, 'the walk opens [GAP, <ring head>]');
  assert.equal(gapCount(all), 1);
  assert.deepEqual(all.filter(e => typeof e._seq === 'number').map(e => e._seq), ring.map(e => e._seq),
    'exactly the ring is served');

  for (let i = 0; i < 10; i++) emitLive(inst, { echo: `live prompt ${i}`, msgId: `live-m${i}`, blocks: 1 });
  assert.ok(inst.ring.trimmedBefore > s2, 'precondition: trims evicted both rotation inits');
  assert.deepEqual(inst.ring.seams, expected, 'seams are never renumbered or dropped by a trim');
});

test('T8 a wipe then a fill leaves exactly one seam at 0 for the current segment', async () => {
  const { inst, id } = await bootCaseA('t8');
  assertCaseAPreconditions(inst);
  await inst.kill({ graceMs: 50 });
  await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');
  const rs = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/respawn`);
  assert.equal(rs.status, 200);
  await waitFor(() => inst.status === 'idle');

  assert.deepEqual(inst.ring.seams, [{ segmentId: POST, startSeq: 0 }]);
  const all = await pageAll(id);
  assert.equal(gapCount(all), 0, 'a resumed segment pages with no marker');
  assert.deepEqual(textsOf(all, 'user_echo'), [RENEW_HEAD[0].message.content, RENEW_HEAD[1].message.content, 'post prompt 0'],
    'the current file, whole');
});

test('T9 a renewed session resumed cold pages its current file exactly as before', async () => {
  const segments = [
    { id: PRE, reason: 'initial', records: segmentTurns('pre', 3) },
    { id: POST, reason: 'renew', records: segmentTurns('post', 12) },
  ];
  const { inst, id } = await bootLiveAcrossSeams({ ctx, project: 't9', publicId: PUBLIC, ringCap: 10, segments, liveFrom: 1 });
  assert.ok(inst.ring.trimmedBefore > 0, 'precondition: the ring trimmed');
  assert.deepEqual(inst.ring.seams, [{ segmentId: POST, startSeq: 0 }]);

  const all = await pageAll(id);
  assert.equal(gapCount(all), 0, 'no marker');
  assert.deepEqual(textsOf(all, 'user_echo'),
    [RENEW_HEAD[0].message.content, RENEW_HEAD[1].message.content, ...Array.from({ length: 12 }, (_, i) => `post prompt ${i}`)],
    'the full current-file history, RENEW_HEAD echoes included');
  assertPostOnceInOrder(all, 12);
});

test('T10 fresh spawn → prune → live renew: the fill seam names the pruned segment', async () => {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 't10' });
  const id = await withRingCap(8, async () => {
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 't10', mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    return r.body.id;
  });
  const inst = ctx.instances.get(id);
  await waitFor(() => inst.status === 'idle');
  const spawnSid = inst.backingSessionId;
  await writeSegmentFile(inst.transcriptPlace, { id: spawnSid, reason: 'initial', records: segmentTurns('orig', 10) });

  const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 1 });
  assert.equal(pr.status, 200, JSON.stringify(pr.body));
  await waitFor(() => inst.status === 'idle');
  const prunedSid = pr.body.newSessionId;
  assert.notEqual(prunedSid, spawnSid);
  assert.equal(inst.backingSessionId, prunedSid);

  await writeSegmentFile(inst.transcriptPlace, { id: POST, reason: 'renew', records: segmentTurns('post', 1) });
  const s = inst.ring.nextSeq;
  await crossSeam(inst, { id: POST, place: inst.transcriptPlace });

  assert.deepEqual(inst.ring.seams, [{ segmentId: prunedSid, startSeq: 0 }, { segmentId: POST, startSeq: s }]);
  const ring = inst.ringSnapshot();
  const tb = inst.ring.trimmedBefore;
  assert.ok(tb > 0 && tb < s, `precondition: the ring head lies below the renew seam (tb=${tb}, s=${s})`);
  const owner = (seq) => inst.ring.seams.findLast(m => m.startSeq <= seq).segmentId;
  for (const e of ring.filter(e => e._seq < s)) assert.equal(owner(e._seq), prunedSid, `seq ${e._seq} belongs to the pruned segment`);

  const all = await pageAll(id);
  assert.equal(all[0].kind, GAP);
  assert.equal(all[1]._seq, ring[0]._seq, 'the walk opens [GAP, <ring head>]');
  assert.equal(gapCount(all), 1);
});

test('T11 reachable forward shapes around a seam marker (T4 fixture)', async () => {
  const { id, tb } = await bootMidTurnHead('t11');
  const back = collapseGaps(await pageAll(id));
  const seam = back.findIndex((e, i) => i > 0 && isGap(e));
  const lastArchiveSeq = back[seam - 1]._seq;
  assert.equal(typeof lastArchiveSeq, 'number', 'precondition: the seam marker follows an archive event');

  // (a) after = the last archive event: servedStart === cut, so the seam marker
  // opens the page, and the floor is never appended by the forward backstop.
  const a = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/events?after=${lastArchiveSeq}&limit=7`);
  assert.equal(a.status, 200);
  assert.equal(a.body.events[0].kind, GAP, 'the seam marker at offset 0');
  assert.equal(a.body.events[1]._seq, tb, 'directly followed by the ring head');
  assert.equal(gapCount(a.body.events), 1, 'exactly one marker — none appended at the end');
  const walkA = await forwardAll(id, { after: lastArchiveSeq });
  assert.equal(gapCount(walkA), 1, 'the whole forward walk from there carries only the seam marker');
  assert.equal(walkA[0].kind, GAP);

  // (b) after = tb: above everything evicted, zero markers.
  const b = await forwardAll(id, { after: tb });
  assert.equal(gapCount(b), 0);
});

test('T12 ring content emitted before the first spawn belongs to the fill segment: seam at 0, no floor, file archivable', async () => {
  // A remote project whose advertised excludes sit outside its mirror root: the
  // create path reports each on the session stream BEFORE launch(), so the ring
  // holds events before spawn() writes the fill seam. There is no earlier
  // backing segment, so no floor marker may appear and the current file must
  // stay archivable.
  const sys = 'seam-remote';
  try {
    const box = await fs.realpath(await mkdtemp('cc-seam-remote-'));
    const tree = await seedRepo(path.join(box, 'nest', 'app'));
    const mirrorFile = path.join(box, '.mirror');
    await fs.writeFile(mirrorFile, path.join(box, 'nest'));
    const excludes = ['/var/lib/elsewhere-a', '/var/lib/elsewhere-b', '/var/lib/elsewhere-c'];
    await addSystem({ id: sys, label: sys, launch: ['node', MIRROR_FIXTURE, '--mirror-file', mirrorFile,
      ...excludes.flatMap(x => ['--advertise-exclude', x])] });
    assert.equal((await adoptProject('app', tree, { system: sys })).ok, true);

    const id = await withRingCap(10, async () => {
      const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id;
    });
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    const head = inst.ringSnapshot()[0];
    assert.equal(head._seq, 0, 'precondition: nothing trimmed yet');
    assert.equal(head.subtype, 'stderr', 'precondition: the ring opens on a pre-spawn diagnostic');
    assert.match(head.data.line, /no effect/);

    const backing = inst.backingSessionId;
    await writeSegmentFile(inst.transcriptPlace, { id: backing, reason: 'initial', records: segmentTurns('cur', 12) });
    await replaySlice(inst, inst.transcriptPlace, backing, { headSkip: false });
    assert.ok(inst.ring.trimmedBefore > 0, 'precondition: the ring trimmed');
    assert.ok(!inst.ringSnapshot().some(e => e.text === 'cur prompt 0'), 'precondition: early turns were evicted');

    const all = await pageAll(id);
    assert.equal(gapCount(all), 0, 'no floor marker: there is no earlier segment');
    assert.deepEqual(textsOf(all, 'user_echo'), Array.from({ length: 12 }, (_, i) => `cur prompt ${i}`),
      'the evicted turns are served from the current file, each once, in order');
    assert.deepEqual(textsOf(all, 'text_delta'), Array.from({ length: 12 }, (_, i) => `cur reply ${i}`));
    assert.deepEqual(inst.ring.seams, [{ segmentId: backing, startSeq: 0 }], 'the first seam starts at 0');
    const scope = await currentSegmentScope(inst);
    assert.equal(scope.archivable, true, 'the current file is archivable');
    assert.equal(scope.segmentId, backing, 'the scope names the fill segment');
    assert.equal(scope.priorEvicted, false);
  } finally {
    disposeSystemHandles();
  }
});

test('T13 a disk read (pagePersistedEvents) never marks a floor', async () => {
  // A retired session has no ring and so no evicted earlier-segment history:
  // even a renew-shaped file pages whole, with zero markers.
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 't13' });
  const place = localPlace(path.join(ctx.projectsRoot, 't13'));
  await writeSegmentFile(place, { id: POST, reason: 'renew', records: segmentTurns('post', 12) });
  let all = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const page = await pagePersistedEvents({ place, sessionId: POST, before: cursor, limit: 7 });
    all = page.events.concat(all);
    if (!page.hasMore) break;
    cursor = page.nextBefore;
  }
  assert.equal(gapCount(all), 0, 'no history_gap on a disk walk');
  assert.deepEqual(textsOf(all, 'user_echo'),
    [RENEW_HEAD[0].message.content, RENEW_HEAD[1].message.content, ...Array.from({ length: 12 }, (_, i) => `post prompt ${i}`)]);
  assert.equal(all[0].text, RENEW_HEAD[0].message.content, 'the walk opens on the file\'s first event');
});

test('T14 reconstructActiveTasks, case B: the current file is cut with the calibrated offset', async () => {
  // One pre echo against RENEW_HEAD's two: the file ordinal of every post turn
  // is one ABOVE its live ordinal, so an uncalibrated cut stops one turn early —
  // exactly at the turn holding the TaskCreate the ring evicted.
  const post = [
    ...segmentTurns('fill', 10),
    userText('mk', 'make batch'),
    asstToolUse('mka', 'mkm', 'qtc', 'TaskCreate', { subject: 'Post batch' }),
    userToolResult('mkr', 'qtc', 'Task #1 created successfully: Post batch'),
    userText('up', 'please update'),
    asstToolUse('upa', 'upm', 'qtu', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    asstText('r0', 'upm0', 'working 0'), asstText('r1', 'upm1', 'working 1'), asstText('r2', 'upm2', 'working 2'),
  ];
  const { inst, crossed } = await bootLiveAcrossSeams({
    ctx, project: 't14', publicId: PUBLIC, ringCap: 8,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 1) },
      { id: POST, reason: 'renew', records: post },
    ],
  });
  const ring = inst.ringSnapshot();
  const tb = inst.ring.trimmedBefore;
  assert.equal(ring[0].text, 'please update', 'precondition: the ring head is the update turn\'s echo');
  assert.ok(!ring.some(e => e.kind === 'tool_use' && e.toolUseId === 'qtc'), 'precondition: the TaskCreate was evicted');
  assert.equal(reconstructTasks(ring).hadOrphanUpdate, true, 'precondition: the update is a ring orphan');
  const initSeq = crossed[0][0]._seq;
  assert.equal(crossed[0][0].subtype, 'init');
  assert.ok(tb > initSeq, 'precondition: the head is inside the current segment');
  // Discriminating precondition: the aligned-ordinal cut misses the create.
  const aligned = await buildArchive({
    place: inst.transcriptPlace, sessionId: POST, ring, trimmedBefore: tb, userEchoCount: inst._userEchoCount,
  });
  assert.deepEqual(reconstructTasks(aligned.events.slice(0, aligned.cut).concat(ring)).activeAtEnd, [],
    'precondition: an uncalibrated cut stops before the create');

  const active = await inst.reconstructActiveTasks(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(taskView(active), [{ id: '1', status: 'in_progress', subject: 'Post batch' }],
    'the evicted create is recovered from the current file');
});

test('T15 buildArchive: no outer echo before the first correlatable event means no offset — cut 0, gap, no throw', async () => {
  // A giant-turn trim can evict every echo: the ring is text blocks only.
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 't15' });
  const place = localPlace(path.join(ctx.projectsRoot, 't15'));
  await writeSegmentFile(place, { id: POST, reason: 'renew', records: segmentTurns('post', 4) });
  const ring = [
    { kind: 'text_delta', msgId: 'live-only', blockIdx: 0, text: 'x', parentToolUseId: null, _seq: 20 },
    { kind: 'text_end', msgId: 'live-only', blockIdx: 0, parentToolUseId: null, _seq: 21 },
    // Correlatable into the file, but no echo precedes it in the ring.
    { kind: 'text_delta', msgId: 'post-m3', blockIdx: 0, text: 'post reply 3', parentToolUseId: null, _seq: 22 },
    { kind: 'text_end', msgId: 'post-m3', blockIdx: 0, parentToolUseId: null, _seq: 23 },
  ];
  const archive = await buildArchive({ place, sessionId: POST, ring, trimmedBefore: 20, userEchoCount: 7, segmentStartSeq: 5 });
  assert.equal(archive.cut, 0, 'nothing is served from the file');
  assert.equal(archive.gap, true, 'the loss is marked');
  assert.ok(archive.events.length > 0, 'the file itself was read');
});

test('T16 currentSegmentScope: the archivable boundary, and the segment named by the seams', async () => {
  const scope = (seams, tb, backingSessionId) => currentSegmentScope({ ring: { trimmedBefore: tb, seams }, backingSessionId });
  const seams = [{ segmentId: 'seg-a', startSeq: 0 }, { segmentId: 'seg-b', startSeq: 7 }];
  // tb === startSeq: the ring head IS the rotation init, inside the segment.
  assert.deepEqual(await scope(seams, 7, 'seg-b'), { segmentId: 'seg-b', startSeq: 7, archivable: true, priorEvicted: true });
  assert.deepEqual(await scope(seams, 6, 'seg-b'), { segmentId: 'seg-b', startSeq: 7, archivable: false, priorEvicted: true });
  // segmentId comes from the seams, not from backingSessionId.
  assert.equal((await scope(seams, 7, 'other')).segmentId, 'seg-b');
  // Before the first spawn: no seams — the backing id, from seq 0.
  assert.deepEqual(await scope([], 0, 'seg-a'), { segmentId: 'seg-a', startSeq: 0, archivable: true, priorEvicted: false });
  assert.equal((await scope(seams, 7, null)).archivable, false, 'no backing session, nothing to read');
});
