// MCP tool forwarding: per-caller composition (ctx.tools = core + plugin
// tools), <plugin-id>__<tool> namespacing, project/global scoping, the
// pinned child contract (200 + {result|error} for tool invocations,
// non-200 = transport failure), lazy start on first call, and timeouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { FAKE_PLUGIN_DIR, readFixtureManifest } from './plugin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const run = promisify(execFile);

async function setup() {
  const boot = await bootServer({ scenarioPath: SCENARIO_WS });
  await fs.cp(FAKE_PLUGIN_DIR, path.join(boot.projectsRoot, 'fakeplug'), { recursive: true });
  await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
  return boot;
}

async function addPlugin(boot, project, manifestPatch) {
  const dir = path.join(boot.projectsRoot, project);
  await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
  const manifest = { ...(await readFixtureManifest()), ...manifestPatch };
  if (manifestPatch.mcp) manifest.mcp = { ...(await readFixtureManifest()).mcp, ...manifestPatch.mcp };
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest, null, 2));
  await api(boot.baseUrl, 'POST', '/api/plugins/rescan');
  await api(boot.baseUrl, 'POST', `/api/plugins/${manifest.id}/enable`);
  return dir;
}

let rpcId = 0;
async function rpc(baseUrl, method, params, caller) {
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
}
const listToolNames = async (baseUrl, caller) =>
  (await rpc(baseUrl, 'tools/list', {}, caller)).tools.map(t => t.name);
const callTool = (baseUrl, name, args, caller) =>
  rpc(baseUrl, 'tools/call', { name, arguments: args }, caller);

// Spawn a fake-claude worker and resolve its sessionId (= MCP callerId).
async function spawnWorker(boot, body) {
  const r = await api(boot.baseUrl, 'POST', '/api/instances', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return waitFor(() => boot.instances.get(r.body.id)?.sessionId);
}

test('scoping: conductor sees all; project callers see their project + globals', async () => {
  const boot = await setup();
  try {
    await addPlugin(boot, 'globalplug', { id: 'globalplug', name: 'Global', mcp: { scope: 'global' } });
    await fs.mkdir(path.join(boot.projectsRoot, 'other'), { recursive: true });

    // Conductor / UI (no caller): everything.
    const all = await listToolNames(boot.baseUrl);
    assert.ok(all.includes('fake-plugin__echo'));
    assert.ok(all.includes('fake-plugin__sleep'));
    assert.ok(all.includes('globalplug__echo'));
    assert.ok(all.includes('list_instances'), 'core tools still present');

    // Worker in the plugin's own project: project-scoped + global tools.
    const inPlug = await spawnWorker(boot, { project: 'fakeplug' });
    const plugTools = await listToolNames(boot.baseUrl, inPlug);
    assert.ok(plugTools.includes('fake-plugin__echo'));
    assert.ok(plugTools.includes('globalplug__echo'));

    // Worker in an unrelated project: global tools only.
    const inOther = await spawnWorker(boot, { project: 'other' });
    const otherTools = await listToolNames(boot.baseUrl, inOther);
    assert.ok(!otherTools.includes('fake-plugin__echo'), 'project-scoped tool hidden');
    assert.ok(otherTools.includes('globalplug__echo'));

    // Scoped-out call = unknown tool (same predicate gates tools/call).
    const denied = await callTool(boot.baseUrl, 'fake-plugin__echo', { message: 'hi' }, inOther);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /unknown tool/);

    // Unresolvable caller: only global tools.
    const stale = await listToolNames(boot.baseUrl, 'not-a-live-session');
    assert.ok(!stale.includes('fake-plugin__echo'));
    assert.ok(stale.includes('globalplug__echo'));

    // Disabling removes the tools for new lists.
    await api(boot.baseUrl, 'POST', '/api/plugins/globalplug/disable');
    assert.ok(!(await listToolNames(boot.baseUrl)).includes('globalplug__echo'));
  } finally { await boot.close(); }
});

test('forwarding + pinned child contract: result, tool-error, transport-error, args gate, lazy restart', async () => {
  const boot = await setup();
  try {
    // First call lazy-starts the child (plugin was never started).
    const ok = await callTool(boot.baseUrl, 'fake-plugin__echo', { message: 'hi' });
    assert.ok(!ok.isError, JSON.stringify(ok));
    const payload = JSON.parse(ok.content[0].text);
    assert.equal(payload.message, 'hi');
    assert.deepEqual(payload.caller, { sessionId: null, project: null });

    // validateArgs gates BEFORE any forward (declared manifest schema).
    const badArg = await callTool(boot.baseUrl, 'fake-plugin__echo', { message: 'x', bogus: 1 });
    assert.equal(badArg.isError, true);
    assert.match(badArg.content[0].text, /unexpected argument 'bogus'/);
    const missing = await callTool(boot.baseUrl, 'fake-plugin__echo', {});
    assert.match(missing.content[0].text, /missing required argument: message/);

    // 200 + {error} → plain tool error, NO HTTP status mapping.
    const toolErr = await callTool(boot.baseUrl, 'fake-plugin__fail', {});
    assert.equal(toolErr.isError, true);
    assert.match(toolErr.content[0].text, /unknown tool 'fail'/);
    assert.doesNotMatch(toolErr.content[0].text, /HTTP/);
    const toolErrJson = JSON.parse(toolErr.content[1].text);
    assert.equal(toolErrJson.statusCode, undefined);

    // Non-200 from the child → transport-level failure with statusCode.
    const transport = await callTool(boot.baseUrl, 'fake-plugin__transport-bug', {});
    assert.equal(transport.isError, true);
    assert.match(transport.content[0].text, /HTTP 500/);
    assert.equal(JSON.parse(transport.content[1].text).statusCode, 500);
    assert.equal(JSON.parse(transport.content[1].text).code, 'INTERNAL');

    // Stop, then call again: lazy start brings it back.
    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/stop');
    const again = await callTool(boot.baseUrl, 'fake-plugin__echo', { message: 'back' });
    assert.ok(!again.isError);
    assert.equal(JSON.parse(again.content[0].text).message, 'back');
  } finally { await boot.close(); }
});

test('timeout: a slow tool aborts at the manifest timeoutMs', async () => {
  const boot = await setup();
  try {
    await addPlugin(boot, 'slowplug', { id: 'slowplug', name: 'Slow', mcp: { timeoutMs: 1000 } });
    const t0 = Date.now();
    const r = await callTool(boot.baseUrl, 'slowplug__sleep', { ms: 30000 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /timed out after 1000ms/);
    assert.equal(JSON.parse(r.content[1].text).statusCode, 504);
    assert.ok(Date.now() - t0 < 15000, 'aborted well before the 30s sleep');
  } finally { await boot.close(); }
});

test('a worker spawned in a worktree sees its parent project\'s plugin tools', async () => {
  const boot = await setup();
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await run('git', ['-C', dir, 'init', '-q']);
    await run('git', ['-C', dir, 'config', 'user.email', 't@t']);
    await run('git', ['-C', dir, 'config', 'user.name', 't']);
    await run('git', ['-C', dir, 'add', '-A']);
    await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    const sid = await spawnWorker(boot, { project: 'fakeplug', worktree: true });
    const inst = boot.instances.anyForSession(sid);
    assert.ok(inst.worktree?.worktreePath, 'worker actually runs in a worktree');
    const tools = await listToolNames(boot.baseUrl, sid);
    assert.ok(tools.includes('fake-plugin__echo'), 'parent-project plugin visible from the worktree');
  } finally { await boot.close(); }
});
