// A cc fault outside any tool's own answer never takes the server down and
// never reaches Express's HTML error page.
//
// Pinned here, on a bare router with stub collaborators:
//   - runTool is TOTAL: a step before the handler that rejects (session-ref
//     resolution, the playbook gate) answers INTERNAL — 500 on the REST alias,
//     a -32603 JSON-RPC error on tools/call (data in JSON format only) — and the
//     next request is still served;
//   - a rejection from an async route outside runTool (the caller lookup)
//     reaches the router's error middleware, answered in the route's shape;
//   - request bodies express.json refuses are answered in the route's shape:
//     too large → 413 PAYLOAD_TOO_LARGE, unreadable → 400 REQUEST_INVALID.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';

let server, base;
const boom = (what) => Promise.reject(new Error(`${what} exploded`));

before(async () => {
  const router = buildMcpRouter({
    instances: {
      resolveResumeRef: () => boom('resolveResumeRef'),
      liveCallerForPublicId: (id) => { if (id === 'throws') throw new Error('caller lookup exploded'); return null; },
    },
    pluginHost: null,
    playbookGate: {
      check: ({ toolName, args }) => (toolName === 'list_workspaces' ? boom('gate') : Promise.resolve({ args })),
    },
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

async function post(path, body, headers = { 'content-type': 'application/json' }) {
  const res = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}
const call = (name, args) => ({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });

// A request that must still be served after each fault: proof the process lives.
async function stillServing() {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(r.body, { jsonrpc: '2.0', id: 1, result: {} });
}

test('a rejecting pre-handler step answers INTERNAL on both transports, and the server keeps serving', async () => {
  for (const [name, args, what] of [['spawn_instance', { resume: 'abcdef12' }, 'resolveResumeRef'], ['list_workspaces', {}, 'gate']]) {
    const rest = await post(`/mcp/tools/${name}`, args);
    assert.equal(rest.status, 500, name);
    assert.deepEqual(rest.body, { ok: false, code: 'INTERNAL', reason: `${what} exploded` });
    await stillServing();

    const json = await post('/mcp', call(name, args));
    assert.equal(json.body.error.code, -32603);
    assert.deepEqual(json.body.error.data, { ok: false, code: 'INTERNAL', reason: `${what} exploded` });
    assert.equal(json.body.id, 9);
    await stillServing();

    const text = await post('/mcp?format=text', call(name, args));
    assert.deepEqual(text.body, { jsonrpc: '2.0', id: 9, error: { code: -32603, message: `${what} exploded` } },
      'text format: the -32603 reply it always was, no data');
    await stillServing();
  }
});

test('a rejection from an async route outside runTool reaches the error middleware in the route\'s shape', async () => {
  const rest = await post('/mcp/throws/tools/list_workspaces', {});
  assert.equal(rest.status, 500);
  assert.match(rest.type, /application\/json/);
  assert.deepEqual(rest.body, { ok: false, code: 'INTERNAL', reason: 'caller lookup exploded' });
  const rpc = await post('/mcp/throws', call('list_workspaces', {}));
  assert.equal(rpc.status, 500);
  assert.equal(rpc.body.error.code, -32603);
  assert.equal(rpc.body.error.data.code, 'INTERNAL');
  const listing = await fetch(`${base}/mcp/throws/tools`);
  assert.equal(listing.status, 500);
  assert.equal((await listing.json()).code, 'INTERNAL');
  await stillServing();
});

test('an oversized body is 413 PAYLOAD_TOO_LARGE, an unreadable one REQUEST_INVALID — JSON with data in both formats, never HTML', async () => {
  const huge = JSON.stringify({ pad: 'x'.repeat(9 * 1024 * 1024) });
  const rpc = await post('/mcp', huge);
  assert.equal(rpc.status, 413);
  assert.equal(rpc.body.error.data.code, 'PAYLOAD_TOO_LARGE');
  const rest = await post('/mcp/tools/list_workspaces', huge);
  assert.equal(rest.status, 413);
  assert.equal(rest.body.code, 'PAYLOAD_TOO_LARGE');
  const charset = await post('/mcp/tools/list_workspaces', '{}', { 'content-type': 'application/json; charset=klingon' });
  assert.equal(charset.status, 415);
  assert.equal(charset.body.code, 'REQUEST_INVALID');
  const rpcCharset = await post('/mcp', '{}', { 'content-type': 'application/json; charset=klingon' });
  assert.equal(rpcCharset.body.error.data.code, 'REQUEST_INVALID');
  // The body is refused before any format applies: text format gets the same
  // JSON-RPC error, `data` included.
  const textHuge = await post('/mcp?format=text', huge);
  assert.equal(textHuge.status, 413);
  assert.equal(textHuge.body.error.code, -32600);
  assert.deepEqual(textHuge.body.error.data, { ok: false, code: 'PAYLOAD_TOO_LARGE', reason: textHuge.body.error.message });
  const textCharset = await post('/mcp?format=text', '{}', { 'content-type': 'application/json; charset=klingon' });
  assert.equal(textCharset.status, 415);
  assert.equal(textCharset.body.error.code, -32600);
  assert.deepEqual(textCharset.body.error.data, { ok: false, code: 'REQUEST_INVALID', reason: textCharset.body.error.message });
  await stillServing();
});

// The JSON-RPC error MESSAGE is capped per format: the text cap in text format
// (one MCP result's budget), JSON_ECHO_CAP in JSON format.
test('a JSON-RPC error message echoing the caller is cut at the format\'s echo cap', async () => {
  const method = 'm'.repeat(20_000);
  const text = await post('/mcp?format=text', { jsonrpc: '2.0', id: 3, method });
  assert.match(text.body.error.message, / … \[cut: \d+ chars\] … /, 'text: cut at the text echo cap');
  const json = await post('/mcp', { jsonrpc: '2.0', id: 3, method });
  assert.equal(json.body.error.message, `method not found: ${method}`, 'JSON: under JSON_ECHO_CAP, whole');
  assert.equal(json.body.error.data.code, 'METHOD_UNKNOWN');
});
