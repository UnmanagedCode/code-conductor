// Integration tests for the PreToolUse http hook callback — the
// orchestrator-side REST endpoint that the Claude Code CLI POSTs to
// before running a destructive tool. The endpoint either auto-allows
// (non-ask modes) or holds the response open and surfaces a
// permission_request UI event until the user decides via WS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

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

test('hook-callback auto-allows in non-ask mode (code/bypassPermissions)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const callback = await api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildHookEnvelope({ toolUseId: 'tu_a' }),
    );
    assert.equal(callback.status, 200);
    assert.equal(callback.body.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'allow');
  } finally { await ctx.close(); }
});

test('hook-callback in plan mode auto-allows (plan-mode CLI will deny on its own; orchestrator does not gate)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const callback = await api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildHookEnvelope({ toolUseId: 'tu_p' }),
    );
    assert.equal(callback.status, 200);
    assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'allow');
  } finally { await ctx.close(); }
});

test('hook-callback in ask mode emits permission_request over WS and resolves on hook_decision allow', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'ask' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    // Fire the hook callback in the background — the response should stay
    // open until we issue a hook_decision.
    const envelope = buildHookEnvelope({ toolUseId: 'tu_ask_1', toolName: 'Write', toolInput: { file_path: '/x/y.txt', content: 'hi' } });
    const callbackPromise = api(ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`, envelope);

    // The UI should see a permission_request event.
    const pr = await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request');
    assert.equal(pr.ev.toolUseId, 'tu_ask_1');
    assert.equal(pr.ev.toolName, 'Write');
    assert.equal(pr.ev.toolInput.file_path, '/x/y.txt');

    // Response should still be pending.
    const settled = await Promise.race([
      callbackPromise.then(() => 'settled'),
      new Promise(r => setTimeout(() => r('pending'), 100)),
    ]);
    assert.equal(settled, 'pending', 'hook callback response is held open until the user decides');

    // Allow it.
    c.send({ t: 'hook_decision', id, toolUseId: 'tu_ask_1', allow: true });
    const callback = await callbackPromise;
    assert.equal(callback.status, 200);
    assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'allow');

    // permission_resolved follow-up event signals subscribers the card is done.
    const resolved = await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_resolved');
    assert.equal(resolved.ev.toolUseId, 'tu_ask_1');
    assert.equal(resolved.ev.allow, true);

    await c.close();
  } finally { await ctx.close(); }
});

test('hook-callback in ask mode → hook_decision deny replies with permissionDecision:"deny"', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'ask' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    const callbackPromise = api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildHookEnvelope({ toolUseId: 'tu_deny', toolName: 'Bash', toolInput: { command: 'rm -rf /' } }),
    );
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request' && m.ev.toolUseId === 'tu_deny');

    c.send({ t: 'hook_decision', id, toolUseId: 'tu_deny', allow: false });
    const callback = await callbackPromise;
    assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(callback.body.hookSpecificOutput.permissionDecisionReason ?? '', /denied/i);

    await c.close();
  } finally { await ctx.close(); }
});

test('hook-callback in ask mode → if the instance exits with a pending response, the response resolves deny', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'ask' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    const callbackPromise = api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildHookEnvelope({ toolUseId: 'tu_exit' }),
    );
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request');

    await inst.kill({ graceMs: 100 });
    const callback = await callbackPromise;
    assert.equal(callback.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(callback.body.hookSpecificOutput.permissionDecisionReason ?? '', /exited/i);

    await c.close();
  } finally { await ctx.close(); }
});

test('hook_decision over WS for an unknown toolUseId acks with an error and does not throw', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'h' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'h', mode: 'ask' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'hook_decision', id, toolUseId: 'never-seen', allow: true, reqId: 'r1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /no pending/i);

    await c.close();
  } finally { await ctx.close(); }
});

test('hook-callback for an unknown instance id replies 200 + deny (CLI auto-deny path)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const r = await api(
      ctx.baseUrl, 'POST', `/api/instances/missing-instance-id/hook-callback`,
      buildHookEnvelope(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.hookSpecificOutput.permissionDecision, 'deny');
  } finally { await ctx.close(); }
});
