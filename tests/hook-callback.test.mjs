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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

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
