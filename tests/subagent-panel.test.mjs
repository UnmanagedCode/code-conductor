// Integration tests for the sub-agent panel feature.
// Verifies that spawn_instance with a ?caller=<id> stores callerInstanceId
// on the spawned worker and exposes it via summary() and GET /api/instances.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

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

test('spawn_instance with ?caller sets callerInstanceId on the worker instance', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Spawn the "conductor" instance first via MCP (no caller).
    const conductor = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }));
    assert.ok(conductor.id, 'conductor instance has id');
    assert.equal(conductor.callerInstanceId, null, 'conductor has no callerInstanceId');

    // Now spawn a worker with ?caller=<conductorId>.
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductor.id }));

    assert.ok(worker.id, 'worker instance has id');
    assert.equal(worker.callerInstanceId, conductor.id,
      'worker.callerInstanceId equals the conductor id');
  } finally { await close(); }
});

test('Instance.summary() includes callerInstanceId', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Spawn a conductor.
    const conductorId = 'test-caller-id-abc123';
    // We simulate a caller by passing it as the query param to a plain spawn.
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductorId }));

    const inst = instances.get(worker.id);
    assert.ok(inst, 'instance exists in manager');
    const summary = inst.summary();
    assert.equal(summary.callerInstanceId, conductorId,
      'summary() exposes callerInstanceId');
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

    // Spawn a worker with the conductor as caller.
    const worker = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'p', mode: 'bypassPermissions',
    }, { caller: conductor.id }));

    // GET /api/instances should include callerInstanceId on the worker.
    const { status, body: insts } = await api(baseUrl, 'GET', '/api/instances');
    assert.equal(status, 200);
    const workerEntry = insts.find(i => i.id === worker.id);
    assert.ok(workerEntry, 'worker appears in /api/instances');
    assert.equal(workerEntry.callerInstanceId, conductor.id,
      '/api/instances worker entry has callerInstanceId');

    // The conductor should have callerInstanceId: null.
    const conductorEntry = insts.find(i => i.id === conductor.id);
    assert.ok(conductorEntry, 'conductor appears in /api/instances');
    assert.equal(conductorEntry.callerInstanceId, null,
      '/api/instances conductor entry has callerInstanceId: null');
  } finally { await close(); }
});
