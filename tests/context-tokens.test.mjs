// The context-used figure: `Instance.summary().contextTokens`, the turn-end
// line's `contextTokens`/`contextWindowTokens` stamp, and the MCP `context` line.
//
// The figure is the latest TOP-LEVEL API call's prompt (input + cache_read +
// cache_creation), read off the same latch the header chip uses. A compaction,
// a `/clear` rotation and a model switch each clear it.
//
// Fixture provenance: tests/fixtures/scenario-context-calls.json is one real
// top-level turn captured from Claude Code 2.1.284 stream-json stdout
// (`--include-partial-messages`) on claude-sonnet-5-5, trimmed to four of its
// API calls: thinking + 8 parallel Reads; thinking + text + a foreground Agent
// with a parallel Bash and 3 Reads (the subagent's parent-tagged envelopes and
// task_progress/task_notification frames kept); thinking + text + Bash +
// SendMessage; and a final thinking + text call, then the `result`. Every
// message_start/message_delta usage block, message id, parent_tool_use_id and
// the Agent tool_use_result totals are as captured. Each block's deltas are
// collapsed to one, text, tool inputs and tool results are placeholders,
// session ids are `$SID`, envelope uuids are synthetic, and the capture's
// status / rate-limit / hook / thinking_tokens frames are dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Instance } from '../src/instances.ts';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-context-calls.json');
const MODEL = 'claude-sonnet-5-5';

const promptOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

// The fixture's own top-level calls, in order: what every expectation below is
// derived from, so a value in an assertion can be traced to the capture.
const FIXTURE = JSON.parse(await fs.readFile(SCENARIO, 'utf8'));
const EMIT = FIXTURE.turns[0].emit;
const CALLS = (() => {
  const calls = [];
  for (const l of EMIT) {
    if (l.type !== 'stream_event' || l.parent_tool_use_id) continue;
    if (l.event.type === 'message_start') calls.push({ msgId: l.event.message.id, start: l.event.message.usage, delta: null });
    if (l.event.type === 'message_delta') calls.at(-1).delta = l.event.usage;
  }
  return calls;
})();
const LAST_PROMPT = promptOf(CALLS.at(-1).start);
const RESULT = EMIT.find(l => l.type === 'result');
const AGENT_RESULT = EMIT.find(l => l.type === 'user' && l.tool_use_result?.totalTokens != null);
const SUBAGENT_PROMPTS = EMIT
  .filter(l => l.type === 'assistant' && l.parent_tool_use_id && l.message?.usage)
  .map(l => promptOf(l.message.usage));

test('fixture premises: four top-level calls, a subagent, and the Agent totals as captured', () => {
  assert.equal(CALLS.length, 4);
  assert.ok(CALLS.every(c => c.delta), 'every top-level call ends in a message_delta with usage');
  assert.equal(LAST_PROMPT, 90_748);
  assert.ok(SUBAGENT_PROMPTS.length > 0, 'at least one parent-tagged assistant carries usage');
  assert.ok(EMIT.some(l => l.type === 'user' && l.parent_tool_use_id), 'at least one parent-tagged user envelope');
  assert.equal(AGENT_RESULT.tool_use_result.totalTokens, 123_873);
  assert.equal(AGENT_RESULT.tool_use_result.totalToolUseCount, 11);
  // The figures the turn-end reading must NOT be confused with all differ from it.
  for (const other of [promptOf(RESULT.usage), AGENT_RESULT.tool_use_result.totalTokens, ...SUBAGENT_PROMPTS]) {
    assert.notEqual(other, LAST_PROMPT);
  }
});

// ── the live scenario, end to end ──────────────────────────────────────────

async function wsClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    messages,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred) => waitFor(() => messages.find(pred), { timeout: 8000 }),
    close: () => new Promise(r => { ws.once('close', r); ws.close(); }),
  };
}

// Boot, spawn on the capture's model, run the one scenario turn over a real WS.
// Returns the live feed's events and the handles the tests read.
// Teardown runs newest-first: a WS client must close before its server.
function cleanups(t) {
  const fns = [];
  t.after(async () => { for (const fn of fns.reverse()) await fn(); });
  return (fn) => fns.push(fn);
}

async function runScenario(t, scenarioPath = SCENARIO, onCleanup = cleanups(t)) {
  const ctx = await bootServer({ scenarioPath });
  onCleanup(() => ctx.close());
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions', model: MODEL });
  assert.ok(created.body?.id, JSON.stringify(created.body));
  const id = created.body.id;
  const inst = ctx.instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const before = (await api(ctx.baseUrl, 'GET', '/api/instances')).body.find(r => r.id === id);
  const ws = await wsClient(ctx.wsUrl);
  onCleanup(() => ws.close());
  ws.send({ t: 'subscribe', id });
  await ws.wait(m => m.t === 'snapshot' && m.id === id);
  ws.send({ t: 'prompt', id, text: 'go' });
  await ws.wait(m => m.t === 'event' && m.id === id && m.ev?.kind === 'turn_end');
  await waitFor(() => inst.status === 'idle');
  const events = ws.messages.filter(m => m.t === 'event' && m.id === id).map(m => m.ev);
  let n = 0;
  const mcpText = async (name, args) => {
    const res = await fetch(ctx.baseUrl + '/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, JSON.stringify(body));
    return body.result.content[0].text;
  };
  return { ctx, id, inst, before, events, mcpText };
}

test('live: turn_end, /api/instances and MCP all report the last top-level call\'s prompt', async (t) => {
  const { ctx, id, inst, before, events, mcpText } = await runScenario(t);

  assert.equal(before.contextTokens, null, 'nothing has measured the context before the first turn');

  const turnEnd = events.find(e => e.kind === 'turn_end');
  assert.equal(turnEnd.contextTokens, LAST_PROMPT,
    'the reading is the LAST top-level call\'s prompt — not the result sum, a subagent call, or the Agent total');
  assert.equal(turnEnd.contextWindowTokens, inst.summary().contextWindowTokens);
  assert.equal(turnEnd.contextWindowTokens, 1_000_000, 'premise: the capture\'s model resolves a known window');

  const row = (await api(ctx.baseUrl, 'GET', '/api/instances')).body.find(r => r.id === id);
  assert.equal(row.contextTokens, LAST_PROMPT);

  const line = `context ${LAST_PROMPT} / 1000000 (9%)`;
  assert.ok((await mcpText('list_sessions', {})).includes(line), 'list_sessions renders the context line');
  assert.ok((await mcpText('describe_session', { sessionId: inst.sessionId })).includes(line),
    'describe_session\'s live branch renders the same line');
});

test('live: the latch after the turn is the last top-level message_start usage, untouched by the subagent', async (t) => {
  const { inst } = await runScenario(t);
  assert.deepEqual(inst.lastContextUsage, CALLS.at(-1).start);
});

test('live: a run without the subagent envelopes ends on the same reading', async (t) => {
  const stripped = structuredClone(FIXTURE);
  stripped.turns[0].emit = EMIT.filter(l => !l.parent_tool_use_id);
  assert.ok(stripped.turns[0].emit.length < EMIT.length, 'premise: something was stripped');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ctx-nosub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scenario.json');
  await fs.writeFile(file, JSON.stringify(stripped));

  const onCleanup = cleanups(t);
  const withSub = await runScenario(t, SCENARIO, onCleanup);
  const withoutSub = await runScenario(t, file, onCleanup);
  assert.equal(withSub.inst.summary().contextTokens, withoutSub.inst.summary().contextTokens);
  assert.equal(withoutSub.inst.summary().contextTokens, LAST_PROMPT);
});

// ── what clears the reading: a bare Instance driven line by line ───────────

const SID = 'sess-ctx-tokens';
const READING = { input_tokens: 10, cache_read_input_tokens: 27_000, cache_creation_input_tokens: 37, output_tokens: 5 };

const msgStartLine = (id, usage, model) => JSON.stringify({
  type: 'stream_event', parent_tool_use_id: null,
  event: { type: 'message_start', message: { id, role: 'assistant', usage, ...(model ? { model } : {}) } },
});

async function makeInstance(t, { model = 'claude-haiku-4-5' } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ctx-tokens-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const inst = new Instance({
    id: 'inst-ctx', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model,
  });
  inst.backingSessionId = SID;
  const events = [];
  inst.on('event', (ev) => events.push(ev));
  return { inst, events };
}

// The real manual `/compact` stdout: init, compact_boundary, the summary user
// frames, an all-zero result. Its init names its own session, so the instance
// adopts that id as its backing id to keep the init a re-report.
const COMPACT_LINES = (await fs.readFile(path.join(__dirname, 'fixtures', 'compaction-manual.stdout.jsonl'), 'utf8'))
  .split('\n').filter(l => l.trim());
const COMPACT_SID = COMPACT_LINES.map(l => JSON.parse(l)).find(o => o.subtype === 'init').session_id;

test('clears: the real compact_boundary drops the reading, and the /compact turn_end says so', async (t) => {
  const { inst, events } = await makeInstance(t);
  inst.backingSessionId = COMPACT_SID;
  inst._handleStdoutLine(msgStartLine('m-pre', READING));
  assert.equal(inst.summary().contextTokens, 27_047, 'premise: the pre-compaction reading is latched');

  const boundaryAt = COMPACT_LINES.findIndex(l => JSON.parse(l).subtype === 'compact_boundary');
  for (const l of COMPACT_LINES.slice(0, boundaryAt)) inst._handleStdoutLine(l);
  assert.equal(inst.summary().contextTokens, 27_047, 'premise: nothing before the boundary clears it');
  inst._handleStdoutLine(COMPACT_LINES[boundaryAt]);
  assert.equal(inst.summary().contextTokens, null, 'the compacted context has not been measured yet');
  assert.equal(inst.lastContextUsage, null);

  for (const l of COMPACT_LINES.slice(boundaryAt + 1)) inst._handleStdoutLine(l);
  const turnEnd = events.find(e => e.kind === 'turn_end');
  assert.ok(turnEnd, 'premise: the capture ends in a result');
  assert.equal(turnEnd.contextTokens, null);
});

test('clears: a /clear rotation (an init naming a new session) drops the reading', async (t) => {
  const { inst } = await makeInstance(t);
  inst._handleStdoutLine(msgStartLine('m1', READING));
  assert.equal(inst.summary().contextTokens, 27_047, 'premise');
  inst._handleStdoutLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-after-clear' }));
  assert.equal(inst.backingSessionId, 'sess-after-clear', 'premise: the init was a rotation');
  assert.equal(inst.summary().contextTokens, null);
});

test('keeps: an init re-reporting the same session clears nothing', async (t) => {
  const { inst } = await makeInstance(t);
  inst._handleStdoutLine(msgStartLine('m1', READING));
  inst._handleStdoutLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: SID }));
  assert.equal(inst.summary().contextTokens, 27_047);
  assert.deepEqual(inst.lastContextUsage, READING);
});

test('clears: a model switch drops the reading from the summary too', async (t) => {
  const { inst } = await makeInstance(t);
  inst._handleStdoutLine(msgStartLine('m1', READING));
  inst._announceModelSwitch('claude-haiku-4-5', 'claude-sonnet-5');
  assert.equal(inst.summary().contextTokens, null);
});
