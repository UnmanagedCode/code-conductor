// Integration tests for the sub-agent panel feature.
// Verifies that spawn_instance with ?caller=<conductor sessionId> stores the
// conductor's *instanceId* as callerInstanceId on the spawned worker (the
// caller suffix is a sessionId on the wire, resolved back to an instanceId
// internally) and exposes it via summary() and GET /api/instances. The MCP
// spawn return is the scrubbed conductor view (sessionId, no id /
// callerInstanceId), so worker internals are inspected via instForSession.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let nextRpcId = 1;

async function rpc(baseUrl, method, params, { caller } = {}) {
  const id = nextRpcId++;
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  const body = await res.json();
  return { status: res.status, body };
}

async function callTool(baseUrl, name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const text = result.content.map(c => c.text).join('');
  return JSON.parse(text);
}

test('spawn_instance with ?caller=<sessionId> sets callerInstanceId (instanceId) on the worker', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Spawn the "conductor" instance first via MCP (no caller).
    const conductor = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }));
    assert.ok(conductor.sessionId, 'conductor has a sessionId');
    assert.equal(conductor.id, undefined, 'conductor view does not leak instanceId');
    const conductorInst = instForSession(instances, conductor.sessionId);
    assert.equal(conductorInst.callerInstanceId, null, 'conductor has no callerInstanceId');

    // Now spawn a worker with ?caller=<conductor sessionId>.
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductor.sessionId }));

    assert.ok(worker.sessionId, 'worker has a sessionId');
    const workerInst = instForSession(instances, worker.sessionId);
    assert.equal(workerInst.callerInstanceId, conductorInst.id,
      'worker.callerInstanceId equals the conductor instanceId');
  } finally { await close(); }
});

test('Instance.summary() includes callerInstanceId (resolved to instanceId)', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Spawn a conductor, then a worker that names it via ?caller=<sessionId>.
    const conductor = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }));
    const conductorInst = instForSession(instances, conductor.sessionId);
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductor.sessionId }));

    const inst = instForSession(instances, worker.sessionId);
    assert.ok(inst, 'instance exists in manager');
    const summary = inst.summary();
    assert.equal(summary.callerInstanceId, conductorInst.id,
      'summary() exposes callerInstanceId as the conductor instanceId');
  } finally { await close(); }
});

test('GET /api/instances includes callerInstanceId for spawned worker', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Spawn a conductor.
    const conductor = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }));
    const conductorInst = instForSession(instances, conductor.sessionId);

    // Spawn a worker with the conductor as caller (by sessionId).
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductor.sessionId }));

    // GET /api/instances (REST path) still exposes id + callerInstanceId.
    const { status, body: insts } = await api(baseUrl, 'GET', '/api/instances');
    assert.equal(status, 200);
    const workerEntry = insts.find(i => i.sessionId === worker.sessionId);
    assert.ok(workerEntry, 'worker appears in /api/instances');
    assert.equal(workerEntry.callerInstanceId, conductorInst.id,
      '/api/instances worker entry has callerInstanceId (instanceId)');

    // The conductor should have callerInstanceId: null.
    const conductorEntry = insts.find(i => i.sessionId === conductor.sessionId);
    assert.ok(conductorEntry, 'conductor appears in /api/instances');
    assert.equal(conductorEntry.callerInstanceId, null,
      '/api/instances conductor entry has callerInstanceId: null');
  } finally { await close(); }
});
