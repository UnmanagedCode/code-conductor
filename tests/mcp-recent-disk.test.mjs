// Disk-backed reads: ring eviction must be invisible to get_recent_messages
// and get_transcript. RING-FIRST, DISK-FALLBACK-ON-DEMAND — served from the
// in-memory ring on the hot path; only when the ring has evicted the requested
// data do these tools read back into the on-disk session transcript and
// reconcile by _seq / msgId. Mirrors the seed+resume pattern from
// events-endpoint.test.mjs (which already exercises pageInstanceEvents).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, driveTurn } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
// Single compact-JSON block (get_transcript / pure-metadata).
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
// get_recent_messages: metadata block + one raw body per message.
function unwrapMsgs(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  const bodies = result.content.slice(1).map(c => c.text);
  return { meta, bodies, messages: meta.messages.map((m, i) => ({ ...m, text: bodies[i] ?? '' })) };
}

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

// One text turn then `toolCount` tool-only assistant turns. With a small ring
// cap, the early text message is evicted while the retained tail is tool-only.
function textThenToolLines(toolCount) {
  const lines = [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm_text', role: 'assistant', content: [{ type: 'text', text: 'hello from disk' }] } },
  ];
  for (let i = 0; i < toolCount; i++) {
    lines.push({ type: 'assistant', uuid: `at${i}`, message: { id: `mt${i}`, role: 'assistant', content: [
      { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${i}` } },
    ] } });
    lines.push({ type: 'user', uuid: `ut${i}`, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `tu${i}`, content: 'ok\n', is_error: false },
    ] } });
  }
  return lines;
}

// Async-worker CLI persisted shape: ONE message written as two single-block
// assistant lines sharing message.id (text line, then tool_use line), followed
// by `toolCount` tool-only filler turns so a small ring cap evicts the text.
function splitMessageThenToolLines(toolCount) {
  const lines = [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm_split', role: 'assistant', content: [{ type: 'text', text: 'prose from disk' }] } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_split', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_split', name: 'Bash', input: { command: 'true' } }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_split', content: 'ok\n', is_error: false }] } },
  ];
  for (let i = 0; i < toolCount; i++) {
    lines.push({ type: 'assistant', uuid: `at${i}`, message: { id: `mt${i}`, role: 'assistant', content: [
      { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${i}` } },
    ] } });
    lines.push({ type: 'user', uuid: `ut${i}`, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `tu${i}`, content: 'ok\n', is_error: false },
    ] } });
  }
  return lines;
}

function turnLines(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `prompt ${i}` } });
    lines.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } });
  }
  return lines;
}

// ---------- get_recent_messages ----------

test('get_recent_messages: ring-evicted text is served from disk (not a false empty)', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'dddddddd-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'evicted', sid, lines: textThenToolLines(30) });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    // Sanity: the text message is genuinely gone from the in-memory ring.
    assert.ok(!inst.ringSnapshot().some(e => e.kind === 'text_delta' && /hello from disk/.test(e.text ?? '')),
      'text evicted from the ring (precondition)');

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.messages.length, 1, 'disk-fallback returns the evicted text message');
    assert.equal(res.messages[0].text, 'hello from disk');
    assert.equal(res.meta.source, 'disk', 'served from disk');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_recent_messages: a message split across single-block assistant lines reconstructs whole from disk', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'abcdabcd-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'splitmsg', sid, lines: splitMessageThenToolLines(30) });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.source, 'disk', 'served from disk');
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].text, 'prose from disk', 'text line and tool_use line merge into one message');
    assert.equal(res.messages[0].hasToolUse, true);
    assert.ok(res.messages[0].blocks?.some(b => b.type === 'tool_use' && b.name === 'Bash'));
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_recent_messages: ring-first hot path (no disk dependency when the ring satisfies)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId)?.status === 'idle');
    // Live text turn — its prose is in the ring, no jsonl was ever written.
    await driveTurn(ctx.instances, spawn.sessionId, () =>
      callTool(ctx.baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go' }));

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].text, 'First ');
    assert.equal(res.meta.source, 'ring', 'served from the ring, no disk read');
  } finally { await ctx.close(); }
});

test('get_recent_messages: truly-empty / missing-jsonl degrades gracefully with disambiguation', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(ctx.instances, spawn.sessionId)?.status === 'idle');

    // Flood the ring with tool-only assistant events so the retained tail has
    // no text, and trim past trimmedBefore. No jsonl exists on disk (the fake
    // CLI never wrote one) → disk-fallback finds nothing → graceful.
    const inst = instForSession(ctx.instances, spawn.sessionId);
    for (let i = 0; i < 40; i++) {
      inst._emitUi({ kind: 'tool_use', msgId: `tool${i}`, blockIdx: 0, toolUseId: `tu${i}`, name: 'Bash', input: { command: `echo ${i}` } });
    }
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(res.messages.length, 0, 'no text messages anywhere');
    assert.ok(res.meta.omittedToolOnly > 0, 'tool-only activity is surfaced');
    assert.ok(typeof res.meta.hint === 'string' && res.meta.hint.length > 0, 'a hint disambiguates empty-but-active');
    assert.equal(res.meta.retained.trimmed, true);

    // includeToolCalls surfaces the tool-only activity rather than [].
    const all = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 5, includeToolCalls: true }));
    assert.ok(all.messages.length > 0, 'includeToolCalls returns the active tool-only messages');
    assert.ok(all.messages.every(m => m.hasToolUse));
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// ---------- get_transcript ----------

test('get_transcript: paging into a ring-dropped range is served from disk', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'eeeeeeee-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'paged', sid, lines: turnLines(12) });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    // fromSeq:0 (inclusive) points below trimmedBefore — the dropped range
    // must come from disk, NOT be silently skipped (the bug). events start
    // in the dropped range.
    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 50 }));
    assert.ok(page.events.length > 0);
    assert.ok(page.events[0]._seq < page.trimmedBefore,
      `first event _seq (${page.events[0]._seq}) is in the dropped range (< trimmedBefore ${page.trimmedBefore}) — served from disk`);
    // Earliest replies (long evicted from the ring) are recoverable.
    const texts = page.events.filter(e => e.kind === 'text_delta').map(e => e.text);
    assert.ok(texts.includes('reply 0'), 'oldest reply served from disk');
    // Oldest-first, contiguous, with a forward cursor to continue.
    for (let i = 1; i < page.events.length; i++) assert.ok(page.events[i]._seq > page.events[i - 1]._seq);
    assert.equal(typeof page.hasMore, 'boolean');
    assert.equal(page.nextFrom, page.events[page.events.length - 1]._seq + 1);
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_transcript: in-flight (current-turn) ring events still appear after a disk-backed history', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'ffffffff-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'inflight', sid, lines: turnLines(12) });
    const inst = ctx.instances.get(id);
    const lastSeqBefore = inst.ring.nextSeq - 1;

    // A fresh live event lands in the ring (not on disk).
    inst._emitUi({ kind: 'text_delta', msgId: 'live', blockIdx: 0, text: 'in-flight words' });

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: lastSeqBefore + 1 }));
    assert.ok(page.events.some(e => e.kind === 'text_delta' && e.text === 'in-flight words'),
      'the in-flight ring event is returned');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_transcript: fromSeq cursor convention — 0 is inclusive of _seq 0, 1 starts later, omitted stays newest, nextFrom does not re-serve the boundary event', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'cursorconv', sid, lines: turnLines(12) });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    // fromSeq:0 is INCLUSIVE — reaches _seq 0 from disk, the opening
    // prompt, on a trimmed ring. Fails before Step 1's rename: pre-fix
    // (sinceSeq, exclusive) there was no value meaning "from the very
    // beginning" — sinceSeq:0 skipped _seq 0 itself.
    const fromStart = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 50 }));
    assert.equal(fromStart.events[0]._seq, 0, 'first served event is _seq 0');
    assert.equal(fromStart.events[0].kind, 'user_echo', '_seq 0 is the opening user_echo');
    assert.equal(fromStart.events[0].text, 'prompt 0', 'it is the opening prompt, not a later one');

    // fromSeq:1 starts at _seq 1 (inclusive semantics, just a higher floor).
    const fromOne = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 1, limit: 50 }));
    assert.equal(fromOne.events[0]._seq, 1, 'fromSeq:1 serves starting at _seq 1');

    // fromSeq omitted still returns the newest page — limit BELOW the
    // fixture's total event count so the trailing page (last 5) and a
    // forward-from-0 page (first 5) actually diverge; without the small
    // limit both would end at lastSeq and this assertion couldn't tell
    // "newest page" from "everything, coincidentally ending at the tail".
    const omitted = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, limit: 5 }));
    assert.ok(omitted.events.length > 0 && omitted.events.length < omitted.lastSeq + 1,
      `precondition: a small slice, not the fixture's whole history (got ${omitted.events.length} of ${omitted.lastSeq + 1} total)`);
    assert.equal(omitted.events[omitted.events.length - 1]._seq, omitted.lastSeq,
      'omitted fromSeq serves the trailing/newest page, not a forward page from the beginning');

    // nextFrom must be lastServedSeq + 1, NOT the last served seq itself —
    // under INCLUSIVE semantics, re-polling with the last served seq would
    // re-serve that same boundary event forever. Poll again with nextFrom
    // and confirm the boundary event does not reappear.
    const lastServed = fromStart.events[fromStart.events.length - 1]._seq;
    assert.equal(fromStart.nextFrom, lastServed + 1, 'nextFrom is lastServedSeq + 1, not an echo of lastServedSeq');
    const rePoll = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: fromStart.nextFrom, limit: 50 }));
    assert.equal(rePoll.events.length, 0, 'a caught-up re-poll with nextFrom returns nothing, not the repeated boundary event');
    assert.ok(!rePoll.events.some(e => e._seq === lastServed),
      're-polling with nextFrom does not re-serve the previous boundary event');

    // A stale/future fromSeq (already caught up, or further ahead than
    // anything real) must not echo the requested cursor back as nextFrom —
    // that would let a client with a bad cursor stay wedged on it forever.
    // It must snap to the true lastSeq + 1 instead.
    const trueLastSeq = fromStart.lastSeq;
    const stale = trueLastSeq + 1000;
    const staleQuery = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: stale }));
    assert.equal(staleQuery.events.length, 0, 'precondition: nothing exists past the stale cursor');
    assert.equal(staleQuery.nextFrom, trueLastSeq + 1,
      'nextFrom snaps to the true lastSeq + 1, not an echo of the stale input cursor');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_transcript: ring-first when fromSeq is at/above trimmedBefore (no out-of-bound request)', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'aaaaaaaa-9999-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'ringfirst', sid, lines: turnLines(12) });
    const inst = ctx.instances.get(id);
    const tb = inst.ring.trimmedBefore;
    assert.ok(tb > 0);

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: tb }));
    // Every returned event is in the retained window — disk wasn't needed.
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every(e => e._seq >= tb), 'all events come from the retained ring');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// A plan handed over as a PATH must survive ring eviction: a path that
// evaporates on the first disk-fallback read looks like it works right up
// until a fresh implementer is handed nothing. Replay re-derives it from the
// same jsonl's Write line (src/planFile.ts, threaded through transcript.ts).
test('get_recent_messages: a disk-sourced plan message keeps its planPath', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const planFile = path.join(ctx.tmpHome, '.claude', 'plans', 'seeded-plan.md');
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    await fs.writeFile(planFile, '# Seeded plan\n- step one\n');

    const lines = [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'plan this' } },
      { type: 'assistant', uuid: 'a0', message: { id: 'm_write', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: planFile, content: '# Seeded plan\n- step one\n' } },
      ] } },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_w', content: 'File written', is_error: false },
      ] } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm_plan', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_exit', name: 'ExitPlanMode', input: {} },
      ] } },
      ...textThenToolLines(30).slice(1),
    ];
    const sid = 'eeeeeeee-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'planevict', sid, lines });
    const inst = ctx.instances.get(id);
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');
    assert.ok(!inst.ringSnapshot().some(e => e.kind === 'plan_request'),
      'the plan_request is evicted from the ring (precondition)');

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid, count: 20 }));
    assert.equal(res.meta.source, 'disk', 'served from disk');
    const planMsg = res.messages.find(m => m.msgId === 'm_plan');
    assert.ok(planMsg, 'the evicted plan message came back from disk');
    assert.equal(planMsg.planPath, planFile, 'and it still names the plan document');
    assert.equal(planMsg.hasPlan, true);
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// ---------- `live` is not `source`: the LIVE-side mirror ----------
//
// `source` says where the BYTES came from; `live` says whether a process is
// behind them. This fixture is the state where the two disagree — a live worker
// whose ring evicted the range, so `source:'disk'` with `live:true` — and it is
// the only state in which conflating them is detectable.
//
// tests/mcp-retired-read.test.mjs asserts the NEGATIVE half (a retired session
// is never called active or waitable). These assertions are POSITIVE on purpose:
// a negative-only pair still passes when `live` is hardcoded false, since both
// wordings would then be the retired one.

// A user prompt then N tool-only assistant turns and NO text anywhere, so the
// disk merge still yields zero text messages while `omittedToolOnly` counts the
// tool-only ones — the state that generates the active/waitable wording.
function toolOnlyLines(toolCount) {
  const lines = [{ type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } }];
  for (let i = 0; i < toolCount; i++) {
    lines.push({ type: 'assistant', uuid: `at${i}`, message: { id: `mt${i}`, role: 'assistant', content: [
      { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${i}` } },
    ] } });
    lines.push({ type: 'user', uuid: `ut${i}`, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `tu${i}`, content: 'ok\n', is_error: false },
    ] } });
  }
  return lines;
}

test('a LIVE worker served from evicted disk history is still described as active and waitable', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'cafe0001-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'liveevicted', sid, lines: toolOnlyLines(30) });
    const inst = ctx.instances.get(id);

    // The state under test, asserted rather than assumed.
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed (precondition)');
    assert.ok(inst.proc, 'the worker is LIVE — this is what `source` alone cannot tell you');

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.source, 'disk', 'bytes came from disk...');
    assert.equal(res.meta.messages.length, 0, 'no text message anywhere in this transcript');
    assert.ok(res.meta.omittedToolOnly > 0, 'but tool-only messages were omitted (precondition)');
    assert.match(res.meta.hint, /the agent is active/,
      '...and the worker is nevertheless active: reading `source` as liveness would deny it');
    assert.doesNotMatch(res.meta.hint, /retired/);

    // The same disagreement on the forward path: this live source is still
    // working, so the conductor SHOULD be told to wait for its next turn_end.
    const targetSid = 'cafe0002-1111-2222-3333-444444444444';
    await bootResumed({ ctx, projectName: 'livetarget', sid: targetSid, lines: turnLines(2) });
    const refused = unwrap(await callTool(ctx.baseUrl, 'send_prompt', {
      sessionId: targetSid, forward: { sessionId: sid }, text: 'go',
    }));
    assert.equal(refused.code, 'NOTHING_TO_FORWARD');
    assert.match(refused.reason, /still working/);
    assert.match(refused.reason, /Wait for its next turn_end/,
      'a live source will produce one — withholding this advice loses a real forward');
    assert.doesNotMatch(refused.reason, /retired/);
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

// The RING half of the synthetic-tail cursor. tests/mcp-retired-read.test.mjs
// pins the disk pager; `pageCombined` splices `task_completion` for both, so the
// ring path needs its own page ending on a seq-less event.
test('get_transcript: a LIVE worker\'s page ending on a synthetic task_completion returns a usable nextFrom', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'cafe0003-1111-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'ringtasks', sid, lines: [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do two things' } },
      { type: 'assistant', uuid: 'a0', message: { id: 'm0', role: 'assistant', content: [
        { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'first', description: 'the first', activeForm: 'doing first' } },
      ] } },
      { type: 'user', uuid: 'r0', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created' },
      ] } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ] } },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
      ] } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'both done' }] } },
    ] });
    const inst = ctx.instances.get(id);
    assert.equal(inst.ring.trimmedBefore, 0, 'nothing evicted — this is the RING path (precondition)');

    const whole = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 200 }));
    assert.equal(whole.source, 'ring', 'served from the ring, not the disk pager');
    const at = whole.events.findIndex(e => e.kind === 'task_completion');
    assert.ok(at > 0, `fixture must produce a task_completion: ${JSON.stringify(whole.events.map(e => e.kind))}`);
    assert.equal(whole.events[at]._seq, undefined, 'synthetic events carry no _seq');
    const anchorSeq = whole.events[at - 1]._seq;
    assert.equal(typeof anchorSeq, 'number');

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', {
      sessionId: sid, fromSeq: 0, limit: anchorSeq + 1,
    }));
    assert.equal(page.source, 'ring');
    assert.equal(page.events[page.events.length - 1].kind, 'task_completion',
      'the page must END on the synthetic event, or this test proves nothing');

    assert.equal(page.nextFrom, anchorSeq + 1,
      'the cursor comes from the last event that HAS a _seq, not from the array tail');
    assert.equal(Number.isFinite(page.nextFrom), true, 'never NaN/null — that would strand the poller');

    const rest = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: page.nextFrom, limit: 200 }));
    assert.ok(rest.events.length > 0, 'paging continues past the synthetic event');
    assert.equal(rest.events[0]._seq, anchorSeq + 1, 'no event is skipped and none is re-served');
  } finally { await ctx.close(); }
});
