// Integration tests for the MCP server mounted at /mcp. Drives the
// transport via fetch — same shape a `claude mcp add --transport http`
// client would use. Reuses the fake-claude subprocess via bootServer().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let nextRpcId = 1;

async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  const body = await res.json();
  return { status: res.status, body };
}

async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

// MCP wraps tool returns as content[].text JSON — unwrap to the underlying object.
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const text = result.content.map(c => c.text).join('');
  return JSON.parse(text);
}

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

test('initialize handshake returns expected server info + tools capability', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(body.result, 'initialize has a result');
    assert.equal(body.result.serverInfo.name, 'claude-orch');
    assert.ok(body.result.capabilities.tools, 'declares tools capability');
    assert.match(body.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  } finally { await close(); }
});

test('notifications/initialized returns 202 with no body', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(res.status, 202);
  } finally { await close(); }
});

test('tools/list returns the full expected tool catalog', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/list');
    assert.ok(Array.isArray(body.result.tools));
    const names = body.result.tools.map(t => t.name).sort();
    const expected = [
      'create_worktree', 'delete_worktree',
      'get_transcript',
      'interrupt_turn',
      'kill_instance',
      'list_instances', 'list_projects', 'list_sessions', 'list_worktrees',
      'merge_worktree',
      'respawn_instance',
      'send_prompt', 'set_mode',
      'spawn_instance', 'sync_worktree',
      'wait_for_idle',
    ].sort();
    assert.deepEqual(names, expected);
    // Every tool carries a schema.
    for (const t of body.result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(typeof t.description === 'string' && t.description.length > 0);
    }
  } finally { await close(); }
});

test('unknown method yields a JSON-RPC error envelope', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'no/such/method');
    assert.ok(body.error, 'has an error envelope');
    assert.equal(body.error.code, -32601);
  } finally { await close(); }
});

test('unknown tool returns an isError tool-call result (not a transport error)', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/call', { name: 'nope', arguments: {} });
    assert.ok(body.result, 'still a successful JSON-RPC response');
    assert.equal(body.result.isError, true);
  } finally { await close(); }
});

test('list_projects sees projects created via REST', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'alpha' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'beta' });
    const result = await callTool(baseUrl, 'list_projects', {});
    const projects = unwrap(result);
    const names = projects.map(p => p.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
    for (const p of projects) {
      assert.ok('isGitRepo' in p);
      assert.ok(Array.isArray(p.worktrees));
      assert.ok(Array.isArray(p.instanceIds));
    }
  } finally { await close(); }
});

test('spawn_instance + send_prompt(wait:true) + get_transcript round-trip', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

    // Spawn a fresh instance via MCP.
    const spawnRes = await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    });
    const spawn = unwrap(spawnRes);
    assert.ok(spawn.id, 'spawn returns instance id');
    await waitFor(() => instances.get(spawn.id).status === 'idle' && instances.get(spawn.id).sessionId);

    // Send a prompt and wait for turn_end inline.
    const promptRes = await callTool(baseUrl, 'send_prompt', {
      id: spawn.id, text: 'go', wait: true, waitTimeoutMs: 5000,
    });
    const promptBody = unwrap(promptRes);
    assert.equal(promptBody.ok, true);
    assert.ok(promptBody.turnEnd, 'wait:true returns the turn_end event');
    assert.equal(promptBody.turnEnd.kind, 'turn_end');

    // Read the transcript and verify the events flow.
    const txRes = await callTool(baseUrl, 'get_transcript', { id: spawn.id });
    const tx = unwrap(txRes);
    const kinds = tx.events.map(e => e.kind);
    assert.ok(kinds.includes('text_delta'));
    assert.ok(kinds.includes('tool_use'));
    assert.ok(kinds.includes('turn_end'));
    assert.equal(typeof tx.lastSeq, 'number');

    // sinceSeq filter: after the turn, asking sinceSeq=lastSeq returns nothing.
    const tail = unwrap(await callTool(baseUrl, 'get_transcript', { id: spawn.id, sinceSeq: tx.lastSeq }));
    assert.equal(tail.events.length, 0);
  } finally { await close(); }
});

test('wait_for_idle resolves when an in-flight turn completes', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_INSTANCE });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instances.get(spawn.id).sessionId);

    // Kick a non-blocking prompt off, then race wait_for_idle against
    // the orchestrator's own status flip.
    await callTool(baseUrl, 'send_prompt', { id: spawn.id, text: 'one' });
    const waitRes = unwrap(await callTool(baseUrl, 'wait_for_idle', {
      id: spawn.id, timeoutMs: 5000,
    }));
    assert.equal(waitRes.status, 'idle');
  } finally { await close(); }
});

test('set_mode round-trips and is reflected on the live instance', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instances.get(spawn.id).sessionId);
    const modeRes = unwrap(await callTool(baseUrl, 'set_mode', { id: spawn.id, mode: 'plan' }));
    assert.equal(modeRes.mode, 'plan');
    assert.equal(instances.get(spawn.id).mode, 'plan');
  } finally { await close(); }
});

test('kill_instance removes the instance from the manager', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instances.get(spawn.id).sessionId);
    const killRes = unwrap(await callTool(baseUrl, 'kill_instance', { id: spawn.id }));
    assert.equal(killRes.ok, true);
    assert.equal(instances.get(spawn.id), undefined);
  } finally { await close(); }
});

test('argument validation rejects a missing required field via isError', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/call', {
      name: 'list_sessions', arguments: {},
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /missing required argument: project/);
  } finally { await close(); }
});

test('create_worktree + list_worktrees + delete_worktree against a real git repo', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const createRes = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    assert.match(createRes.worktreeName, /^demo_worktree_[a-f0-9]{6}$/);
    assert.equal(createRes.baseBranch, 'main');

    const wts = unwrap(await callTool(ctx.baseUrl, 'list_worktrees', { project: 'demo' }));
    assert.equal(wts.length, 1);
    assert.equal(wts[0].worktreeName, createRes.worktreeName);

    const del = unwrap(await callTool(ctx.baseUrl, 'delete_worktree', {
      project: 'demo', worktreeName: createRes.worktreeName,
    }));
    assert.equal(del.ok, true);
    const wts2 = unwrap(await callTool(ctx.baseUrl, 'list_worktrees', { project: 'demo' }));
    assert.equal(wts2.length, 0);
  } finally { await ctx.close(); }
});

test('merge_worktree refuses with friendly reason when the worktree is behind', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    // Spawn an instance into a fresh worktree.
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    }));
    await waitFor(() => ctx.instances.get(spawn.id).sessionId);

    // Move the parent branch forward so the worktree is now "behind".
    await fs.writeFile(path.join(repoPath, 'extra.txt'), 'after\n');
    await git(repoPath, 'add', '.');
    await git(repoPath, 'commit', '-q', '-m', 'second');

    const mergeRes = unwrap(await callTool(ctx.baseUrl, 'merge_worktree', { instanceId: spawn.id }));
    assert.equal(mergeRes.ok, false);
    assert.match(mergeRes.reason, /behind .* click Sync first|call sync_worktree first/i);
  } finally { await ctx.close(); }
});
