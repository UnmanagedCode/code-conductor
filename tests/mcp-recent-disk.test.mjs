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
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

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
    await callTool(ctx.baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });

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

    // sinceSeq:0 points below trimmedBefore — the dropped range must come from
    // disk, NOT be silently skipped (the bug). events start in the dropped range.
    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, sinceSeq: 0, limit: 50 }));
    assert.ok(page.events.length > 0);
    assert.ok(page.events[0]._seq < page.trimmedBefore,
      `first event _seq (${page.events[0]._seq}) is in the dropped range (< trimmedBefore ${page.trimmedBefore}) — served from disk`);
    // Earliest replies (long evicted from the ring) are recoverable.
    const texts = page.events.filter(e => e.kind === 'text_delta').map(e => e.text);
    assert.ok(texts.includes('reply 0'), 'oldest reply served from disk');
    // Oldest-first, contiguous, with a forward cursor to continue.
    for (let i = 1; i < page.events.length; i++) assert.ok(page.events[i]._seq > page.events[i - 1]._seq);
    assert.equal(typeof page.hasMore, 'boolean');
    assert.equal(page.nextAfter, page.events[page.events.length - 1]._seq);
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

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, sinceSeq: lastSeqBefore }));
    assert.ok(page.events.some(e => e.kind === 'text_delta' && e.text === 'in-flight words'),
      'the in-flight ring event is returned');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('get_transcript: ring-first when sinceSeq is at/above trimmedBefore (no out-of-bound request)', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  const ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
  try {
    const sid = 'aaaaaaaa-9999-2222-3333-444444444444';
    const id = await bootResumed({ ctx, projectName: 'ringfirst', sid, lines: turnLines(12) });
    const inst = ctx.instances.get(id);
    const tb = inst.ring.trimmedBefore;
    assert.ok(tb > 0);

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, sinceSeq: tb }));
    // Every returned event is in the retained window — disk wasn't needed.
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every(e => e._seq >= tb), 'all events come from the retained ring');
  } finally {
    await ctx.close();
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});
