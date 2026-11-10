// The /mcp URL contract (docs/mcp-applications.md): identity is the PATH
// (`/mcp/<sessionId>`), presentation is the QUERY (`?format=`).
//
// Pinned here: an anonymous call is what it always was; `/mcp/<sid>` attributes
// a call to that session; anything that is not the exact public id of a live
// session is refused CALLER_UNKNOWN BEFORE dispatch — never served anonymously,
// never executed; the public id keeps resolving across a /clear rotation; any
// query parameter other than `format` is refused rather than ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { mcpUrl } from './mcpClient.mjs';
import { getTitle } from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scenario-renew's `/clear` turn emits a system/init with this fixed backing id.
const SCENARIO_RENEW = path.join(__dirname, 'fixtures', 'scenario-renew.json');
const ROTATED_BACKING = 'c0000000-0000-4000-8000-000000000001';

let nextId = 1;
async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const call = (name, args) => ({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });

async function spawnIdle(srv, project, extra = {}) {
  await api(srv.baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(srv.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await waitFor(() => instForSession(srv.instances, r.body.sessionId)?.status === 'idle');
  return instForSession(srv.instances, r.body.sessionId);
}

function assertUrlFault(body, code) {
  assert.equal(body.result, undefined, `refused before dispatch, got a result: ${JSON.stringify(body)}`);
  assert.equal(body.error?.data?.code, code, JSON.stringify(body));
  assert.equal(body.error.data.ok, false);
  assert.equal(typeof body.error.data.reason, 'string');
}

test('anonymous POST /mcp: a caller-dependent tool refuses with the missing-caller error', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const { body } = await post(mcpUrl(srv.baseUrl, { format: 'text' }), call('set_session_title', { title: 'anon' }));
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /caller identity missing — call the MCP URL as `\/mcp\/<sessionId>`/);
  } finally { await srv.close(); }
});

test('/mcp/<sessionId> attributes the call: titles the caller, owns what it spawns', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    // The caller is a `.conduct` conductor: only it is offered spawn_instance. `warn`
    // keeps its ungoverned spawn proceeding.
    await spawnIdle(srv, 'uc-attr');
    const caller = await spawnIdle(srv, '.conduct', { role: 'conductor', playbookEnforcement: 'warn' });
    const sid = caller.sessionId;
    const { body } = await post(mcpUrl(srv.baseUrl, { caller: sid, format: 'text' }), call('set_session_title', { title: 'Named by path' }));
    assert.deepEqual(JSON.parse(body.result.content[0].text), { sessionId: sid, title: 'Named by path' });
    assert.equal(await getTitle(sid), 'Named by path');

    const spawned = await post(mcpUrl(srv.baseUrl, { caller: sid, format: 'text' }),
      call('spawn_instance', { project: 'uc-attr', mode: 'bypassPermissions' }));
    const view = JSON.parse(spawned.body.result.content[0].text);
    assert.equal(view.ownerSessionId, sid, 'the spawned worker is owned by the path caller');
  } finally { await srv.close(); }
});

test('CALLER_UNKNOWN for anything but the exact public id of a live session — and nothing runs', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const live = await spawnIdle(srv, 'uc-bad');
    const killed = await spawnIdle(srv, 'uc-bad');
    const killedSid = killed.sessionId;
    await killed.kill({ graceMs: 50 });
    await waitFor(() => !killed.proc);
    assert.notEqual(live.backingSessionId, live.sessionId, 'precondition: the backing id differs from the public id');

    const bad = {
      unknown: 'deadbeef-0000-4000-8000-000000000000',
      prefix: live.sessionId.slice(0, 6),
      backing: live.backingSessionId,
      instanceId: live.id,
      killed: killedSid,
    };
    for (const [what, id] of Object.entries(bad)) {
      const { status, body } = await post(mcpUrl(srv.baseUrl, { caller: id, format: 'text' }), call('set_session_title', { title: `via ${what}` }));
      assert.equal(status, 200, what);
      assertUrlFault(body, 'CALLER_UNKNOWN');
      assert.equal(body.error.code, -32001, what);
    }
    // Never executed anonymously or as anybody: no session got a title.
    assert.equal(await getTitle(live.sessionId), null);
    assert.equal(await getTitle(killedSid), null);

    // initialize and tools/list are refused too, never answered anonymously.
    for (const method of ['initialize', 'tools/list']) {
      const { body } = await post(mcpUrl(srv.baseUrl, { caller: bad.unknown, format: 'text' }), { jsonrpc: '2.0', id: 7, method });
      assertUrlFault(body, 'CALLER_UNKNOWN');
      assert.equal(body.id, 7, 'a single request keeps its id');
    }
  } finally { await srv.close(); }
});

test('a batch or a notification with a bad caller is refused once, id null', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const url = mcpUrl(srv.baseUrl, { caller: 'deadbeef', format: 'text' });
    const batch = await post(url, [call('list_workspaces', {}), call('list_workspaces', {})]);
    assert.ok(!Array.isArray(batch.body), 'one error object, not one per request');
    assertUrlFault(batch.body, 'CALLER_UNKNOWN');
    assert.equal(batch.body.id, null);
    const note = await post(url, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } });
    assertUrlFault(note.body, 'CALLER_UNKNOWN');
    assert.equal(note.body.id, null);
  } finally { await srv.close(); }
});

test('?caller= (or any query parameter but format) is refused QUERY_PARAM_UNKNOWN, never ignored', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const live = await spawnIdle(srv, 'uc-q');
    const { body } = await post(`${srv.baseUrl}/mcp?caller=${live.sessionId}&format=text`, call('set_session_title', { title: 'via query' }));
    assertUrlFault(body, 'QUERY_PARAM_UNKNOWN');
    assert.equal(await getTitle(live.sessionId), null, 'not executed');
    const other = await post(`${srv.baseUrl}/mcp/${live.sessionId}?format=text&x=1`, call('list_workspaces', {}));
    assertUrlFault(other.body, 'QUERY_PARAM_UNKNOWN');
  } finally { await srv.close(); }
});

test('the public id keeps naming the caller across a /clear rotation; the rotated-away backing id does not', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const inst = await spawnIdle(srv, 'uc-rot');
    const sid = inst.sessionId;
    const before = inst.backingSessionId;
    await inst.prompt('/clear');
    await waitFor(() => inst.backingSessionId === ROTATED_BACKING && inst.status === 'idle');
    assert.equal(inst.sessionId, sid, 'the public id is pinned');

    const { body } = await post(mcpUrl(srv.baseUrl, { caller: sid, format: 'text' }), call('set_session_title', { title: 'after clear' }));
    assert.deepEqual(JSON.parse(body.result.content[0].text), { sessionId: sid, title: 'after clear' });
    for (const old of [before, ROTATED_BACKING]) {
      const r = await post(mcpUrl(srv.baseUrl, { caller: old, format: 'text' }), call('set_session_title', { title: 'stale' }));
      assertUrlFault(r.body, 'CALLER_UNKNOWN');
    }
    assert.equal(await getTitle(sid), 'after clear');
  } finally { await srv.close(); }
});

test('GET on an MCP URL is 405; an unknown /mcp route is a JSON 404, never the web UI', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/mcp/deadbeef`)).status, 405);
    const r = await fetch(`${srv.baseUrl}/mcp/deadbeef/nope/deeper`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'ROUTE_UNKNOWN');
  } finally { await srv.close(); }
});

test('a body that is not JSON is a 400 PARSE_ERROR JSON-RPC error', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const res = await fetch(`${srv.baseUrl}/mcp?format=text`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
    assert.equal(body.error.data.code, 'PARSE_ERROR');
  } finally { await srv.close(); }
});

test('format: absent → JSON, text → text, anything else FORMAT_INVALID; Accept never decides', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const absent = await post(`${srv.baseUrl}/mcp`, call('list_workspaces', {}));
    assert.deepEqual(absent.body.result.structuredContent, { workspaces: [] }, 'JSON is the default');
    const text = await post(`${srv.baseUrl}/mcp?format=text`, call('list_workspaces', {}));
    assert.equal(text.body.result.structuredContent, undefined);
    assert.equal(text.body.result.content[0].text, '[]', 'the text view is the bare array it always was');
    const json = await post(`${srv.baseUrl}/mcp?format=json`, call('list_workspaces', {}));
    assert.deepEqual(json.body.result.structuredContent, { workspaces: [] });
    const xml = await post(`${srv.baseUrl}/mcp?format=xml`, call('list_workspaces', {}));
    assertUrlFault(xml.body, 'FORMAT_INVALID');

    const res = await fetch(`${srv.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/plain' },
      body: JSON.stringify(call('list_workspaces', {})),
    });
    assert.deepEqual((await res.json()).result.structuredContent, { workspaces: [] }, 'Accept is not consulted');
  } finally { await srv.close(); }
});

test('tools/call needs no initialize handshake', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  try {
    const { body } = await post(`${srv.baseUrl}/mcp`, call('create_workspace', { name: 'cold' }));
    assert.deepEqual(body.result.structuredContent, { added: true, name: 'cold' });
  } finally { await srv.close(); }
});
