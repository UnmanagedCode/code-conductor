// The lineage scroll-back route (GET /api/instances/:id/lineage-events,
// src/lineagePager.ts): the web UI pages a session backward past the start of
// its current backing segment into every earlier segment of its lineage, each
// served by the SAME single-segment pager MCP reads it with. Parity with MCP is
// the proof that the walk adds no second paging path; the shapes pin the walk's
// prune-skip, tombstone and marker rules; the WS tests pin the dividers and the
// authoritative current segment the client keys rewind/fork on.
//
// Vocabulary: `H` is the segment owning the ring head; the "view" is H's
// file cut at the ring head as it stood before the rotation that superseded it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { assertNull } from './dom-assert.mjs';
import { pageInstanceEvents, pagePersistedEvents, currentSegmentScope } from '../src/eventArchive.ts';
import { adoptProject, localPlace } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import {
  RENEW_HEAD, segmentTurns, bootLiveAcrossSeams, rotate, replaySlice, emitLive, crossSeam, writeSegmentFile,
  seedSegmentChain, withRingCap, writeLineageRow, stubbedCopy, mcpTool, walkLineage, splitAtSeams, isGap, newExport,
} from './segmentChain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const MIRROR_FIXTURE = path.join(__dirname, 'fixtures', 'mirrorFixtureProvider.mjs');
const SEAM_MSG = 'segment is not an older segment of this session';

let ctx;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); });
after(async () => { await ctx.close(); });

// Per-test isolation WITHOUT file-level hooks: node:test runs those around
// every subtest too, which would tear down a fixture that a test's subtests
// share.
function wtest(name, fn) {
  test(name, async (t) => {
    const r = await freshProjectsRoot();
    ctx.projectsRoot = r.projectsRoot;
    try { await fn(t); } finally {
      await ctx.instances.shutdown();
      await rmrf(r.home);
    }
  });
}

// W1's four-segment chain: A initial, B renew, C a prune of B, D renew (current).
const A = 'a0a00472-0000-4000-8000-00000000000a';
const B = 'b0b00472-0000-4000-8000-00000000000b';
const C = 'c0c00472-0000-4000-8000-00000000000c';
const D = 'd0d00472-0000-4000-8000-00000000000d';
const P = A.slice(0, 8);
// The live-rotation fixtures' segments.
const PRE = 'aaaa0472-0000-4000-8000-000000000001';
const POST = 'bbbb0472-0000-4000-8000-000000000002';
const THIRD = 'cccc0472-0000-4000-8000-000000000003';
const PUBLIC = PRE.slice(0, 8);

const GAP = 'history_gap';
const gapCount = (evs) => evs.filter(isGap).length;
const textsOf = (evs, kind) => evs.filter(e => e.kind === kind).map(e => e.text);
const json = (v) => JSON.parse(JSON.stringify(v));
// Replay stamps every tool_result's `finishedAt` with the wall clock of the READ
// (parser.ts consolidateUserContent), so two reads of one file differ there and
// nowhere else; parity compares everything but it.
const unclocked = (evs) => evs.map(({ finishedAt, ...e }) => e);

// jsonl record builders (the shapes the real CLI persists).
const userText = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const asstText = (uuid, msgId, text) =>
  ({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] } });
const asstToolUse = (uuid, msgId, tid, name, input) =>
  ({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
const userToolResult = (uuid, toolUseId, content) =>
  ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }] } });

// A completed one-task batch.
const taskBatch = (tag) => [
  userText(`${tag}-tq`, `${tag} make tasks`),
  asstToolUse(`${tag}-tca`, `${tag}-tcm`, `${tag}-tc`, 'TaskCreate', { subject: `${tag} batch` }),
  userToolResult(`${tag}-tcr`, `${tag}-tc`, `Task #1 created successfully: ${tag} batch`),
  asstToolUse(`${tag}-tua`, `${tag}-tum`, `${tag}-tu`, 'TaskUpdate', { taskId: '1', status: 'completed' }),
  userToolResult(`${tag}-tur`, `${tag}-tu`, 'Updated task #1 status'),
];

const B_RECORDS = [
  ...segmentTurns('b', 3),
  userText('b-tq', 'b run the tool'),
  asstToolUse('b-ta', 'b-tm', 'b-tu', 'Bash', { command: 'cat notes' }),
  userToolResult('b-tr', 'b-tu', 'B-ORIGINAL-OUTPUT'),
];

function w1Segments({ dRecords = segmentTurns('d', 3) } = {}) {
  return [
    { id: A, reason: 'initial', records: [...taskBatch('a'), ...segmentTurns('a', 3)] },
    { id: B, reason: 'renew', records: B_RECORDS },
    { id: C, reason: 'prune', records: [...stubbedCopy([...RENEW_HEAD, ...B_RECORDS], '[pruned]'), ...segmentTurns('c', 2)] },
    { id: D, reason: 'renew', records: dRecords },
  ];
}

// Resume W1's chain on D. `mcp.A`/`mcp.C` are each segment's MCP read captured
// while no instance exists: once D is live, every segment id answers to it.
async function bootW1(project, opts) {
  const mcp = {};
  const r = await bootLiveAcrossSeams({
    ctx, project, publicId: P, segments: w1Segments(opts), liveFrom: 3,
    beforeResume: async () => {
      for (const [k, sid] of [['A', A], ['C', C]]) {
        mcp[k] = await mcpTool(ctx, 'get_transcript', { sessionId: sid, limit: 500 });
        assert.equal(mcp[k].source, 'disk', `precondition: ${k} is read from its own file`);
        assert.equal(mcp[k].hasMore, false);
      }
    },
  });
  return { ...r, mcp };
}

// `[x]` per run of content tagged `x prompt i`, `‖S` per divider, `⋯` per gap.
function render(events, names) {
  const out = [];
  for (const e of events) {
    let tok = null;
    if (e.kind === 'segment_seam') tok = `‖${names[e.segmentId] ?? e.segmentId}`;
    else if (isGap(e)) tok = '⋯';
    else if (e.kind === 'user_echo') {
      const m = /^(\w+) prompt \d+$/.exec(e.text ?? '');
      if (m) tok = `[${m[1]}]`;
    }
    if (tok && !(tok.startsWith('[') && out[out.length - 1] === tok)) out.push(tok);
  }
  return out.join(' ');
}

// Every `tag prompt i` and `tag reply i`, i in [0, n), exactly once and in order.
function assertOnceInOrder(evs, tag, n) {
  const re = (w) => new RegExp(`^${tag} ${w} \\d+$`);
  assert.deepEqual(textsOf(evs, 'user_echo').filter(t => re('prompt').test(t)),
    Array.from({ length: n }, (_, i) => `${tag} prompt ${i}`), `every ${tag} prompt exactly once, in order`);
  assert.deepEqual(textsOf(evs, 'text_delta').filter(t => re('reply').test(t)),
    Array.from({ length: n }, (_, i) => `${tag} reply ${i}`), `every ${tag} reply exactly once, in order`);
}

// The pages a walk requested in segment space `H`, their events oldest-first.
function spaceEvents(walk, H) {
  const out = [];
  for (let i = walk.pages.length - 1; i >= 0; i--) if (walk.cursors[i].segment === H) out.push(...walk.pages[i].events);
  return out;
}

async function getLineage(id, q) {
  return api(ctx.baseUrl, 'GET', `/api/instances/${id}/lineage-events${q}`);
}

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.wsUrl);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* not json */ } });
    ws.once('open', () => resolve({
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}
const isInitFrame = (m, sid) => m.t === 'event' && m.ev?.kind === 'system' && m.ev?.subtype === 'init'
  && (sid == null || m.ev?.data?.session_id === sid);

// Case A: 12 `pre` turns, then a live renew onto a 1-turn `post` (ring head in PRE).
function bootCaseA(project, opts = {}) {
  return bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 10, ...opts,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 12) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 1) },
    ],
  });
}
// Case B: 3 `pre` turns, then a live renew onto a 12-turn `post` (ring head in POST).
function bootCaseB(project) {
  return bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 10,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 3) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 12) },
    ],
  });
}
// Three live segments: the ring head in the middle one.
function bootThreeLive(project, opts = {}) {
  return bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 10, ...opts,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 3) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 6) },
      { id: THIRD, reason: 'renew', records: segmentTurns('third', 1) },
    ],
  });
}
function assertThreeLivePreconditions(inst) {
  const [, s1, s2] = inst.ring.seams.map(s => s.startSeq);
  const tb = inst.ring.trimmedBefore;
  assert.ok(s1 <= tb && tb < s2, `precondition: the ring head lies in [s1, s2) (tb=${tb}, s1=${s1}, s2=${s2})`);
  return { tb, s1, s2 };
}

wtest('W1 segment parity: each served segment equals its own MCP read, _seq included (renew/prune/renew)', async () => {
  const { id, mcp } = await bootW1('w1');
  const mcpD = await mcpTool(ctx, 'get_transcript', { sessionId: P, limit: 500 });
  assert.equal(mcpD.source, 'ring');
  assert.equal(mcpD.hasMore, false);

  const walk = await walkLineage(ctx, id, { limit: 7 });
  const runs = splitAtSeams(walk.events);
  assert.deepEqual(runs.map(r => r.label), [null, C, D], 'A, then C (B is its pruned original), then D');
  assert.deepEqual(unclocked(runs[0].events), unclocked(mcp.A.events), 'A equals get_transcript(A)');
  assert.deepEqual(unclocked(runs[1].events), unclocked(mcp.C.events), 'C equals get_transcript(C)');
  assert.deepEqual(unclocked(runs[2].events), unclocked(mcpD.events), 'D equals get_transcript(<public id>)');
  assertOnceInOrder(walk.events, 'a', 3);
  for (const [run, name] of [[runs[0], 'A'], [runs[1], 'C']]) {
    const results = run.events.filter(e => e.kind === 'tool_result');
    assert.ok(results.length > 0, `precondition: ${name} has tool results`);
    for (const e of results) assert.equal(typeof e.finishedAt, 'number', `${name}'s served tool_result keeps its finishedAt`);
  }
  assert.ok(!JSON.stringify(walk.events).includes('B-ORIGINAL-OUTPUT'), 'the pruned original is never read');
  assert.deepEqual(textsOf(walk.events, 'user_echo').filter(t => /^b prompt /.test(t)),
    ['b prompt 0', 'b prompt 1', 'b prompt 2'], 'B\'s prompts once, through C');
});

wtest('W1v the view of the ring-head segment equals that segment\'s single-segment read, cut exactly at the ring head', async (t) => {
  // (i) every served seq is below tb, (ii) each equals the file read's event at
  // that seq, (iii) the served seqs are exactly 0…cut-1, (iv) every prompt and
  // reply of H is served once across the whole walk.
  function assertView(walk, { H, tb, ref, cut, gapAfter = null }) {
    const view = spaceEvents(walk, H);
    assert.ok(view.length > 0, 'the walk served the view');
    const seqd = view.filter(e => typeof e._seq === 'number');
    for (const e of seqd) assert.ok(e._seq < tb, `(i) served seq ${e._seq} < tb ${tb}`);
    const bySeq = new Map(ref.filter(e => typeof e._seq === 'number').map(e => [e._seq, e]));
    for (const e of seqd) assert.deepEqual(e, bySeq.get(e._seq), `(ii) seq ${e._seq} equals the file read`);
    assert.deepEqual(seqd.map(e => e._seq), Array.from({ length: cut }, (_, i) => i), `(iii) the view is exactly 0…${cut - 1}`);
    const gaps = view.map((e, i) => (isGap(e) ? i : -1)).filter(i => i >= 0);
    if (gapAfter == null) assert.deepEqual(gaps, [], 'no marker in the view');
    else {
      assert.equal(gaps.length, 1, 'exactly one marker in the view');
      assert.equal(view[gaps[0] - 1]._seq, gapAfter, 'directly after the cut\'s last event');
    }
  }
  const once = (walk, texts) => {
    for (const text of texts) {
      assert.equal(walk.events.filter(e => e.text === text).length, 1, `(iv) "${text}" served exactly once`);
    }
  };
  const turnTexts = (tag, n) => Array.from({ length: n }, (_, i) => [`${tag} prompt ${i}`, `${tag} reply ${i}`]).flat();
  // Each shape reuses the same segment ids, so each gets its own root.
  const shape = (name, fn) => t.test(name, async () => {
    const r = await freshProjectsRoot();
    ctx.projectsRoot = r.projectsRoot;
    try { await fn(); } finally { await ctx.instances.shutdown(); await rmrf(r.home); }
  });

  await shape('(a) echo head, k = 0', async () => {
    let ref;
    const { inst, id } = await bootCaseA('w1va', { beforeResume: async () => {
      ref = (await mcpTool(ctx, 'get_transcript', { sessionId: PRE, limit: 500 })).events;
    } });
    const ring = inst.ringSnapshot();
    const tb = inst.ring.trimmedBefore;
    assert.equal(ring[0].kind, 'user_echo', 'precondition: the ring head is an echo');
    assert.match(ring[0].text, /^pre prompt /);
    const walk = await walkLineage(ctx, id, { limit: 7 });
    const cut = ref.findIndex(e => e.kind === 'user_echo' && e.text === ring[0].text);
    assert.ok(cut > 0);
    assertView(walk, { H: PRE, tb, ref, cut });
    once(walk, turnTexts('pre', 12));
  });

  await shape('(b) mid-turn correlated head, k = 0', async () => {
    const big = { type: 'assistant', uuid: 'pre-aB', message: { id: 'pre-mB', role: 'assistant',
      content: Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `pre big block ${i}` })) } };
    let ref;
    const { inst, id } = await bootLiveAcrossSeams({
      ctx, project: 'w1vb', publicId: PUBLIC, ringCap: 10,
      segments: [
        { id: PRE, reason: 'initial', records: [...segmentTurns('pre', 3), userText('pre-uB', 'pre big prompt'), big] },
        { id: POST, reason: 'renew', records: segmentTurns('post', 1) },
      ],
      beforeResume: async () => { ref = (await mcpTool(ctx, 'get_transcript', { sessionId: PRE, limit: 500 })).events; },
    });
    const ring = inst.ringSnapshot();
    const tb = inst.ring.trimmedBefore;
    assert.equal(ring[0].kind, 'text_delta', 'precondition: the ring head is mid-turn');
    assert.equal(ring[0].msgId, 'pre-mB', 'precondition: inside the big persisted reply');
    assert.ok(tb < inst.ring.seams[1].startSeq, 'precondition: the ring head predates the renew');
    const walk = await walkLineage(ctx, id, { limit: 7 });
    const cut = ref.findIndex(e => e.kind === 'text_delta' && e.msgId === 'pre-mB' && e.blockIdx === ring[0].blockIdx);
    assert.ok(cut > 0);
    assertView(walk, { H: PRE, tb, ref, cut });
    once(walk, [...turnTexts('pre', 3), 'pre big prompt', ...Array.from({ length: 12 }, (_, i) => `pre big block ${i}`)]);
  });

  await shape('(c) mid-turn uncorrelated head with no echo in the slice, k = 0: the echo count at the seam', async () => {
    const { inst, id, place } = await bootLiveAcrossSeams({
      ctx, project: 'w1vc', publicId: PUBLIC, ringCap: 10,
      segments: [{ id: PRE, reason: 'initial', records: segmentTurns('pre', 3) }],
    });
    // A live turn whose blocks the CLI never persisted, then its persisted reply.
    emitLive(inst, { echo: 'pre live prompt', msgId: 'liveP', blocks: 12 });
    await writeSegmentFile(place, { id: PRE, reason: 'initial', records: [
      ...segmentTurns('pre', 3), userText('pre-uL', 'pre live prompt'), asstText('pre-aX', 'pre-mX', 'pre reply X'),
    ] });
    await replaySlice(inst, place, PRE, { from: 7, headSkip: false });
    await writeSegmentFile(place, { id: POST, reason: 'renew', records: segmentTurns('post', 1) });
    await crossSeam(inst, { id: POST, place });

    const ring = inst.ringSnapshot();
    const tb = inst.ring.trimmedBefore;
    const s = inst.ring.seams[1].startSeq;
    assert.equal(ring[0].kind, 'text_delta', 'precondition: the ring head is mid-turn');
    assert.equal(ring[0].msgId, 'liveP', 'precondition: inside the never-persisted blocks');
    assert.ok(!ring.some(e => e._seq < s && e.kind === 'user_echo' && !e.parentToolUseId), 'precondition: no outer echo in [tb, s)');
    assert.ok(tb < s, 'precondition: the ring head predates the renew');
    const atSeam = ring.find(e => e._seq >= s && e.kind === 'user_echo').userIndex;
    assert.equal(atSeam, 4, 'precondition: the echo count at the seam is 4');
    assert.ok(inst._userEchoCount > atSeam, 'precondition: the live counter has moved past the seam');

    const ref = json((await pagePersistedEvents({ place, sessionId: PRE, limit: 500 })).events);
    const E = ref.findIndex(e => e.kind === 'user_echo' && e.text === 'pre live prompt');
    const walk = await walkLineage(ctx, id, { limit: 7 });
    assertView(walk, { H: PRE, tb, ref, cut: E + 1, gapAfter: E });
    once(walk, [...turnTexts('pre', 3), 'pre live prompt', 'pre reply X']);
    assert.ok(!spaceEvents(walk, PRE).some(e => e.text === 'pre reply X'), 'the persisted reply is served from the ring, not the file');
  });

  await shape('(d) k > 0, calibrated', async () => {
    let ref;
    const { inst, id } = await bootThreeLive('w1vd', { beforeResume: async () => {
      ref = (await mcpTool(ctx, 'get_transcript', { sessionId: POST, limit: 500 })).events;
    } });
    const { tb } = assertThreeLivePreconditions(inst);
    const ring = inst.ringSnapshot();
    assert.equal(ring[0].kind, 'user_echo', 'precondition: the ring head is an echo');
    assert.match(ring[0].text, /^post prompt /);
    // userEchoCount is not load-bearing here: an echo head never reads it.
    const walk = await walkLineage(ctx, id, { limit: 7 });
    const cut = ref.findIndex(e => e.kind === 'user_echo' && e.text === ring[0].text);
    assert.ok(cut > 0);
    assertView(walk, { H: POST, tb, ref, cut });
    once(walk, turnTexts('post', 6));
  });
});

wtest('W2 MCP output is untouched: get_transcript, get_recent_messages and forward read the current segment only', async () => {
  const { inst, id } = await bootW1('w2');
  const walk = await walkLineage(ctx, id, { limit: 50 });
  assert.ok(textsOf(walk.events, 'user_echo').includes('a prompt 0'), 'the UI walk does reach A');

  const older = /^[abc] (prompt|reply) \d+$/;
  const dflt = await mcpTool(ctx, 'get_transcript', { sessionId: P });
  const inproc = json(await pageInstanceEvents(inst, { limit: 200 }));
  assert.deepEqual(dflt.events, inproc.events, 'the default page is the live pager\'s');
  assert.equal(dflt.hasMore, inproc.hasMore);
  assert.equal(dflt.lastSeq, inproc.lastSeq);
  assert.ok(!dflt.events.some(e => older.test(e.text ?? '')), 'no earlier-segment content');
  let from = 0;
  for (let i = 0; i < 100; i++) {
    const page = await mcpTool(ctx, 'get_transcript', { sessionId: P, fromSeq: from, limit: 7 });
    const expect = json(await pageInstanceEvents(inst, { after: from - 1, limit: 7 }));
    assert.deepEqual(page.events, expect.events, `forward page from ${from}`);
    assert.ok(!page.events.some(e => older.test(e.text ?? '')));
    if (!page.hasMore) break;
    from = page.nextFrom;
  }

  const rpc = async (name, args) => {
    const res = await fetch(ctx.baseUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  const grm = (await rpc('get_recent_messages', { sessionId: P, count: 50 })).content.map(c => c.text).join('\n');
  assert.ok(grm.includes('d reply 2'), 'get_recent_messages reads D');
  assert.ok(!/\b[abc] reply \d/.test(grm), 'and nothing older');

  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'w2t' });
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'w2t', mode: 'bypassPermissions' });
  assert.equal(created.status, 201);
  const target = ctx.instances.get(created.body.id);
  await waitFor(() => target.status === 'idle' && target.sessionId);
  const calls = [];
  const orig = target.prompt.bind(target);
  target.prompt = async (...a) => { calls.push(a); return orig(...a); };
  const fwd = JSON.parse((await rpc('send_prompt', { sessionId: target.sessionId, forward: { sessionId: P }, text: 'go' })).content[0].text);
  assert.ok(fwd.forwarded >= 1, JSON.stringify(fwd));
  assert.ok(calls[0][0].includes('d reply 2'), 'the forward carries D');
  assert.ok(!/\b[abc] reply \d/.test(calls[0][0]), 'and nothing older');

  const bySegment = await mcpTool(ctx, 'get_transcript', { sessionId: A });
  assert.equal(bySegment.source, 'ring', 'an older segment id of a live session serves the live pager');
  assert.deepEqual(bySegment.events, dflt.events);
  // Both halves of that, each where it is enforced: the MCP dispatch chokepoint
  // (src/mcp/server.ts) rewrites the segment id to the public id before any
  // handler runs, and the handler's own resolver (getInstOrDisk) — reached here
  // with the raw segment id, past the chokepoint — answers with the live
  // instance, not the segment's file.
  assert.equal((await ctx.instances.resolveSessionRef(A)).sessionId, P, 'the chokepoint maps segment A to the public id');
  const { getTranscript } = await import('../src/mcp/handlers.ts');
  const direct = await getTranscript({ sessionId: A, limit: 200 }, { instances: ctx.instances });
  assert.equal(direct.source, 'ring', 'getInstOrDisk resolves segment A to the live instance');
  assert.deepEqual(json(direct.events), dflt.events);
});

wtest('W3 structural pin: the lineage layer composes the pager\'s entry points and holds no cut logic', async () => {
  const file = path.join(REPO, 'src', 'lineagePager.ts');
  assert.ok(existsSync(file), 'src/lineagePager.ts exists');
  const src = readFileSync(file, 'utf8');
  const imported = new Set();
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'\.\/(eventArchive|parser)\.ts'/g)) {
    if (m[1]) continue;
    for (const name of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
      if (!name.startsWith('type ')) imported.add(name);
    }
  }
  assert.deepEqual([...imported].sort(),
    ['insertRingSeamDividers', 'isOuterUserEcho', 'loadStampedTranscript', 'pageInstanceEvents', 'pageStampedTranscript', 'segmentOfSeq']);
  for (const name of ['buildArchive', 'cutFromEchoAnchor', 'correlateRingHead', 'calibrateEchoOffset',
    'snapStartToQuiescent', 'pageCombined', 'stampArchiveEvents', 'loadPersistedTranscript']) {
    assert.ok(!src.includes(name), `lineagePager.ts does not reference ${name}`);
  }
  const mcpDir = path.join(REPO, 'src', 'mcp');
  for (const f of [...readdirSync(mcpDir).map(n => path.join(mcpDir, n)), path.join(REPO, 'src', 'wsHub.ts')]) {
    if (!f.endsWith('.ts')) continue;
    assert.ok(!readFileSync(f, 'utf8').includes('lineagePager'), `${path.relative(REPO, f)} does not import the walk`);
  }
});

wtest('W4 renew/prune/renew: exactly once, dividers at the renew boundaries, a monotonic cursor', async () => {
  const { inst, id } = await bootW1('w4');
  const walk = await walkLineage(ctx, id, { limit: 7 });
  assert.equal(render(walk.events, { [C]: 'C', [D]: 'D' }), '[a] ‖C [b] [c] ‖D [d]');
  assertOnceInOrder(walk.events, 'a', 3);
  assertOnceInOrder(walk.events, 'c', 2);
  assertOnceInOrder(walk.events, 'd', 3);
  const lastText = (i) => walk.events.slice(0, i).findLast(e => typeof e.text === 'string')?.text;
  const iC = walk.events.findIndex(e => e.kind === 'segment_seam' && e.segmentId === C);
  assert.equal(lastText(iC), 'a reply 2', 'the C divider follows A\'s last event');
  assert.equal(walk.events[iC + 1].text, RENEW_HEAD[0].message.content, 'and precedes C\'s first');
  const iD = walk.events.findIndex(e => e.kind === 'segment_seam' && e.segmentId === D);
  assert.equal(lastText(iD), 'c reply 1', 'the D divider follows C\'s last event');
  assert.equal(walk.events[iD + 1]._seq, inst.ringSnapshot()[0]._seq, 'and precedes D\'s first');
  assert.equal(walk.pages.filter(p => !p.hasMore).length, 1, 'hasMore:false exactly once');
  assert.equal(walk.pages.at(-1).hasMore, false, 'on the last page');
});

wtest('W5 REST shapes: prune skips, tombstones, missing files and legacy rows', async (t) => {
  let n = 0;
  // Ids for one shape: letter → a uuid unique to the shape.
  const idsFor = (letters) => {
    n += 1;
    const nn = String(n).padStart(2, '0');
    return Object.fromEntries(letters.map((L, i) => [L, `0472${nn}${i}0-0000-4000-8000-0000000000${nn}`]));
  };
  async function shape({ title, spec, expected, legacy = false }) {
    await t.test(title, async () => {
      const ids = idsFor(spec.map(s => s.L));
      const segs = spec.map(s => ({ id: ids[s.L], reason: s.reason, records: segmentTurns(s.L.toLowerCase(), 2),
        ...(s.dropped ? { dropped: true, file: false } : {}), ...(s.missing ? { file: false } : {}) }));
      const project = `w5-${n}`;
      const publicId = segs[0].id.slice(0, 8);
      await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
      const place = localPlace(path.join(ctx.projectsRoot, project));
      if (legacy) {
        for (const s of segs) await writeSegmentFile(place, s);
        await writeLineageRow(publicId, segs);
      } else {
        await seedSegmentChain({ place, publicId, segments: segs });
      }
      const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', resume: publicId });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const inst = ctx.instances.get(r.body.id);
      await waitFor(() => inst.status === 'idle');
      const walk = await walkLineage(ctx, r.body.id, { limit: 7 });
      const names = Object.fromEntries(Object.entries(ids).map(([L, id]) => [id, L]));
      assert.equal(render(walk.events, names), expected);
      assert.equal(gapCount(walk.events), (expected.match(/⋯/g) ?? []).length, 'raw gap count');
      assert.equal(walk.pages.filter(p => !p.hasMore).length, 1, 'hasMore:false exactly once');
      await ctx.instances.shutdown();
    });
  }
  const I = (L, extra) => ({ L, reason: 'initial', ...extra });
  const R = (L, extra) => ({ L, reason: 'renew', ...extra });
  const Pr = (L, extra) => ({ L, reason: 'prune', ...extra });
  await shape({ title: '#8 A✗ B·r', spec: [I('A', { missing: true }), R('B')], expected: '⋯ ‖B [b]' });
  await shape({ title: '#13 A B†·r C·r', spec: [I('A'), R('B', { dropped: true }), R('C')], expected: '[a] ‖B ⋯ ‖C [c]' });
  await shape({ title: '#14 A B†·r C·p', spec: [I('A'), R('B', { dropped: true }), Pr('C')], expected: '[a] ‖C ⋯ [c]' });
  await shape({ title: '#16 A† B·p', spec: [I('A', { dropped: true }), Pr('B')], expected: '⋯ [b]' });
  await shape({ title: '#18 L1 B·r C·r', spec: [R('B'), R('C')], expected: '⋯ [b] ‖C [c]', legacy: true });
  await shape({ title: '#30 A B·p C·p', spec: [I('A'), Pr('B'), Pr('C')], expected: '[c]' });
  await shape({ title: '#31 L1 B·r alone', spec: [R('B')], expected: '⋯ [b]', legacy: true });
});

wtest('W6 live case A: the view serves the ring-head segment\'s file, a divider before the rotation init, no gap', async () => {
  const { inst, id } = await bootCaseA('w6');
  const s = inst.ring.seams[1].startSeq;
  const walk = await walkLineage(ctx, id, { limit: 7 });
  assertOnceInOrder(walk.events, 'pre', 12);
  assertOnceInOrder(walk.events, 'post', 1);
  assert.equal(render(walk.events, { [POST]: 'POST' }), '[pre] ‖POST [post]');
  const iS = walk.events.findIndex(e => e.kind === 'segment_seam');
  assert.equal(walk.events[iS + 1].subtype, 'init');
  assert.equal(walk.events[iS + 1].data.session_id, POST, 'the divider directly precedes POST\'s init');
  assert.equal(gapCount(walk.events), 0, 'no marker: nothing is lost');
  const viewPages = walk.pages.filter((_, i) => walk.cursors[i].segment === PRE);
  assert.ok(viewPages.length > 0, 'the view was paged');
  for (const p of viewPages) assert.equal(p.pageSegment, PRE, 'view pages name PRE as their provenance');
  // A live page's provenance is the segment of its first seq'd event: here no
  // archive is loaded, so it is the seam owning that ring seq.
  const livePages = walk.pages.filter((_, i) => walk.cursors[i].segment === null);
  for (const p of livePages) {
    const first = p.events.find(e => typeof e._seq === 'number');
    assert.equal(p.pageSegment, first._seq < s ? PRE : POST, `live page from seq ${first._seq}`);
  }
  assert.ok(livePages.some(p => p.pageSegment === PRE), 'a live page opening in PRE\'s ring slice names PRE');
  for (const p of walk.pages) {
    assert.ok('currentSegmentId' in p, 'every lineage page carries currentSegmentId');
    assert.equal(p.currentSegmentId, POST);
  }
});

wtest('W7 live case B: the earlier segment is read from its file above the current file\'s head, no floor', async () => {
  const { inst, id } = await bootCaseB('w7');
  const tb = inst.ring.trimmedBefore;
  const walk = await walkLineage(ctx, id, { limit: 7 });
  assert.equal(render(walk.events, { [POST]: 'POST' }), '[pre] ‖POST [post]');
  const iS = walk.events.findIndex(e => e.kind === 'segment_seam');
  assert.equal(walk.events[iS + 1].text, RENEW_HEAD[0].message.content, 'the divider directly precedes POST\'s file head');
  assert.equal(gapCount(walk.events), 0, 'no floor marker: the earlier segment is served');
  assertOnceInOrder(walk.events, 'pre', 3);
  assertOnceInOrder(walk.events, 'post', 12);
  // A live page dipping into the current file's archive (seqs below tb, which
  // the seams would assign to PRE) names the current segment.
  const livePages = walk.pages.filter((_, i) => walk.cursors[i].segment === null);
  const dips = livePages.filter(p => p.events.find(e => typeof e._seq === 'number')._seq < tb);
  assert.ok(dips.length > 0, 'precondition: a live page opens in POST\'s archive');
  for (const p of livePages) assert.equal(p.pageSegment, POST, 'every live page names POST');
});

wtest('W8 three live segments: view of the middle one, then the oldest; and the two rows H is not a live step of', async (t) => {
  const { inst, id, place } = await bootThreeLive('w8');
  assertThreeLivePreconditions(inst);
  const names = { [POST]: 'POST', [THIRD]: 'THIRD' };
  const refPost = json((await pagePersistedEvents({ place, sessionId: POST, limit: 500 })).events);

  await t.test('#24 the row as written', async () => {
    const walk = await walkLineage(ctx, id, { limit: 7 });
    assert.equal(gapCount(spaceEvents(walk, POST)), 0, 'precondition: the view\'s cut is exact');
    assert.equal(render(walk.events, names), '[pre] ‖POST [post] ‖THIRD [third]');
    assert.equal(gapCount(walk.events), 0);
    assertOnceInOrder(walk.events, 'pre', 3);
    assertOnceInOrder(walk.events, 'post', 6);
    assertOnceInOrder(walk.events, 'third', 1);
  });

  await t.test('(a) #29′ H is the row\'s oldest entry and not initial: the layer\'s one gap, no floor', async () => {
    await writeLineageRow(PUBLIC, [{ id: POST, reason: 'renew' }, { id: THIRD, reason: 'renew' }]);
    const walk = await walkLineage(ctx, id, { limit: 7 });
    const viewIdx = walk.cursors.map((c, i) => (c.segment === POST ? i : -1)).filter(i => i >= 0);
    assert.ok(viewIdx.length > 0, 'the view was paged');
    const terminal = walk.pages[viewIdx.at(-1)];
    assert.equal(terminal.events[0].kind, GAP, 'the view\'s terminal page opens on the gap');
    assert.deepEqual(terminal.events[1], refPost[0], 'directly above POST\'s file event 0');
    assert.equal(gapCount(walk.events), 1, 'exactly one gap in the whole walk');
  });

  await t.test('(b) #29 H is absent from the row: the core\'s floor on the view, nothing on the live pages', async () => {
    await writeLineageRow(PUBLIC, [{ id: PRE, reason: 'initial' }, { id: THIRD, reason: 'renew' }]);
    const walk = await walkLineage(ctx, id, { limit: 7 });
    assert.equal(gapCount(spaceEvents(walk, null)), 0, 'the live pages carry no floor');
    const viewIdx = walk.cursors.map((c, i) => (c.segment === POST ? i : -1)).filter(i => i >= 0);
    assert.ok(viewIdx.length > 0, 'the view was paged');
    assert.equal(walk.pages[viewIdx.at(-1)].events[0].kind, GAP, 'the view\'s terminal page opens on the floor');
    assert.equal(gapCount(walk.events), 1, 'and there is no other marker');
  });
});

wtest('W9 a rotation between requests: the saved live cursor continues in the view, exactly once', async () => {
  const { inst, id, place } = await bootCaseB('w9');
  await writeSegmentFile(place, { id: THIRD, reason: 'renew', records: segmentTurns('third', 1) });
  const tb = inst.ring.trimmedBefore;
  let saved = [];
  let page;
  let before = null;
  for (let i = 0; i < 50; i++) {
    const r = await getLineage(id, `?limit=7${before != null ? `&before=${before}` : ''}`);
    assert.equal(r.status, 200);
    page = r.body;
    saved = page.events.concat(saved);
    assert.equal(page.segment ?? null, null, 'precondition: still in the live space');
    before = page.nextBefore;
    if (page.nextBefore < tb) break;
  }
  assert.ok(page.hasMore && page.nextBefore < tb, 'precondition: the cursor is inside POST\'s archive');
  await rotate(inst, THIRD);
  const rest = await walkLineage(ctx, id, { limit: 7, before: page.nextBefore });
  const all = rest.events.concat(saved);
  assertOnceInOrder(all, 'pre', 3);
  assertOnceInOrder(all, 'post', 12);
});

wtest('W10 segmentRingView: the instance as it stood just before the next rotation', async () => {
  // The slice's LOWER bound is inert by construction — every retained seq is
  // >= tb >= seams[k].startSeq, since k is the seam owning tb — so this fixture
  // pins the UPPER bound (seams[k+1].startSeq), the load-bearing one.
  const segmentRingView = await newExport('src/lineagePager.ts', 'segmentRingView');
  const seams = [{ segmentId: 'sa', startSeq: 0 }, { segmentId: 'sb', startSeq: 10 }, { segmentId: 'sc', startSeq: 20 }];
  const ev = (seq, extra = {}) => ({ kind: 'text_delta', msgId: `m${seq}`, blockIdx: 0, text: 'x', parentToolUseId: null, _seq: seq, ...extra });
  const ring = [];
  for (let s = 12; s < 26; s++) ring.push(ev(s));
  ring[22 - 12] = { kind: 'user_echo', text: 'sub', parentToolUseId: 'toolX', _seq: 22 };
  ring[23 - 12] = { kind: 'user_echo', text: 'outer', userIndex: 7, parentToolUseId: null, _seq: 23 };
  const place = { cwd: '/x', system: null };
  const snap = { ring, tb: 12, seams, echoCount: 9, place };
  const view = segmentRingView(snap, 1);
  assert.deepEqual(view.ringSnapshot().map(e => e._seq), [12, 13, 14, 15, 16, 17, 18, 19], 'the ring restricted to [seams[k], seams[k+1])');
  assert.equal(view.ring.trimmedBefore, 12);
  assert.equal(view.ring.nextSeq, 20);
  assert.deepEqual(view.ring.seams, seams.slice(0, 2), 'the seams up to k');
  assert.equal(view.backingSessionId, 'sb');
  assert.equal(view.transcriptPlace, place);
  assert.deepEqual(currentSegmentScope(view), { segmentId: 'sb', startSeq: 10, archivable: true, priorEvicted: true });
  assert.equal(view._userEchoCount, 7, 'the first OUTER echo at or after the next seam carries the count at the seam');
  const quiet = segmentRingView({ ...snap, ring: ring.filter(e => e.kind !== 'user_echo') }, 1);
  assert.equal(quiet._userEchoCount, 9, 'no echo after the seam: the live counter has not moved past it');
});

wtest('W11 task completions are per segment: A\'s batch completes in A only, D\'s orphan update pairs with nothing', async () => {
  const dRecords = [
    ...segmentTurns('d', 3),
    userText('d-uq', 'd update'),
    asstToolUse('d-tua', 'd-tum', 'd-tu', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    userToolResult('d-tur', 'd-tu', 'Updated task #1 status'),
  ];
  const { inst, id, mcp } = await bootW1('w11', { dRecords });
  const walk = await walkLineage(ctx, id, { limit: 7 });
  const runs = splitAtSeams(walk.events);
  assert.deepEqual(runs.map(r => r.label), [null, C, D]);
  const completions = (evs) => evs.filter(e => e.kind === 'task_completion');
  assert.equal(completions(runs[0].events).length, 1, 'A\'s batch completes inside A');
  assert.deepEqual(unclocked(runs[0].events), unclocked(mcp.A.events), 'and A equals its own MCP read');
  assert.equal(completions(runs[1].events).length, 0);
  assert.equal(completions(runs[2].events).length, 0, 'D\'s orphan update gets no completion from A');

  const c = await wsClient();
  try {
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.deepEqual(snap.tasksAtTailStart, json(await inst.reconstructActiveTasks(snap.tailStartSeq)));
  } finally { await c.close(); }
});

wtest('W12 a remote place: the earlier segment is read from the instance\'s transcript place, exactly once', async () => {
  const sys = 'lineage-remote';
  try {
    const box = await fs.realpath(await mkdtemp('cc-lineage-remote-'));
    const tree = await seedRepo(path.join(box, 'nest', 'app'));
    const mirrorFile = path.join(box, '.mirror');
    await fs.writeFile(mirrorFile, path.join(box, 'nest'));
    await addSystem({ id: sys, label: sys, launch: ['node', MIRROR_FIXTURE, '--mirror-file', mirrorFile] });
    assert.equal((await adoptProject('app', tree, { system: sys })).ok, true);
    const id = await withRingCap(10, async () => {
      const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id;
    });
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    const seg0 = inst.backingSessionId;
    const place = inst.transcriptPlace;
    await writeSegmentFile(place, { id: seg0, reason: 'initial', records: segmentTurns('cur', 12) });
    await replaySlice(inst, place, seg0, { headSkip: false });
    await writeSegmentFile(place, { id: POST, reason: 'renew', records: segmentTurns('post', 1) });
    await crossSeam(inst, { id: POST, place });
    assert.ok(inst.ring.trimmedBefore > 0, 'precondition: the ring trimmed');

    const walk = await walkLineage(ctx, id, { limit: 7 });
    assertOnceInOrder(walk.events, 'cur', 12);
    assertOnceInOrder(walk.events, 'post', 1);
  } finally {
    disposeSystemHandles();
  }
});

wtest('W13 WS snapshot: a divider before the rotation init, the tail\'s provenance and the current segment', async () => {
  const { inst, id } = await bootCaseA('w13');
  const c = await wsClient();
  try {
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    const iS = snap.events.findIndex(e => e.kind === 'segment_seam');
    assert.ok(iS >= 0, 'the snapshot carries the divider');
    assert.equal(snap.events[iS].segmentId, POST);
    assert.ok(isInitFrame({ t: 'event', ev: snap.events[iS + 1] }, POST), 'directly before POST\'s init');
    assert.equal(snap.events.filter(e => e.kind === 'segment_seam').length, 1);
    const firstReal = snap.events.find(e => typeof e._seq === 'number');
    assert.equal(typeof snap.tailStartSeq, 'number');
    assert.equal(snap.tailStartSeq, firstReal._seq, 'tailStartSeq is the first real event\'s seq');
    assert.equal(snap.tailStartSeq, inst.ring.trimmedBefore, 'precondition: the tail is the whole ring');
    assert.equal(snap.tailSegmentId, PRE, 'the tail starts in PRE');
    assert.equal(snap.currentSegmentId, POST);
  } finally { await c.close(); }
});

wtest('W14 WS live frames: a segment frame before every init, and a divider before a rotation init', async () => {
  const { inst, id } = await bootLiveAcrossSeams({
    ctx, project: 'w14', publicId: PUBLIC, segments: [{ id: PRE, reason: 'initial', records: segmentTurns('pre', 3) }],
  });
  const c = await wsClient();
  try {
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot' && m.id === id);
    const framesFrom = (start) => c.messages.slice(start).filter(m => m.id === id && (m.t === 'event' || m.t === 'segment'));

    // The fill spawn of a relaunch.
    await inst.kill({ graceMs: 50 });
    await waitFor(() => inst.proc == null);
    const mark = c.messages.length;
    const rs = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/respawn`);
    assert.equal(rs.status, 200);
    await waitFor(() => inst.status === 'idle');
    // The CLI reports its init with the first turn.
    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => c.messages.indexOf(m) >= mark && isInitFrame(m, PRE) && m.id === id);
    let frames = framesFrom(mark);
    let iInit = frames.findIndex(m => isInitFrame(m, PRE));
    assert.deepEqual(frames[iInit - 1], { t: 'segment', id, currentSegmentId: PRE }, 'the fill init is preceded by segment{PRE}');
    assert.ok(!frames.some(m => m.ev?.kind === 'segment_seam'), 'and by no divider');
    await waitFor(() => inst.status === 'idle');

    // A rotation.
    const mark2 = c.messages.length;
    await rotate(inst, THIRD);
    await c.wait(m => c.messages.indexOf(m) >= mark2 && isInitFrame(m, THIRD));
    frames = framesFrom(mark2);
    iInit = frames.findIndex(m => isInitFrame(m, THIRD));
    assert.deepEqual(frames.slice(iInit - 2, iInit).map(m => (m.t === 'segment' ? ['segment', m.currentSegmentId] : ['event', m.ev.kind, m.ev.segmentId])),
      [['segment', THIRD], ['event', 'segment_seam', THIRD]], 'segment{THIRD}, then the divider, then the init');
  } finally { await c.close(); }
});

wtest('W15 validation: only the ring-head view and the walk\'s own steps are addressable', async () => {
  const { id } = await bootW1('w15');
  for (const segment of [B, D, 'nope']) {
    const r = await getLineage(id, `?segment=${segment}`);
    assert.equal(r.status, 400, `segment=${segment}`);
    assert.equal(r.body.error, SEAM_MSG);
  }
  for (const segment of [C, A]) assert.equal((await getLineage(id, `?segment=${segment}`)).status, 200, `step ${segment} is addressable`);
  const bad = await getLineage(id, '?before=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'before must be an integer');
  assert.equal((await getLineage(id, '?limit=x')).status, 400);
  assert.equal((await api(ctx.baseUrl, 'GET', '/api/instances/nope/lineage-events')).status, 404);
  const empty = await getLineage(id, '?segment=&limit=7');
  assert.equal(empty.status, 200, 'an empty segment= is the live space');
  assert.deepEqual(empty.body, (await getLineage(id, '?limit=7')).body);

  // A ring segment below H that the walk does not step to (the row calls POST a
  // prune of PRE, so PRE is skipped).
  await ctx.instances.shutdown();
  const three = await bootThreeLive('w15b');
  await writeLineageRow(PUBLIC, [{ id: PRE, reason: 'initial' }, { id: POST, reason: 'prune' }, { id: THIRD, reason: 'renew' }]);
  const r = await getLineage(three.id, `?segment=${PRE}`);
  assert.equal(r.status, 400, 'a non-H ring segment');
  assert.equal(r.body.error, SEAM_MSG);
  assert.equal((await getLineage(three.id, `?segment=${POST}`)).status, 200, 'H itself is addressable');
});

wtest('W16 no divider without a boundary: a single-segment session', async () => {
  const { id } = await bootLiveAcrossSeams({
    ctx, project: 'w16', publicId: PUBLIC, segments: [{ id: PRE, reason: 'initial', records: segmentTurns('pre', 3) }],
  });
  const walk = await walkLineage(ctx, id, { limit: 7 });
  assert.equal(walk.events.filter(e => e.kind === 'segment_seam').length, 0);
  assertOnceInOrder(walk.events, 'pre', 3);
  const probe = await getLineage(id, '?before=0&limit=200');
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body.events, []);
  assert.equal(probe.body.hasMore, false);
  const c = await wsClient();
  try {
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.equal(snap.events.filter(e => e.kind === 'segment_seam').length, 0);
  } finally { await c.close(); }
});

// W17/W18: the rotation init lands exactly on the ring floor (tb === its seam).
// With cap 1 the ring cycles 1 → 2 → 3 (trim to the last event) → 1, so an init
// pushed onto a ring of 2 becomes the whole ring.
async function bootInitOnFloor(project) {
  const r = await bootLiveAcrossSeams({
    ctx, project, publicId: PUBLIC, ringCap: 1,
    segments: [
      { id: PRE, reason: 'initial', records: segmentTurns('pre', 3) },
      { id: POST, reason: 'renew', records: segmentTurns('post', 2) },
    ],
  });
  await writeSegmentFile(r.place, { id: THIRD, reason: 'renew', records: [] });
  if (r.inst.ringSnapshot().length === 1) emitLive(r.inst, { echo: 'pad', msgId: 'pad', blocks: 0 });
  assert.equal(r.inst.ringSnapshot().length, 2, 'precondition: the ring holds 2 before the init');
  return r;
}
function assertInitOnFloor(inst) {
  assert.equal(inst.ring.trimmedBefore, inst.ring.seams.at(-1).startSeq, 'precondition: tb === the rotation seam');
  const ring = inst.ringSnapshot();
  assert.equal(ring.length, 1);
  assert.ok(isInitFrame({ t: 'event', ev: ring[0] }, THIRD), 'precondition: the ring is THIRD\'s init alone');
}

wtest('W17 tb === startSeq, live: the segment frame still precedes the init, and no divider is drawn', async () => {
  const { inst, id } = await bootInitOnFloor('w17');
  const c = await wsClient();
  try {
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot' && m.id === id);
    const mark = c.messages.length;
    await rotate(inst, THIRD);
    assertInitOnFloor(inst);
    await c.wait(m => c.messages.indexOf(m) >= mark && isInitFrame(m, THIRD));
    const frames = c.messages.slice(mark).filter(m => m.id === id && (m.t === 'event' || m.t === 'segment'));
    const iInit = frames.findIndex(m => isInitFrame(m, THIRD));
    assert.deepEqual(frames[iInit - 1], { t: 'segment', id, currentSegmentId: THIRD }, 'segment{THIRD} directly precedes the init');
    assert.ok(!frames.some(m => m.ev?.kind === 'segment_seam'), 'no divider frame');
  } finally { await c.close(); }
});

wtest('W18 tb === startSeq, reconnect: the snapshot, the rendered walk, and rewind/fork only on the current segment', async () => {
  const { inst, id } = await bootInitOnFloor('w18');
  await rotate(inst, THIRD);
  assertInitOnFloor(inst);
  const c = await wsClient();
  let snap;
  try {
    c.send({ t: 'subscribe', id });
    snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
  } finally { await c.close(); }
  assert.equal(snap.currentSegmentId, THIRD, 'the snapshot names the current segment');
  assert.equal(snap.tailSegmentId, THIRD);
  assert.equal(snap.events.length, 1);
  assert.ok(isInitFrame({ t: 'event', ev: snap.events[0] }, THIRD), 'the tail is the init alone, no divider');

  await renderLineageInDom(id, snap, async ({ el, conversation }) => {
    const names = { [POST]: 'POST', [THIRD]: 'THIRD' };
    const tokens = [];
    for (const node of el.children) {
      let tok = null;
      if (node.classList.contains('segment-seam')) tok = `‖${names[node.getAttribute('data-segment-id')]}`;
      else if (node.classList.contains('history-gap')) tok = '⋯';
      else if (node.classList.contains('user')) {
        const m = /^(\w+) prompt \d+$/.exec(node.querySelector('.block.text')?.textContent ?? '');
        if (m) tok = `[${m[1]}]`;
      }
      if (tok && !(tok.startsWith('[') && tokens[tokens.length - 1] === tok)) tokens.push(tok);
    }
    assert.equal(tokens.join(' '), '[pre] ‖POST [post] ‖THIRD ⋯');
    const bubbles = [...el.querySelectorAll('.msg.user')];
    assert.ok(bubbles.length > 0);
    for (const b of bubbles) assertNull(b.querySelector('.user-msg-actions'), 'no rewind/fork on an earlier segment');

    // The §5c segment-frame lines, then a live THIRD echo.
    conversation.segmentId = THIRD;
    conversation.setCurrentSegment(THIRD);
    conversation.apply({ kind: 'user_echo', text: 'third live', userIndex: 99, _seq: 1_000_000, parentToolUseId: null });
    const live = [...el.querySelectorAll('.msg.user')].at(-1);
    assert.ok(live.querySelector('.user-msg-actions') !== null, 'the current segment\'s bubble offers rewind/fork');
  });
});

wtest('W19 an L1 row whose oldest entry is the current segment: the layer\'s one gap, never also the core\'s floor', async () => {
  const { inst, id } = await bootCaseB('w19');
  assert.ok(inst.ring.trimmedBefore > inst.ring.seams[1].startSeq, 'precondition: the ring head is inside the current segment');
  assert.equal(currentSegmentScope(inst).priorEvicted, true, 'precondition: the core alone would mark a floor');
  await writeLineageRow(PUBLIC, [{ id: POST, reason: 'renew' }]);
  const walk = await walkLineage(ctx, id, { limit: 7 });
  assert.equal(gapCount(walk.events), 1, 'exactly one raw gap');
  assert.equal(walk.events[0].kind, GAP, 'above everything');
  assertOnceInOrder(walk.events, 'post', 12);
  assert.ok(!walk.events.some(e => /^pre /.test(e.text ?? '')), 'nothing older is walked');
});

wtest('W20 rendered end to end: a current-segment bubble served from the live space\'s archive offers rewind/fork', async () => {
  const { inst, id } = await bootCaseB('w20');
  assert.ok(!inst.ringSnapshot().some(e => e.text === 'post prompt 0'), 'precondition: post prompt 0 was evicted from the ring');
  const c = await wsClient();
  let snap;
  try {
    c.send({ t: 'subscribe', id });
    snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
  } finally { await c.close(); }
  assert.equal(snap.currentSegmentId, POST, 'the snapshot names the current segment');
  await renderLineageInDom(id, snap, async ({ el }) => {
    const bubble = (text) => [...el.querySelectorAll('.msg.user')].find(b => b.querySelector('.block.text')?.textContent === text);
    assert.ok(bubble('post prompt 0'), 'the archive-backed live page rendered');
    assert.ok(bubble('post prompt 0').querySelector('.user-msg-actions') !== null, 'the current segment\'s archive bubble offers rewind/fork');
    assert.ok(bubble('pre prompt 0'), 'the older segment rendered');
    assertNull(bubble('pre prompt 0').querySelector('.user-msg-actions'), 'the older segment\'s bubble does not');
  });
});

// Render a lineage walk the way the browser does: the real Conversation and
// lazy controller under happy-dom, fed the snapshot as public/wsRouter.js feeds
// it, with the controller's fetches proxied to this server, paged until the
// sentinel is gone. `fn` gets the conversation root and the live conversation.
async function renderLineageInDom(id, snap, fn) {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  const saved = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element, Node: globalThis.Node, fetch: globalThis.fetch };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node });
  globalThis.fetch = (u, o) => { fetches += 1; return realFetch(typeof u === 'string' && u.startsWith('/') ? ctx.baseUrl + u : u, o); };
  try {
    const PUB = path.join(REPO, 'public');
    const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
    const { installLazyHistoryController } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
    document.body.innerHTML = '<div id="conversation"></div>';
    const el = document.getElementById('conversation');
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 800 });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 0 });
    const options = { onRewind: () => {}, onFork: () => {} };
    const conversation = new Conversation(el, options);
    assert.equal(typeof conversation.setCurrentSegment, 'function');
    const controller = installLazyHistoryController({
      conversationEl: el, conversation, conversationOptions: options,
      getActiveId: () => id, getInstances: () => [{ id, status: 'idle' }],
    });
    // The snapshot handler's lines, then its replay.
    conversation.clear();
    conversation.setCurrentSegment(snap.currentSegmentId ?? null);
    conversation.segmentId = snap.tailSegmentId ?? null;
    conversation._replayMode = true;
    for (const ev of snap.events) conversation.apply(ev);
    conversation._replayMode = false;
    controller.init(snap);
    await waitFor(() => fetches > 0 && !el.querySelector('.history-sentinel'));
    await fn({ el, conversation });
  } finally {
    Object.assign(globalThis, saved);
    await window.happyDOM?.close?.();
  }
}
