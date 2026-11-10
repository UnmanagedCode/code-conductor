// Integration tests for the PreToolUse http hook callback — the
// orchestrator-side REST endpoint that the Claude Code CLI POSTs to
// before running a mutating tool. For a local session the endpoint allows
// every call; an unknown instance gets a deny. The `?policy=worker-tools` entry
// on the same URL answers from the playbook gate: `deny` or `{}`, never `allow`.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, instForSession } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.ts';
import { WORKER_TOOLS_MATCHER, WORKER_TOOLS_POLICY } from '../src/settings.ts';
import { workerToolDeniedReason, WORKER_TOOL_DENIED_IN_STAGE } from '../src/playbooks.ts';
import { getDefaultPlaybookEnforcement, setDefaultPlaybookEnforcement } from '../src/conductorConventions.ts';
import { OPEN_LEASE } from './playbook-fixtures.mjs';
import { READ_NUDGE_MATCHER, readNudgeText } from '../src/conductorReadNudge.ts';
import { TOOL_RESULT_NUDGE_MATCHER } from '../src/toolResultNudges.ts';

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
const workerToolsUrl = (inst) => {
  const u = new URL(inst.hookCallbackUrl);
  u.searchParams.set('policy', WORKER_TOOLS_POLICY);
  return u.toString();
};
const ringNudges = (inst) => inst.ring.toArray().filter(ev => ev.kind === 'system' && ev.subtype === 'read_nudge');

test('conductor spawn argv carries the nudge hook; a worker\'s does not', async () => {
  const cond = await spawnConductor();
  const s = JSON.parse(settingsArg(cond));
  assert.equal(s.hooks.PreToolUse.length, 3);
  assert.equal(s.hooks.PreToolUse[1].matcher, READ_NUDGE_MATCHER);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].url, cond.hookCallbackUrl);

  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  const worker = instances.get(r.body.id);
  await waitFor(() => worker.status === 'idle');
  const hook = `[{"type":"http","url":${JSON.stringify(worker.hookCallbackUrl)},"timeout":660}]`;
  assert.equal(settingsArg(worker),
    `{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash","hooks":${hook}},`
    + `{"matcher":"*","hooks":${hook.replace(JSON.stringify(worker.hookCallbackUrl), JSON.stringify(workerToolsUrl(worker)))}}],`
    + `"PostToolUse":[{"matcher":${JSON.stringify(TOOL_RESULT_NUDGE_MATCHER)},"hooks":${hook}}]}}`,
    'a worker\'s settings: the base PreToolUse entry, the worker-tools entry, and the tool-result nudge PostToolUse entry');
});

// INVARIANT: every session's spawn argv registers the tool-result nudge
// PostToolUse entry on its own hook URL — a conductor's as well as a worker's —
// and a PostToolUse on a nudge tool with nothing pending is answered 200 {}.
test('every session registers the tool-result nudge hook; nothing pending answers {}', async () => {
  const cond = await spawnConductor();
  const s = JSON.parse(settingsArg(cond));
  assert.deepEqual(s.hooks.PostToolUse, [{
    matcher: TOOL_RESULT_NUDGE_MATCHER, hooks: [{ type: 'http', url: cond.hookCallbackUrl, timeout: 660 }],
  }]);
  const r = await api(baseUrl, 'POST', `/api/instances/${cond.id}/hook-callback`, {
    ...buildHookEnvelope({ toolUseId: 'tu_post_none', toolName: 'mcp__code-conductor__spawn_instance', toolInput: {} }),
    hook_event_name: 'PostToolUse', tool_response: [],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {});
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

// ── Worker tools (`?policy=worker-tools`) ─────────────────────────────────────
// PINS: every session's LAST PreToolUse entry is `{matcher:'*'}` on its own hook
// URL plus `?policy=worker-tools`; the route answers that entry from the gate
// with `deny` or `{}` — never `allow` — attributed by the URL's instance id, and
// the plain URL's answers are unchanged.

const workerToolsEntry = (inst) => ({ matcher: WORKER_TOOLS_MATCHER, hooks: [{ type: 'http', url: workerToolsUrl(inst), timeout: 660 }] });
const lastPre = (inst) => JSON.parse(settingsArg(inst)).hooks.PreToolUse.at(-1);

test('the worker-tools entry is the last PreToolUse entry on a worker and on a conductor', async () => {
  const cond = await spawnConductor();
  assert.deepEqual(lastPre(cond), workerToolsEntry(cond));
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  const worker = instances.get(r.body.id);
  await waitFor(() => worker.status === 'idle');
  assert.deepEqual(lastPre(worker), workerToolsEntry(worker));
  assert.equal(new URL(workerToolsUrl(worker)).pathname, `/api/instances/${worker.id}/hook-callback`,
    'attributed by the instance id in the path');
});

test('worker-tools for an unbound session answers 200 {} — no permission decision — for any tool', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'h' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
  await waitFor(() => instances.get(r.body.id).status === 'idle');
  for (const toolName of ['Edit', 'Read', 'mcp__code-conductor__project_read']) {
    const res = await api(baseUrl, 'POST', `/api/instances/${r.body.id}/hook-callback?policy=${WORKER_TOOLS_POLICY}`,
      buildHookEnvelope({ toolUseId: `tu_wt_${toolName}`, toolName, toolInput: {} }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {}, `${toolName}: no permissionDecision`);
  }
  // The plain URL is unchanged by the new entry.
  const plain = await api(baseUrl, 'POST', `/api/instances/${r.body.id}/hook-callback`, buildHookEnvelope({ toolName: 'Edit' }));
  assert.equal(plain.body.hookSpecificOutput.permissionDecision, 'allow');
});

test('worker-tools for an unknown instance id replies 200 + deny', async () => {
  const r = await api(baseUrl, 'POST', `/api/instances/missing-instance-id/hook-callback?policy=${WORKER_TOOLS_POLICY}`,
    buildHookEnvelope({ toolName: 'Read' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.hookSpecificOutput.permissionDecision, 'deny');
});

// A server of its own: the bind row must be written, which needs an open
// event-log lease. Boots it, pins the persisted default level to `enforce`,
// spawns a conductor at `enforcement` and, through its `/mcp` path, a worker
// bound to a stage that denies its worker `Edit`. `post(tool, query?)` hits
// the worker's hook-callback URL.
const WTROUTE = {
  id: 'wtroute', name: 'Wtroute', description: 'Test-only: a stage denying its worker Edit.',
  entryStages: ['review'],
  stages: { review: { description: 'Read only.', tools: { spawn_instance: 'allow' }, workerTools: { Edit: 'deny' } } },
  transitions: [],
};
const EDIT_DENIED = workerToolDeniedReason({ playbook: 'wtroute', stage: 'review', toolName: 'Edit', key: 'Edit' });

async function withBoundWorker(enforcement, fn) {
  const own = await bootServer({ scenarioPath: SCENARIO, eventLogLease: OPEN_LEASE });
  try {
    const pbDir = path.join(orchStoreRoot(), 'playbooks');
    await fs.mkdir(pbDir, { recursive: true });
    await fs.writeFile(path.join(pbDir, 'wtroute.json'), JSON.stringify(WTROUTE));
    await setDefaultPlaybookEnforcement('enforce');
    assert.equal(await getDefaultPlaybookEnforcement(), 'enforce', 'premise: the persisted default is enforce');
    await api(own.baseUrl, 'POST', '/api/projects', { name: 'h' });
    await api(own.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const c = await api(own.baseUrl, 'POST', '/api/instances', { project: '.conduct', temp: true, mode: 'bypassPermissions', playbookEnforcement: enforcement });
    assert.equal(c.status, 201);
    const conductor = own.instances.get(c.body.id);
    await waitFor(() => conductor?.status === 'idle');
    assert.equal(conductor.playbookEnforcement, enforcement, 'premise: the owner runs at the level under test');
    const res = await fetch(`${own.baseUrl}/mcp/${encodeURIComponent(c.body.sessionId)}?format=json`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'spawn_instance', arguments: { project: 'h', playbook: 'wtroute', stage: 'review' } } }),
    });
    const spawned = (await res.json()).result.structuredContent;
    assert.equal(typeof spawned?.sessionId, 'string', `spawned: ${JSON.stringify(spawned)}`);
    const worker = await waitFor(() => instForSession(own.instances, spawned.sessionId));
    assert.equal(worker.parentSessionId, c.body.sessionId, 'premise: the worker\'s owner is the conductor');
    const post = (toolName, query = `?policy=${WORKER_TOOLS_POLICY}`) => api(own.baseUrl, 'POST',
      `/api/instances/${worker.id}/hook-callback${query}`, buildHookEnvelope({ toolName, toolInput: {} }));
    await fn({ conductor, worker, post });
  } finally { await own.close(); }
}

const warnBubbles = (inst) => inst.ring.toArray().filter(ev => ev.kind === 'system' && ev.subtype === 'playbook_warn');

test('worker-tools denies a bound worker\'s call its stage denies, with the reason; the plain URL still allows', async () => {
  await withBoundWorker('enforce', async ({ post }) => {
    const denied = await post('Edit');
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.body, { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: EDIT_DENIED,
    } });
    assert.deepEqual((await post('Read')).body, {}, 'a tool the stage does not deny: no decision');
    assert.equal((await post('Edit', '')).body.hookSpecificOutput.permissionDecision, 'allow',
      'the plain URL\'s answer is unchanged');
  });
});

// PINS: the route hands the gate the worker's OWNER (`parentSessionId`), so the
// level is the owning conductor's — here `warn`, against a persisted default of
// `enforce` that any other owner resolution would fall back to and deny with.
test('worker-tools takes the level from the worker\'s owning conductor: a warn owner passes the call and gets one bubble', async () => {
  await withBoundWorker('warn', async ({ conductor, worker, post }) => {
    const res = await post('Edit');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {}, 'warn: no decision, not the default level\'s deny');
    assert.deepEqual(warnBubbles(conductor).map(ev => ev.data), [{
      tool: 'Edit', code: WORKER_TOOL_DENIED_IN_STAGE, reason: EDIT_DENIED, sessionId: worker.sessionId,
    }], 'one playbook_warn bubble on the owner');
  });
});
