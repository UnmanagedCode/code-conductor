// Integration tests for the PreToolUse http hook callback — the
// orchestrator-side REST endpoint that the Claude Code CLI POSTs to
// before running a mutating tool. For a local session the endpoint allows
// every call; an unknown instance gets a deny.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { READ_NUDGE_MATCHER, readNudgeText } from '../src/conductorReadNudge.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_TURN_OPEN = path.join(__dirname, 'fixtures', 'scenario-conductor-turn-open.json');

let ctx, baseUrl, wsUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, wsUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.once('open', () => resolve({
      ws, messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(p, timeout = 4000) { return waitFor(() => messages.find(p), { timeout }); },
    }));
  });
}

function buildHookEnvelope({ toolUseId = 'tu_hook_1', toolName = 'Write', toolInput } = {}) {
  return {
    session_id: 'sess-test',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/cwd',
    permission_mode: 'bypassPermissions',
    effort: { level: 'high' },
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput ?? { file_path: '/tmp/cwd/hello.txt', content: 'hi' },
    tool_use_id: toolUseId,
  };
}

test('hook-callback auto-allows for a local session (code/bypassPermissions)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const callback = await api(
    baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
    buildHookEnvelope({ toolUseId: 'tu_a' }),
  );
  assert.equal(callback.status, 200);
  assert.equal(callback.body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'allow');
});

test('hook-callback in plan mode auto-allows (plan-mode CLI will deny on its own; orchestrator does not gate)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'plan' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const callback = await api(
    baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
    buildHookEnvelope({ toolUseId: 'tu_p' }),
  );
  assert.equal(callback.status, 200);
  assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'allow');
});

// Pins that the WS protocol has no hook_decision frame: it gets the generic
// unknown-message-type reply like any other unrecognised `t`.
test('a hook_decision WS frame gets the unknown message type reply', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'hook_decision', id, toolUseId: 'tu_x', allow: true, reqId: 'r1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'unknown message type: hook_decision');
  } finally {
    await c.close();
  }
});

test('hook-callback for an unknown instance id replies 200 + deny (CLI auto-deny path)', async () => {
  const r = await api(
    baseUrl, 'POST', `/api/instances/missing-instance-id/hook-callback`,
    buildHookEnvelope(),
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.hookSpecificOutput.permissionDecision, 'deny');
});

// ── Conductor read nudge (src/conductorReadNudge.ts) ─────────────────────────
// A conductor's settings carry a second, anchored PreToolUse entry on
// project_read/project_bash/spawn_instance/send_prompt. The broker answers it
// with NO permission decision — `{}`, or `additionalContext` alone at the 8th
// and 16th counted call of a run — and emits a visible system/read_nudge event.

const READ = 'mcp__code-conductor__project_read';
const SEND = 'mcp__code-conductor__send_prompt';
const NUDGE_BODY = (n) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: readNudgeText(n) } });

async function spawnConductor({ mode = 'bypassPermissions' } = {}) {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: '.conduct', temp: true, mode });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

async function hook(id, toolName, toolUseId, extra = {}) {
  const r = await api(baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
    { ...buildHookEnvelope({ toolUseId, toolName, toolInput: {} }), ...extra });
  assert.equal(r.status, 200);
  return r.body;
}

const settingsArg = (inst) => inst._spawnArgv[inst._spawnArgv.indexOf('--settings') + 1];
const ringNudges = (inst) => inst.ring.toArray().filter(ev => ev.kind === 'system' && ev.subtype === 'read_nudge');

test('conductor spawn argv carries the nudge hook; a worker\'s does not', async () => {
  const cond = await spawnConductor();
  const s = JSON.parse(settingsArg(cond));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[1].matcher, READ_NUDGE_MATCHER);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].url, cond.hookCallbackUrl);

  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  const worker = instances.get(r.body.id);
  await waitFor(() => worker.status === 'idle');
  assert.equal(settingsArg(worker),
    `{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash","hooks":[{"type":"http","url":${JSON.stringify(worker.hookCallbackUrl)},"timeout":660}]}]}}`,
    'a worker\'s settings are byte-identical to what they were');
});

test('conductor: pass path has no permission decision; 8th and 16th calls nudge', async () => {
  const cond = await spawnConductor();
  for (let n = 1; n <= 16; n++) {
    const body = await hook(cond.id, READ, `tu_r${n}`);
    if (n === 8 || n === 16) assert.deepEqual(body, NUDGE_BODY(n), `call ${n} carries additionalContext alone`);
    else assert.deepEqual(body, {}, `call ${n} answers {} — no permission decision`);
    if (n === 4) {
      assert.deepEqual(await hook(cond.id, 'mcp__code-conductor__project_diff', 'tu_d'), {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      }, 'project_diff is not a nudge tool: it takes the ordinary path and does not count');
    }
  }
});

test('conductor in plan mode: still no permission decision', async () => {
  const cond = await spawnConductor({ mode: 'plan' });
  assert.deepEqual(await hook(cond.id, READ, 'tu_plan'), {});
  assert.deepEqual(await hook(cond.id, SEND, 'tu_plan_send'), {});
});

test('nudge is a visible UI event', async () => {
  const cond = await spawnConductor();
  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'subscribe', id: cond.id });
    await c.wait(m => m.t === 'snapshot');
    for (let n = 1; n <= 8; n++) await hook(cond.id, READ, `tu_v${n}`);
    const frame = await c.wait(m => m.t === 'event' && m.ev?.kind === 'system' && m.ev.subtype === 'read_nudge');
    assert.equal(frame.ev.toolUseId, 'tu_v8');
    assert.equal(frame.ev.data.count, 8);
    assert.equal(frame.ev.data.tool, READ);
    assert.equal(frame.ev.data.text, readNudgeText(8));
    const inRing = ringNudges(cond);
    assert.equal(inRing.length, 1);
    assert.equal(inRing[0].toolUseId, 'tu_v8');
  } finally {
    await c.close();
  }
});

test('subagent calls are ignored', async () => {
  const cond = await spawnConductor();
  for (let n = 1; n <= 8; n++) {
    assert.deepEqual(await hook(cond.id, READ, `tu_sa${n}`, { agent_id: 'agent-1' }), {});
  }
  assert.equal(ringNudges(cond).length, 0, 'no event for a subagent run');
  for (let n = 1; n <= 7; n++) assert.deepEqual(await hook(cond.id, READ, `tu_m${n}`), {});
  // A subagent's delegation does not reset the main thread's run either.
  assert.deepEqual(await hook(cond.id, SEND, 'tu_sa_send', { agent_id: 'agent-1' }), {});
  assert.deepEqual(await hook(cond.id, READ, 'tu_m8'), NUDGE_BODY(8),
    'the subagent calls neither counted nor reset: the 8th main-thread call nudges');
});

test('a new turn resets the run', async () => {
  const cond = await spawnConductor();
  for (let n = 1; n <= 7; n++) await hook(cond.id, READ, `tu_a${n}`);
  await cond.prompt('go');
  await waitFor(() => cond.ring.toArray().some(ev => ev.kind === 'turn_end'));
  await waitFor(() => cond.status === 'idle');
  for (let n = 1; n <= 7; n++) assert.deepEqual(await hook(cond.id, READ, `tu_b${n}`), {}, `post-turn call ${n}`);
  assert.deepEqual(await hook(cond.id, READ, 'tu_b8'), NUDGE_BODY(8));
});

test('a mid-turn steer does not reset the run', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_TURN_OPEN;
  try {
    const cond = await spawnConductor();
    await cond.prompt('first');
    await waitFor(() => cond.ring.toArray().some(ev => ev.kind === 'message_start'));
    assert.equal(cond.status, 'turn');
    for (let n = 1; n <= 7; n++) await hook(cond.id, READ, `tu_s${n}`);
    await cond.prompt('steer');
    assert.equal(cond.status, 'turn', 'the steer joined the running turn');
    assert.deepEqual(await hook(cond.id, READ, 'tu_s8'), NUDGE_BODY(8));
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('worker hook behaviour unchanged', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  await waitFor(() => instances.get(r.body.id).status === 'idle');
  for (let n = 1; n <= 8; n++) {
    assert.deepEqual(await hook(r.body.id, READ, `tu_w${n}`), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }, `worker call ${n} gets today's explicit allow`);
  }
  assert.equal(ringNudges(instances.get(r.body.id)).length, 0);
});
