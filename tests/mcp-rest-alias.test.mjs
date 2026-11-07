// The REST alias (docs/mcp-applications.md): POST /mcp[/<sessionId>]/tools/<name>
// with the arguments as the JSON body, and GET …/tools for the listing.
//
// Pinned here: success is 200 + the structuredContent object itself (no
// envelope); a refusal is 200 + the refusal object; faults are HTTP statuses
// (404 unknown tool / unknown caller, 400 bad JSON / non-object body / bad
// args / a format other than JSON, 415 without a JSON content type); the
// listing's shape; and PARITY — the alias and tools/call run one core, so
// their bodies and caller attribution are identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, waitFor, instForSession, registerLocalProject } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { mcpUrl } from './mcpClient.mjs';
import { getTitle } from '../src/sessionStore.ts';

const SCENARIO = path.join(import.meta.dirname, 'fixtures', 'scenario-basic.json');

async function rest(base, name, body, { caller = null, query = '', headers = { 'content-type': 'application/json' }, raw } = {}) {
  const res = await fetch(mcpUrl(base, { caller, suffix: `/tools/${name}` }) + query, {
    method: 'POST', headers, body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
let nextId = 1;
async function rpcCall(base, name, args, caller = null) {
  const res = await fetch(mcpUrl(base, { caller }), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

async function spawnIdle(srv, project) {
  await api(srv.baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(srv.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await waitFor(() => instForSession(srv.instances, r.body.sessionId)?.status === 'idle');
  return r.body.sessionId;
}

test('success is 200 with the bare structured object; a refusal is 200 with the refusal object', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    const created = await rest(srv.baseUrl, 'create_workspace', { name: 'w' });
    assert.deepEqual(created, { status: 200, body: { added: true, name: 'w' } });
    const refused = await rest(srv.baseUrl, 'send_prompt', { sessionId: 'deadbeef-0000-4000-8000-000000000000', text: 'x' });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.code, 'SESSION_UNKNOWN');
    const thrown = await rest(srv.baseUrl, 'list_worktrees', { project: 'nope' });
    assert.equal(thrown.status, 200);
    assert.equal(thrown.body.ok, false);
    assert.equal(typeof thrown.body.code, 'string');
  } finally { await srv.close(); }
});

test('faults are HTTP statuses carrying {ok:false, code, reason}', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    const cases = [
      [await rest(srv.baseUrl, 'no_such_tool', {}), 404, 'TOOL_UNKNOWN'],
      [await rest(srv.baseUrl, 'list_workspaces', {}, { caller: 'deadbeef' }), 404, 'CALLER_UNKNOWN'],
      [await rest(srv.baseUrl, 'list_workspaces', null, { raw: '{nope' }), 400, 'PARSE_ERROR'],
      [await rest(srv.baseUrl, 'list_workspaces', [1, 2]), 400, 'ARGS_INVALID'],
      [await rest(srv.baseUrl, 'list_worktrees', { project: 'x', bogus: 1 }), 400, 'ARGS_INVALID'],
      [await rest(srv.baseUrl, 'list_workspaces', {}, { query: '?format=text' }), 400, 'FORMAT_INVALID'],
      [await rest(srv.baseUrl, 'list_workspaces', {}, { query: '?caller=x' }), 400, 'QUERY_PARAM_UNKNOWN'],
      [await rest(srv.baseUrl, 'list_workspaces', {}, { headers: { 'content-type': 'text/plain' } }), 415, 'CONTENT_TYPE_UNSUPPORTED'],
      [await rest(srv.baseUrl, 'list_workspaces', null, { headers: {}, raw: '' }), 415, 'CONTENT_TYPE_UNSUPPORTED'],
    ];
    for (const [{ status, body }, wantStatus, wantCode] of cases) {
      assert.equal(status, wantStatus, `${wantCode}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, false);
      assert.equal(body.code, wantCode);
      assert.equal(typeof body.reason, 'string');
    }
    // A cross-site "simple" POST ran nothing.
    await rest(srv.baseUrl, 'create_workspace', null, { headers: { 'content-type': 'text/plain' }, raw: '{"name":"csrf"}' });
    assert.deepEqual((await rest(srv.baseUrl, 'list_workspaces', {})).body, { workspaces: [] });
    const noName = await fetch(`${srv.baseUrl}/mcp/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noName.status, 404);
    assert.equal((await noName.json()).code, 'TOOL_UNKNOWN');
  } finally { await srv.close(); }
});

test('the listing: name, description, inputSchema, outputSchema — plugin tools untyped and passed through', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    const dir = path.join(srv.projectsRoot, 'fakeplug');
    await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
    await registerLocalProject('fakeplug', dir);
    await srv.pluginHost.enable('fake-plugin');
    const sid = await spawnIdle(srv, 'lister');
    for (const url of [`${srv.baseUrl}/mcp/tools`, `${srv.baseUrl}/mcp/${sid}/tools`]) {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const tools = await res.json();
      for (const t of tools) assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name', 'outputSchema']);
      const core = tools.find(t => t.name === 'list_workspaces');
      assert.equal(core.outputSchema.type, 'object');
      const plug = tools.find(t => t.name.startsWith('fake-plugin__'));
      assert.ok(plug, 'the plugin tool is listed');
      assert.equal(plug.outputSchema, null);
    }
    assert.equal((await fetch(`${srv.baseUrl}/mcp/deadbeef/tools`)).status, 404);
    // A bridged plugin tool answers with its MCP result unchanged.
    const echoed = await rest(srv.baseUrl, 'fake-plugin__echo', { message: 'hi' });
    assert.equal(echoed.status, 200);
    assert.ok(Array.isArray(echoed.body.content), JSON.stringify(echoed.body));
    assert.equal(JSON.parse(echoed.body.content[0].text).message, 'hi');
  } finally { await srv.close(); }
});

test('parity: the alias body IS the tools/call structuredContent, with the same caller', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = await spawnIdle(srv, 'par');
    const samples = [
      ['list_workspaces', {}, null],
      ['project_status', { project: 'par' }, null],
      ['get_transcript', { sessionId: sid, limit: 5 }, null],
      ['send_prompt', { sessionId: 'deadbeef-0000-4000-8000-000000000000', text: 'x' }, null],
      ['set_session_title', { title: 'same' }, sid],
    ];
    for (const [name, args, caller] of samples) {
      const viaRpc = (await rpcCall(srv.baseUrl, name, args, caller)).structuredContent;
      const viaRest = (await rest(srv.baseUrl, name, args, { caller })).body;
      assert.deepEqual(viaRest, viaRpc, name);
    }
    assert.equal(await getTitle(sid), 'same', 'the alias attributed the call to the path caller');
    const anon = await rest(srv.baseUrl, 'set_session_title', { title: 'anon' });
    assert.equal(anon.body.ok, false, 'anonymously, a caller-dependent tool refuses');
  } finally { await srv.close(); }
});
