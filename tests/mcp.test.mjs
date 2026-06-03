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
const SCENARIO_TOOL_ONLY = path.join(__dirname, 'fixtures', 'scenario-tool-only.json');
const SCENARIO_THINKING_RECONCILED = path.join(__dirname, 'fixtures', 'scenario-thinking-reconciled.json');

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
    assert.equal(body.result.serverInfo.name, 'code-conductor');
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
      'approve_plan',
      'create_project', 'create_workspace', 'create_worktree',
      'delete_workspace', 'delete_worktree',
      'get_recent_messages', 'get_transcript', 'get_worktree_diff',
      'interrupt_turn',
      'kill_instance',
      'list_instances', 'list_projects', 'list_sessions',
      'list_workspaces', 'list_worktrees',
      'locate_session',
      'merge_worktree',
      'project_status',
      'read_file', 'reject_plan', 'rename_workspace', 'respawn_instance',
      'send_prompt', 'set_auto_approve_plan', 'set_mode',
      'set_project_workspace',
      'spawn_instance', 'subscribe_to_idle', 'sync_worktree',
      'unsubscribe_from_idle',
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

test('list_sessions marks MCP-spawned sessions conductor:true, HTTP ones false, and returns both', async () => {
  const { encodeCwd } = await import('../src/projects.js');
  const { baseUrl, instances, claudeProjectsRoot, projectsRoot, close } =
    await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

    // Conductor session: spawned via the MCP spawn_instance tool.
    const cond = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    assert.equal(cond.conductor, true, 'MCP-spawned summary carries conductor:true');
    const condInst = instances.get(cond.id);
    await waitFor(() => condInst.status === 'idle' && condInst.sessionId);
    // Drive a turn so the durable marker is persisted on turn_end.
    await callTool(baseUrl, 'send_prompt', { id: cond.id, text: 'go', wait: true, waitTimeoutMs: 5000 });
    const condSid = condInst.sessionId;

    // Non-conductor session: spawned via the browser / HTTP path.
    const httpRes = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    assert.equal(httpRes.body.conductor, false, 'HTTP-spawned summary carries conductor:false');
    const httpInst = instances.get(httpRes.body.id);
    await waitFor(() => httpInst.status === 'idle' && httpInst.sessionId);
    const httpSid = httpInst.sessionId;

    // The durable marker lands in the central-store sidecar.
    const sidecar = path.join(projectsRoot, '.code-conductor', 'conductor-sessions.json');
    await waitFor(async () => {
      try { return JSON.parse(await fs.readFile(sidecar, 'utf8')).sessions?.includes(condSid); }
      catch { return false; }
    });

    // Materialize both jsonls (the fake CLI doesn't write them).
    const dir = path.join(claudeProjectsRoot, encodeCwd(condInst.cwd));
    await fs.mkdir(dir, { recursive: true });
    for (const sid of [condSid, httpSid]) {
      await fs.writeFile(path.join(dir, `${sid}.jsonl`),
        '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n');
    }

    const list = unwrap(await callTool(baseUrl, 'list_sessions', { project: 'a' }));
    const bySid = new Map(list.map(s => [s.sessionId, s]));
    assert.ok(bySid.has(condSid), 'conductor session is returned (separation, not a filter)');
    assert.ok(bySid.has(httpSid), 'non-conductor session is returned');
    assert.equal(bySid.get(condSid).conductor, true, 'MCP session annotated conductor:true');
    assert.equal(bySid.get(httpSid).conductor, false, 'HTTP session annotated conductor:false');

    // The marker is durable: it survives the live instance going away
    // (simulating restart/resume recognition) because it reads from the
    // on-disk sidecar, not the in-memory instance.
    await callTool(baseUrl, 'kill_instance', { id: cond.id });
    const list2 = unwrap(await callTool(baseUrl, 'list_sessions', { project: 'a' }));
    const c2 = list2.find(s => s.sessionId === condSid);
    assert.ok(c2 && c2.conductor === true, 'conductor marker persists after the instance exits');
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

test('locate_session finds an on-disk session by id, 404s when missing', async () => {
  const { encodeCwd } = await import('../src/projects.js');
  const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'host' });
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, 'host')));
    await fs.mkdir(dir, { recursive: true });
    const sid = 'cccccccc-1111-2222-3333-444444444444';
    await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));

    const hit = unwrap(await callTool(ctx.baseUrl, 'locate_session', { sessionId: sid }));
    assert.deepEqual(hit, { project: 'host', worktreeName: null });

    const { body: miss } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'locate_session', arguments: { sessionId: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(miss.result.isError, true);
    assert.match(miss.result.content[0].text, /session not found/);

    const { body: bad } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'locate_session', arguments: {},
    });
    assert.equal(bad.result.isError, true);
  } finally { await ctx.close(); }
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

test('merge_worktree accepts {project, worktreeName} when the instance is gone', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    // Create a worktree, attach an instance, kill the instance — the
    // worktree itself stays around.
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    }));
    await waitFor(() => ctx.instances.get(spawn.id).sessionId);
    const wtName = ctx.instances.get(spawn.id).worktree.worktreeName;
    await callTool(ctx.baseUrl, 'kill_instance', { id: spawn.id });
    assert.equal(ctx.instances.get(spawn.id), undefined);

    // The worktree is up-to-date with main (no commits yet on either side),
    // so a merge with --no-ff produces an empty-but-valid merge commit.
    const mergeRes = unwrap(await callTool(ctx.baseUrl, 'merge_worktree', {
      project: 'demo', worktreeName: wtName,
    }));
    assert.equal(mergeRes.ok, true);
    assert.ok(mergeRes.newSha, 'merge produced a new HEAD sha');
  } finally { await ctx.close(); }
});

test('merge_worktree rejects calls without instanceId or {project, worktreeName}', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'merge_worktree', arguments: {},
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /requires either instanceId or both/);
  } finally { await ctx.close(); }
});

test('create_project creates the directory, seeds CLAUDE.md, and optionally inits git', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    // Plain create — no git.
    const plain = unwrap(await callTool(ctx.baseUrl, 'create_project', { name: 'plain' }));
    assert.equal(plain.name, 'plain');
    assert.equal(plain.gitInit, false);
    const claudeMd = await fs.readFile(path.join(ctx.projectsRoot, 'plain', 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /@\.\.\/CLAUDE\.md/);
    // No .git dir.
    await assert.rejects(fs.stat(path.join(ctx.projectsRoot, 'plain', '.git')));

    // With git init.
    const repo = unwrap(await callTool(ctx.baseUrl, 'create_project', { name: 'with-git', gitInit: true }));
    assert.equal(repo.gitInit, true);
    const gitStat = await fs.stat(path.join(ctx.projectsRoot, 'with-git', '.git'));
    assert.ok(gitStat.isDirectory());

    // Name validation flows through to MCP isError.
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'create_project', arguments: { name: 'bad name with spaces' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /invalid project name/);

    // EEXIST surfaces as isError too.
    const { body: dup } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'create_project', arguments: { name: 'plain' },
    });
    assert.equal(dup.result.isError, true);
    assert.match(dup.result.content[0].text, /already exists/);
  } finally { await ctx.close(); }
});

test('get_recent_messages reads the most recent assistant text from the ring', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => ctx.instances.get(spawn.id).status === 'idle' && ctx.instances.get(spawn.id).sessionId);

    // Before any turn — no assistant content yet.
    const before = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id }));
    assert.equal(before.messages.length, 0);

    // First turn: text "First " + Bash tool_use.
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'one', wait: true, waitTimeoutMs: 5000 });
    const first = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id }));
    assert.equal(first.messages[0].text, 'First ');
    assert.equal(first.messages[0].hasToolUse, true);
    assert.ok(first.messages[0].blocks.some(b => b.type === 'tool_use' && b.name === 'Bash'));
    assert.ok(first.messages[0].blocks.every(b => b.type !== 'text'), 'tool-call message blocks has no text entries');

    // Second turn: just text "Second!" — should now be the latest.
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'two', wait: true, waitTimeoutMs: 5000 });
    const second = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id }));
    assert.equal(second.messages[0].text, 'Second!');
    assert.notEqual(second.messages[0].msgId, first.messages[0].msgId);
    assert.ok(!Object.hasOwn(second.messages[0], 'blocks'), 'pure-text message omits blocks field');

    // count:2 returns both turns, oldest-first.
    const both = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id, count: 2 }));
    assert.equal(both.messages.length, 2);
    assert.equal(both.messages[0].text, 'First ');
    assert.equal(both.messages[0].hasToolUse, true);
    assert.equal(both.messages[1].text, 'Second!');

    // count larger than available — returns what's there.
    const cap = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id, count: 10 }));
    assert.equal(cap.messages.length, 2);
  } finally { await ctx.close(); }
});

test('get_recent_messages filters tool-call-only messages by default', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_TOOL_ONLY });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => ctx.instances.get(spawn.id).status === 'idle' && ctx.instances.get(spawn.id).sessionId);

    // Turn 1: tool-only. Default filter → messages[] is empty.
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'one', wait: true, waitTimeoutMs: 5000 });
    const afterToolOnly = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id }));
    assert.equal(afterToolOnly.messages.length, 0);

    // Turn 2: text "Hello".
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'two', wait: true, waitTimeoutMs: 5000 });
    // Turn 3: tool-only.
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'three', wait: true, waitTimeoutMs: 5000 });

    // Default filter: count:3 yields only the one message with text.
    const filtered = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id, count: 3 }));
    assert.equal(filtered.messages.length, 1);
    assert.equal(filtered.messages[0].text, 'Hello');

    // includeToolCalls:true restores all three messages, oldest-first.
    const all = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id, count: 3, includeToolCalls: true }));
    assert.equal(all.messages.length, 3);
    assert.equal(all.messages[0].text, '');
    assert.equal(all.messages[0].hasToolUse, true);
    assert.equal(all.messages[1].text, 'Hello');
    assert.equal(all.messages[2].text, '');
    assert.equal(all.messages[2].hasToolUse, true);
  } finally { await ctx.close(); }
});

test('get_recent_messages strips thinking blocks by default, includeThinking restores them', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_THINKING_RECONCILED });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => ctx.instances.get(spawn.id).status === 'idle' && ctx.instances.get(spawn.id).sessionId);

    // Turn: assistant message with thinking + text "42".
    await callTool(ctx.baseUrl, 'send_prompt', { id: spawn.id, text: 'one', wait: true, waitTimeoutMs: 5000 });

    // Default: thinking stripped, text-bearing message still returned.
    const stripped = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id }));
    assert.equal(stripped.messages.length, 1, 'text-bearing message returned even when thinking stripped');
    assert.equal(stripped.messages[0].text, '42');
    assert.ok(!Object.hasOwn(stripped.messages[0], 'blocks'), 'no blocks field when thinking stripped');

    // includeThinking: true reveals the thinking block.
    const withThinking = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { id: spawn.id, includeThinking: true }));
    assert.equal(withThinking.messages[0].text, '42');
    assert.ok(Object.hasOwn(withThinking.messages[0], 'blocks'), 'blocks present with includeThinking');
    assert.equal(withThinking.messages[0].blocks.length, 1);
    assert.equal(withThinking.messages[0].blocks[0].type, 'thinking');
    assert.equal(withThinking.messages[0].blocks[0].text, 'Pondering. Concluded.');
  } finally { await ctx.close(); }
});

test('project_status returns branch + HEAD + recent commits + top-level files', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    // Add an untracked file + a tracked change so dirty has content.
    await fs.writeFile(path.join(repoPath, 'untracked.txt'), 'u\n');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n');

    const st = unwrap(await callTool(ctx.baseUrl, 'project_status', { project: 'demo' }));
    assert.equal(st.project, 'demo');
    assert.equal(st.worktree, null);
    assert.equal(st.isGitRepo, true);
    assert.equal(st.branch, 'main');
    assert.ok(st.head && st.head.sha && st.head.subject === 'initial');
    assert.ok(Array.isArray(st.recentCommits) && st.recentCommits[0].includes('initial'));
    assert.ok(Array.isArray(st.files));
    const fileNames = st.files.map(f => f.name);
    assert.ok(fileNames.includes('README.md'));
    assert.ok(fileNames.includes('untracked.txt'));
    // Dirty lines should include both the modified and untracked files.
    assert.ok(st.dirty.some(l => l.includes('README.md')));
    assert.ok(st.dirty.some(l => l.includes('untracked.txt')));
  } finally { await ctx.close(); }
});

test('project_status scoped to a worktree returns mergeStatus + diffStat vs base', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    // Commit a change inside the worktree so it's `ahead` of main.
    const wtPath = path.join(ctx.projectsRoot, wt.worktreeName);
    await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh\n');
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

    const st = unwrap(await callTool(ctx.baseUrl, 'project_status', {
      project: 'demo', worktree: wt.worktreeName,
    }));
    assert.equal(st.worktree, wt.worktreeName);
    assert.equal(st.baseBranch, 'main');
    assert.equal(st.mergeStatus.ahead, 1);
    assert.equal(st.mergeStatus.behind, 0);
    assert.match(st.diffStat, /new\.txt/);
    // logLimit:0 disables recentCommits.
    const noLog = unwrap(await callTool(ctx.baseUrl, 'project_status', {
      project: 'demo', worktree: wt.worktreeName, logLimit: 0,
    }));
    assert.equal(noLog.recentCommits, undefined);
  } finally { await ctx.close(); }
});

test('project_status on a non-git project returns isGitRepo:false but still lists files', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
    const st = unwrap(await callTool(ctx.baseUrl, 'project_status', { project: 'a' }));
    assert.equal(st.isGitRepo, false);
    // The CLAUDE.md seeded by createProject should be there.
    assert.ok(st.files.some(f => f.name === 'CLAUDE.md' && f.kind === 'file'));
    assert.equal(st.branch, undefined); // git fields omitted on non-repo
  } finally { await ctx.close(); }
});

test('read_file reads UTF-8 by relative path, rejects traversal, caps at maxBytes', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await fs.writeFile(path.join(repoPath, 'hello.txt'), 'hello world\n');

    const ok = unwrap(await callTool(ctx.baseUrl, 'read_file', {
      project: 'demo', relativePath: 'hello.txt',
    }));
    assert.equal(ok.encoding, 'utf8');
    assert.equal(ok.content, 'hello world\n');
    assert.equal(ok.truncated, false);

    // Truncation: maxBytes:5 caps to "hello".
    const cut = unwrap(await callTool(ctx.baseUrl, 'read_file', {
      project: 'demo', relativePath: 'hello.txt', maxBytes: 5,
    }));
    assert.equal(cut.content, 'hello');
    assert.equal(cut.truncated, true);

    // Traversal: blocked.
    const { body: trav } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'read_file', arguments: { project: 'demo', relativePath: '../../etc/hostname' },
    });
    assert.equal(trav.result.isError, true);
    assert.match(trav.result.content[0].text, /escapes project root/);

    // Absolute path: blocked.
    const { body: abs } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'read_file', arguments: { project: 'demo', relativePath: '/etc/hostname' },
    });
    assert.equal(abs.result.isError, true);
    assert.match(abs.result.content[0].text, /project-relative/);

    // Missing file → isError 404.
    const { body: miss } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'read_file', arguments: { project: 'demo', relativePath: 'nope.txt' },
    });
    assert.equal(miss.result.isError, true);
    assert.match(miss.result.content[0].text, /file not found/);
  } finally { await ctx.close(); }
});

test('read_file scoped to a worktree reads from the worktree root, not the parent', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    // Same filename on both sides, different content.
    await fs.writeFile(path.join(repoPath, 'shared.txt'), 'parent\n');
    const wtPath = path.join(ctx.projectsRoot, wt.worktreeName);
    await fs.writeFile(path.join(wtPath, 'shared.txt'), 'worktree\n');

    const fromWt = unwrap(await callTool(ctx.baseUrl, 'read_file', {
      project: 'demo', worktree: wt.worktreeName, relativePath: 'shared.txt',
    }));
    assert.equal(fromWt.content, 'worktree\n');

    const fromParent = unwrap(await callTool(ctx.baseUrl, 'read_file', {
      project: 'demo', relativePath: 'shared.txt',
    }));
    assert.equal(fromParent.content, 'parent\n');
  } finally { await ctx.close(); }
});
