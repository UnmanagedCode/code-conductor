// 2026-0173: get_recent_messages must not let an oversized tool_use argument
// (e.g. a Write's `content`) ride verbatim into the metadata block on a
// default (includeToolCalls:false) read — that's the wake-fold path a
// conductor's context is built from. Three groups:
//   A — capBlockInput unit tests (no server)
//   B — end-to-end through the real MCP transport (retired-session read)
//   C — the idle wake fold inherits the slim default

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capBlockInput, TOOL_ARG_VALUE_CAP, MSG_TEXT_CAP } from '../src/mcp/messageReconstruction.ts';
import { bootServer, api, waitFor, instForSession, seedSessionJsonl, driveTurn } from './helpers.mjs';
import { InstanceManager } from '../src/instances.ts';
import { buildRecentMessages } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

// ---------------------------------------------------------------------------
// Group A — capBlockInput unit tests
// ---------------------------------------------------------------------------

// Ownership + the turn that arms it. `noteDispatch` records the ownership edge;
// the ARM happens when the target enters a turn — in production that is
// Instance._setStatus's 'turn_start' emit, which these injected fakes never run,
// so the test drives onTurnStart directly.
function armWake(instances, callerSid, targetSid, timeoutMs) {
  instances.noteDispatch(callerSid, targetSid, timeoutMs);
  instances._idleHub.onTurnStart(instances.liveForSession(targetSid).id);
}

test('A1: default — an oversized string argument becomes an omitted-marker and the block is flagged', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'Write', toolUseId: 't', input: { file_path: '/p/plan.md', content: 'P'.repeat(15699) } }, false);
  assert.equal(out.input.content, '[omitted: string, 15699 bytes]');
  assert.equal(out.inputTruncated, true);
});

test('A2: default — a small argument beside an omitted one still rides verbatim', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'Write', toolUseId: 't', input: { file_path: '/p/plan.md', content: 'P'.repeat(15699) } }, false);
  assert.equal(out.input.file_path, '/p/plan.md');
});

test('A3: default — a string of exactly TOOL_ARG_VALUE_CAP bytes rides verbatim; one byte more does not', () => {
  const at = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { a: 'a'.repeat(TOOL_ARG_VALUE_CAP) } }, false);
  assert.equal(at.input.a, 'a'.repeat(TOOL_ARG_VALUE_CAP));
  assert.equal(at.inputTruncated, false);

  const over = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { a: 'a'.repeat(TOOL_ARG_VALUE_CAP + 1) } }, false);
  assert.equal(over.input.a, `[omitted: string, ${TOOL_ARG_VALUE_CAP + 1} bytes]`);
  assert.equal(over.inputTruncated, true);
});

test('A4: default — numbers, booleans and null ride verbatim', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { n: 42, b: true, f: false, z: null } }, false);
  assert.deepEqual(out.input, { n: 42, b: true, f: false, z: null });
  assert.equal(out.inputTruncated, false);
});

test('A5: default — an explicitly-undefined argument does not throw and serialises away', () => {
  assert.doesNotThrow(() => capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { a: undefined, file_path: '/x' } }, false));
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { a: undefined, file_path: '/x' } }, false);
  const roundTripped = JSON.parse(JSON.stringify(out)).input;
  assert.ok(!Object.hasOwn(roundTripped, 'a'), 'an explicitly-undefined argument serialises away, not as null');
});

test('A6: default — a small nested object rides whole, un-recursed', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { opts: { a: 1, b: 'two' } } }, false);
  assert.deepEqual(out.input.opts, { a: 1, b: 'two' });
});

test('A7: default — an oversized array collapses to ONE array marker, not per-element descriptors', () => {
  const edits = Array.from({ length: 4 }, (_, i) => ({ old_string: 'x'.repeat(200), new_string: 'y'.repeat(200), n: i }));
  const out = capBlockInput({ type: 'tool_use', name: 'MultiEdit', toolUseId: 't', input: { file_path: '/p.ts', edits } }, false);
  assert.match(out.input.edits, /^\[omitted: array, 4 items, \d+ bytes of JSON\]$/);
  assert.equal(out.input.file_path, '/p.ts');
});

test('A8: default — a huge array of individually-small strings collapses to one marker', () => {
  const items = Array.from({ length: 5000 }, (_, i) => 's' + i);
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { items } }, false);
  assert.match(out.input.items, /^\[omitted: array, 5000 items, \d+ bytes of JSON\]$/);
});

test('A9: default — an oversized object collapses to an object marker naming its key count', () => {
  const cfg = {};
  for (let i = 0; i < 40; i++) cfg['k' + i] = 'v'.repeat(30);
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input: { cfg } }, false);
  assert.match(out.input.cfg, /^\[omitted: object, 40 keys, \d+ bytes of JSON\]$/);
});

test('A10: includeToolCalls:true returns the whole input unchanged below MSG_TEXT_CAP', () => {
  const big = 'P'.repeat(15699);
  const out = capBlockInput({ type: 'tool_use', name: 'Write', toolUseId: 't', input: { file_path: '/p/plan.md', content: big } }, true);
  assert.equal(out.input.content, big);
  assert.equal(out.inputTruncated, false);
});

test('A11: includeToolCalls:true still truncates the whole input at MSG_TEXT_CAP', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'Write', toolUseId: 't', input: { content: 'y'.repeat(40 * 1024) } }, true);
  assert.equal(typeof out.input, 'string');
  assert.equal(Buffer.byteLength(out.input, 'utf8'), MSG_TEXT_CAP);
  assert.equal(out.inputTruncated, true);
});

test('A12: an input with thousands of individually-small arguments still bounds the descriptor at MSG_TEXT_CAP', () => {
  // Each arg rides verbatim under the per-argument cap (so no mutant killing
  // the per-argument gate is exercised here) — the invariant this test pins is
  // the OUTER capText(json, MSG_TEXT_CAP) call on the assembled descriptor.
  const input = {};
  for (let i = 0; i < 5000; i++) input['k' + i] = 'v'.repeat(20); // well under TOOL_ARG_VALUE_CAP each
  const out = capBlockInput({ type: 'tool_use', name: 'X', toolUseId: 't', input }, false);
  const bytes = typeof out.input === 'string' ? Buffer.byteLength(out.input, 'utf8') : Buffer.byteLength(JSON.stringify(out.input), 'utf8');
  assert.ok(bytes <= MSG_TEXT_CAP, `descriptor must be bounded by MSG_TEXT_CAP, got ${bytes}`);
  assert.equal(out.inputTruncated, true, 'the outer cap must have bitten (typeof input becomes string)');
  assert.equal(typeof out.input, 'string');
});

test('A13: a thinking block is unchanged on both paths', () => {
  const a = capBlockInput({ type: 'thinking', text: 'Pondering.' }, false);
  const b = capBlockInput({ type: 'thinking', text: 'Pondering.' }, true);
  assert.deepEqual(a, { type: 'thinking', text: 'Pondering.', inputTruncated: false });
  assert.deepEqual(b, { type: 'thinking', text: 'Pondering.', inputTruncated: false });
});

test('A14: type, name and toolUseId survive the descriptor', () => {
  const out = capBlockInput({ type: 'tool_use', name: 'Write', toolUseId: 't', input: { file_path: '/p/plan.md', content: 'P'.repeat(15699) } }, false);
  assert.equal(out.type, 'tool_use');
  assert.equal(out.name, 'Write');
  assert.equal(out.toolUseId, 't');
});

// ---------------------------------------------------------------------------
// Group B — end-to-end through the real MCP transport (retired session)
// ---------------------------------------------------------------------------

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
function unwrapMsgs(result) {
  const meta = JSON.parse(result.content[0].text);
  const bodies = result.content.slice(1).map(c => c.text);
  return { meta, bodies, messages: meta.messages.map((m, i) => ({ ...m, text: bodies[i] ?? '' })) };
}

async function retiredWorkerWithLines(ctx, projectName, lines) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
    project: projectName, mode: 'bypassPermissions',
  }));
  const sid = spawn.sessionId;
  await waitFor(() => instForSession(ctx.instances, sid)?.status === 'idle');
  await driveTurn(ctx.instances, sid, () =>
    callTool(ctx.baseUrl, 'send_prompt', { sessionId: sid, text: 'go' }));

  const projectPath = path.join(ctx.projectsRoot, projectName);
  await seedSessionJsonl(ctx.claudeProjectsRoot, projectPath, instForSession(ctx.instances, sid).backingSessionId, lines);

  const killed = unwrap(await callTool(ctx.baseUrl, 'kill_instance', { sessionId: sid }));
  assert.notEqual(killed.ok, false, `kill_instance refused: ${JSON.stringify(killed)}`);
  await waitFor(() => ctx.instances.idsForSession(sid).length === 0);
  return sid;
}

const PLAN_PATH = '/home/node/.claude/plans/cosmic-plum.md';
const BIG = 'P'.repeat(15699); // the observed field size, under MSG_TEXT_CAP
const LONG_CMD = 'echo ' + 'z'.repeat(600); // 605 bytes — over the arg cap, tiny overall
const LINES = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'write the plan' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_plan', role: 'assistant', content: [
    { type: 'text', text: 'Plan written. Handing the path to the implementer now.' },
    { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: PLAN_PATH, content: BIG } },
    { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: LONG_CMD, description: 'long command' } },
  ] } },
];

test('B1: the card\'s regression — a 15.7 KB Write argument does not reach the metadata block on a default read', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b1proj', LINES);
    const result = await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid });
    const metaText = result.content[0].text;
    assert.ok(!metaText.includes('P'.repeat(1000)), 'the big Write payload must not ride verbatim in the metadata block');
    assert.ok(Buffer.byteLength(metaText, 'utf8') < 2000, `metadata block should be small, got ${Buffer.byteLength(metaText, 'utf8')} bytes`);
  } finally { await ctx.close(); }
});

test('B2: a default read still surfaces the plan path the conductor hands on', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b2proj', LINES);
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.messages[0].blocks[0].input.file_path, PLAN_PATH);
  } finally { await ctx.close(); }
});

test('B3: a default read marks the omitted argument and flags the block', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b3proj', LINES);
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.messages[0].blocks[0].input.content, '[omitted: string, 15699 bytes]');
    assert.equal(res.meta.messages[0].blocks[0].inputTruncated, true);
  } finally { await ctx.close(); }
});

test('B4: EVERY block in a message is described, not just the first', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b4proj', LINES);
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    const blocks = res.meta.messages[0].blocks;
    assert.equal(blocks[1].name, 'Bash');
    assert.equal(blocks[1].input.command, '[omitted: string, 605 bytes]');
    assert.equal(blocks[1].input.description, 'long command');
  } finally { await ctx.close(); }
});

test('B5: the message is still selected — the prose that made it text-bearing is untouched', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b5proj', LINES);
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.messages.length, 1);
    assert.match(res.bodies.join('\n'), /Plan written\./);
    assert.equal(res.meta.messages[0].hasToolUse, true);
  } finally { await ctx.close(); }
});

test('B6: includeToolCalls:true returns both tool inputs verbatim', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b6proj', LINES);
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid, includeToolCalls: true }));
    const blocks = res.meta.messages[0].blocks;
    assert.equal(blocks[0].input.content, BIG);
    assert.equal(blocks[0].inputTruncated, false);
    assert.equal(blocks[1].input.command, LONG_CMD);
  } finally { await ctx.close(); }
});

const HUGE_LINES = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'write a huge file' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_huge', role: 'assistant', content: [
    { type: 'text', text: 'Wrote the file.' },
    { type: 'tool_use', id: 'tu_huge', name: 'Write', input: { file_path: '/tmp/a.md', content: 'y'.repeat(40 * 1024) } },
  ] } },
];

test('B7: a 40 KB argument is marked on the default read and still MSG_TEXT_CAP-truncated under includeToolCalls:true', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredWorkerWithLines(ctx, 'b7proj', HUGE_LINES);

    const def = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(def.meta.messages[0].blocks[0].input.content, '[omitted: string, 40960 bytes]');
    assert.equal(def.meta.messages[0].blocks[0].input.file_path, '/tmp/a.md');

    const verbatim = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid, includeToolCalls: true }));
    assert.equal(typeof verbatim.meta.messages[0].blocks[0].input, 'string');
    assert.equal(verbatim.meta.messages[0].blocks[0].inputTruncated, true);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// Group C — the idle wake fold inherits the slim default
// ---------------------------------------------------------------------------

function makeFake({ id, sessionId }) {
  const _promptCalls = [];
  const inst = {
    id, sessionId, project: 'test-project', proc: { pid: 999 }, status: 'idle',
    activeAgentTaskCount: 0, taskNotificationPending: false,
    _emitUi() {},
    ring: { trimmedBefore: 0 },
    ringSnapshot() {
      return [
        { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'Plan written. Handing the path to the implementer now.', _seq: 0 },
        { kind: 'tool_use', msgId: 'm1', name: 'Write', input: { file_path: '/p/plan.md', content: 'P'.repeat(15699) }, toolUseId: 'tu1', _seq: 1 },
      ];
    },
    async prompt(text, _atts, opts) { _promptCalls.push({ text, opts }); },
  };
  inst._promptCalls = _promptCalls;
  return inst;
}

function emitTurnEnd(instances, id) {
  instances.emit('event', { id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
}
const tick = () => new Promise(r => setTimeout(r, 20));

test('C1: the idle-wake fold inherits the slim default — a worker\'s big Write never reaches the conductor\'s prompt', async () => {
  const instances = new InstanceManager();
  try {
    const cond = makeFake({ id: 'c1', sessionId: 'cs1' });
    const work = makeFake({ id: 'w1', sessionId: 'ws1' });
    instances.byId.set(cond.id, cond);
    instances.byId.set(work.id, work);
    armWake(instances, 'cs1', 'ws1');

    emitTurnEnd(instances, 'w1');
    await tick();

    assert.equal(cond._promptCalls.length, 1);
    const text = cond._promptCalls[0].text;
    assert.ok(!text.includes('P'.repeat(1000)), 'the big Write payload must not reach the conductor\'s prompt');
    assert.ok(text.length < 3000, `folded stub should be small, got ${text.length} chars`);
  } finally { await instances.shutdown().catch(() => {}); }
});

test('C2: the folded wake still carries the plan path and the omitted-marker', async () => {
  const instances = new InstanceManager();
  try {
    const cond = makeFake({ id: 'c2', sessionId: 'cs2' });
    const work = makeFake({ id: 'w2', sessionId: 'ws2' });
    instances.byId.set(cond.id, cond);
    instances.byId.set(work.id, work);
    armWake(instances, 'cs2', 'ws2');

    emitTurnEnd(instances, 'w2');
    await tick();

    const text = cond._promptCalls[0].text;
    assert.ok(text.includes('/p/plan.md'), 'the plan path should survive in the fold');
    assert.ok(text.includes('[omitted: string, 15699 bytes]'), 'the omitted-marker should survive in the fold');
  } finally { await instances.shutdown().catch(() => {}); }
});
