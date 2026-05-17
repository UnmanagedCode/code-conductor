import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-permission.json');

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

test('can_use_tool: claude requests permission, UI receives permission_request event', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'prompt', id, text: 'go' });
    const permEv = await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request');
    assert.equal(permEv.ev.requestId, 'perm-1');
    assert.equal(permEv.ev.toolName, 'Bash');
    assert.deepEqual(permEv.ev.input, { command: 'rm -rf /' });
    assert.equal(permEv.ev.title, 'Confirm dangerous command');

    // Pending permission is tracked on the Instance.
    const pendingMap = ctx.instances.get(id)._pendingPermissions;
    assert.ok(pendingMap.has('perm-1'));

    await c.close();
  } finally { await ctx.close(); }
});

test('permission allow: turn completes successfully after Approve', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request');

    c.send({ t: 'permission', id, requestId: 'perm-1', allow: true });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_resolved');
    const turnEnd = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turnEnd.ev.isError, false);

    const toolResult = c.messages.find(m => m.t === 'event' && m.ev.kind === 'tool_result');
    assert.ok(toolResult, 'tool_result arrived after permission');
    assert.equal(toolResult.ev.isError, false);
    assert.match(toolResult.ev.content, /simulated execution/);

    await c.close();
  } finally { await ctx.close(); }
});

test('permission deny: tool returns error after Deny', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_request');

    c.send({ t: 'permission', id, requestId: 'perm-1', allow: false, feedback: 'no thanks' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'permission_resolved');
    const toolResult = await c.wait(m => m.t === 'event' && m.ev.kind === 'tool_result');
    assert.equal(toolResult.ev.isError, true);

    await c.close();
  } finally { await ctx.close(); }
});

test('respondPermission rejects unknown request_id', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);
    assert.throws(() => inst.respondPermission('does-not-exist', { allow: true }), /unknown permission request/);
  } finally { await ctx.close(); }
});
