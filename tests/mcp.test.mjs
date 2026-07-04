// Integration tests for the MCP server mounted at /mcp. Drives the
// transport via fetch — same shape a `claude mcp add --transport http`
// client would use. Reuses the fake-claude subprocess via bootServer().

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_TOOL_ONLY = path.join(__dirname, 'fixtures', 'scenario-tool-only.json');
const SCENARIO_THINKING_RECONCILED = path.join(__dirname, 'fixtures', 'scenario-thinking-reconciled.json');
const SCENARIO_EXIT_PLAN_INLINE = path.join(__dirname, 'fixtures', 'scenario-exit-plan-inline.json');
const SCENARIO_ASK_USER_QUESTION_INLINE = path.join(__dirname, 'fixtures', 'scenario-ask-user-question-inline.json');
const SCENARIO_EXIT_PLAN_RECONCILED = path.join(__dirname, 'fixtures', 'scenario-exit-plan-inline-reconciled.json');
const SCENARIO_ASK_USER_QUESTION_RECONCILED = path.join(__dirname, 'fixtures', 'scenario-ask-user-question-inline-reconciled.json');
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');

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

// MCP wraps tool returns as content[]: content[0] is always compact JSON
// metadata; content[1..] are raw text bodies (multi-block tools). unwrap reads
// the metadata block; the payload helpers also expose the raw bodies.
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
function unwrapPayload(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return { meta: JSON.parse(result.content[0].text), bodies: result.content.slice(1).map(c => c.text) };
}
// read_file convenience: merge the body back onto the metadata as `content`.
function unwrapFile(result) {
  const { meta, bodies } = unwrapPayload(result);
  return { ...meta, content: bodies[0] ?? '' };
}
// get_recent_messages convenience: reattach each message's text from its body.
function unwrapMessages(result) {
  const { meta, bodies } = unwrapPayload(result);
  return { sessionId: meta.sessionId, messages: meta.messages.map((m, i) => ({ ...m, text: bodies[i] ?? '' })) };
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

// Shared server booted once for the file (dominant scenario: SCENARIO_WS).
// Non-dominant tests swap FAKE_CLAUDE_SCENARIO in their own try/finally.
let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot());
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

test('initialize handshake returns expected server info + tools capability', async () => {
  const { body } = await rpc(baseUrl, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(body.jsonrpc, '2.0');
  assert.ok(body.result, 'initialize has a result');
  assert.equal(body.result.serverInfo.name, 'code-conductor');
  assert.ok(body.result.capabilities.tools, 'declares tools capability');
  assert.match(body.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('notifications/initialized returns 202 with no body', async () => {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
});

test('tools/list returns the full expected tool catalog', async () => {
  const { body } = await rpc(baseUrl, 'tools/list');
  assert.ok(Array.isArray(body.result.tools));
  const names = body.result.tools.map(t => t.name).sort();
  const expected = [
    'answer_question',
    'approve_plan',
    'create_project', 'create_workspace', 'create_worktree',
    'delete_workspace', 'delete_worktree',
    'get_recent_messages', 'get_transcript', 'get_worktree_diff',
    'glob', 'grep',
    'interrupt_turn',
    'kill_instance',
    'list_instances', 'list_optional_guidelines', 'list_projects', 'list_sessions',
    'list_workspaces', 'list_worktrees',
    'locate_session',
    'merge_worktree',
    'project_status', 'promote_session',
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
});

test('unknown method yields a JSON-RPC error envelope', async () => {
  const { body } = await rpc(baseUrl, 'no/such/method');
  assert.ok(body.error, 'has an error envelope');
  assert.equal(body.error.code, -32601);
});

test('unknown tool returns an isError tool-call result (not a transport error)', async () => {
  const { body } = await rpc(baseUrl, 'tools/call', { name: 'nope', arguments: {} });
  assert.ok(body.result, 'still a successful JSON-RPC response');
  assert.equal(body.result.isError, true);
});

test('list_projects sees projects created via REST', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'alpha' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'beta' });
  const result = await callTool(baseUrl, 'list_projects', {});
  const projects = unwrap(result);
  const names = projects.map(p => p.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);
  for (const p of projects) {
    assert.ok('isGitRepo' in p);
    assert.ok(Array.isArray(p.worktrees));
    assert.ok(Array.isArray(p.sessionIds));
  }
});

test('spawn_instance + send_prompt(wait:true) + get_transcript round-trip', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // Spawn a fresh instance via MCP.
  const spawnRes = await callTool(baseUrl, 'spawn_instance', {
    project: 'a', mode: 'bypassPermissions',
  });
  const spawn = unwrap(spawnRes);
  assert.ok(spawn.sessionId, 'spawn returns sessionId');
  await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

  // Send a prompt and wait for turn_end inline.
  const promptRes = await callTool(baseUrl, 'send_prompt', {
    sessionId: spawn.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000,
  });
  const promptBody = unwrap(promptRes);
  assert.equal(promptBody.sessionId, spawn.sessionId);
  assert.ok(promptBody.turnEnd, 'wait:true returns the turn_end event');
  assert.equal(promptBody.turnEnd.kind, 'turn_end');

  // Read the transcript and verify the events flow.
  const txRes = await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId });
  const tx = unwrap(txRes);
  const kinds = tx.events.map(e => e.kind);
  assert.ok(kinds.includes('text_delta'));
  assert.ok(kinds.includes('tool_use'));
  assert.ok(kinds.includes('turn_end'));
  assert.equal(typeof tx.lastSeq, 'number');
  // Untrimmed ring → trimmedBefore is 0.
  assert.equal(tx.trimmedBefore, 0);

  // sinceSeq filter: after the turn, asking sinceSeq=lastSeq returns nothing.
  const tail = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId, sinceSeq: tx.lastSeq }));
  assert.equal(tail.events.length, 0);
});

test('get_transcript + get_recent_messages survive a trimmed ring', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '20';
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });

    // Force eviction with synthetic history; the newest assistant text
    // must remain reachable for get_recent_messages.
    const inst = instForSession(instances, spawn.sessionId);
    for (let i = 0; i < 100; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'mNew', blockIdx: 0, text: i === 99 ? 'the latest words' : `pad ${i} ` });
    }
    inst._emitUi({ kind: 'text_end', msgId: 'mNew', blockIdx: 0 });
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    const tx = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId }));
    assert.equal(tx.trimmedBefore, inst.ring.trimmedBefore);
    // sinceSeq below trimmedBefore: this fixture has no on-disk jsonl (the fake
    // CLI doesn't write one), so disk-fallback finds nothing and the dropped
    // range is served from the ring only — events start at trimmedBefore.
    // (Real disk-backed paging into a dropped range is covered in
    // tests/mcp-recent-disk.test.mjs.)
    const below = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId, sinceSeq: 0 }));
    assert.ok(below.events.length > 0);
    assert.ok(below.events[0]._seq >= below.trimmedBefore);
    assert.equal(typeof below.hasMore, 'boolean');
    assert.equal(typeof below.nextAfter, 'number');

    const recent = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(recent.messages.length, 1);
    assert.ok(recent.messages[0].text.includes('the latest words'));
  } finally {
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('wait_for_idle resolves when an in-flight turn completes', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);

    // Kick a non-blocking prompt off, then race wait_for_idle against
    // the orchestrator's own status flip.
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' });
    const waitRes = unwrap(await callTool(baseUrl, 'wait_for_idle', {
      sessionId: spawn.sessionId, timeoutMs: 5000,
    }));
    assert.equal(waitRes.status, 'idle');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('interrupt_turn: soft (default) sets interrupting, force aborts the turn', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);

    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' });
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle');

    // Slow turn — stays in `turn` (scenario emits no result for it).
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two please be slow' });
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'turn');

    // Soft (force omitted): flag set, turn continues.
    const soft = unwrap(await callTool(baseUrl, 'interrupt_turn', { sessionId: spawn.sessionId }));
    assert.equal(soft.status, 'turn');
    assert.equal(soft.interrupting, true);
    assert.equal(instForSession(instances, spawn.sessionId).interrupting, true);

    // Force: hard abort ends the turn and clears the flag.
    await callTool(baseUrl, 'interrupt_turn', { sessionId: spawn.sessionId, force: true });
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle');
    assert.equal(instForSession(instances, spawn.sessionId).interrupting, false);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('set_mode round-trips and is reflected on the live instance', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const modeRes = unwrap(await callTool(baseUrl, 'set_mode', { sessionId: spawn.sessionId, mode: 'plan' }));
  assert.equal(modeRes.mode, 'plan');
  assert.equal(instForSession(instances, spawn.sessionId).mode, 'plan');
});

test('kill_instance removes the instance from the manager', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const killRes = unwrap(await callTool(baseUrl, 'kill_instance', { sessionId: spawn.sessionId }));
  assert.equal(killRes.sessionId, spawn.sessionId);
  assert.equal(instForSession(instances, spawn.sessionId), undefined);
});

test('list_sessions marks MCP-spawned sessions conducted:true, HTTP ones false, and returns both', async () => {
  const { encodeCwd } = await import('../src/projects.js');
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // Conducted session: spawned via the MCP spawn_instance tool. Pass
  // temp:false explicitly — MCP spawns default to temp:true, and this test
  // is about list annotation (MCP conducted:true vs HTTP false), not temp
  // durability. A non-temp session is the simplest fixture for that:
  // it survives kill_instance without its jsonl being wiped.
  const cond = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions', temp: false }));
  assert.equal(cond.conducted, true, 'MCP-spawned summary carries conducted:true');
  const condInst = instForSession(instances, cond.sessionId);
  await waitFor(() => condInst.status === 'idle' && condInst.sessionId);
  // Drive a turn so the durable marker is persisted on turn_end.
  await callTool(baseUrl, 'send_prompt', { sessionId: cond.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });
  const condSid = condInst.sessionId;

  // Non-conducted session: spawned via the browser / HTTP path.
  const httpRes = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
  assert.equal(httpRes.body.conducted, false, 'HTTP-spawned summary carries conducted:false');
  const httpInst = instances.get(httpRes.body.id);
  await waitFor(() => httpInst.status === 'idle' && httpInst.sessionId);
  const httpSid = httpInst.sessionId;

  // The durable marker lands in the central-store sidecar.
  const sidecar = path.join(projectsRoot, '.code-conductor', 'conducted-sessions.json');
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
  assert.ok(bySid.has(condSid), 'conducted session is returned (separation, not a filter)');
  assert.ok(bySid.has(httpSid), 'non-conducted session is returned');
  assert.equal(bySid.get(condSid).conducted, true, 'MCP session annotated conducted:true');
  assert.equal(bySid.get(httpSid).conducted, false, 'HTTP session annotated conducted:false');

  // The marker is durable: it survives the live instance going away
  // (simulating restart/resume recognition) because it reads from the
  // on-disk sidecar, not the in-memory instance.
  await callTool(baseUrl, 'kill_instance', { sessionId: cond.sessionId });
  const list2 = unwrap(await callTool(baseUrl, 'list_sessions', { project: 'a' }));
  const c2 = list2.find(s => s.sessionId === condSid);
  assert.ok(c2 && c2.conducted === true, 'conducted marker persists after the instance exits');
});

test('temp conducted session persists the conducted marker and recovers it on resume', async () => {
  // Regression: a default MCP-spawned worker is BOTH temp:true and
  // conducted:true. The durable conducted marker must be written DESPITE temp
  // (i.e. before the `if (this.temp) return;` early-return in
  // _writeSessionMetadata) — otherwise an orchestrator SIGKILL (where the
  // on-exit _deleteTempArtifacts never runs, so the jsonl + sidecars survive)
  // leaves nothing for create() to recover and the session resumes with
  // conducted falsy. This exercises both halves: the durable WRITE (a live
  // temp+conducted turn) and the RECOVERY (create({resume}) reading sidecars).
  const { isConducted, markConducted } = await import('../src/conductedSessions.js');
  const { isTemp, markTemp } = await import('../src/tempSessions.js');
  const { encodeCwd } = await import('../src/projects.js');
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // --- WRITE side (the fix) ---
  // Spawn with MCP defaults: temp:true + conducted:true (the buggy combo).
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  assert.equal(spawn.conducted, true, 'MCP spawn defaults to conducted:true');
  assert.equal(spawn.temp, true, 'MCP spawn defaults to temp:true');
  const inst = instForSession(instances, spawn.sessionId);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const sid = inst.sessionId;

  // Drive a turn so _writeSessionMetadata() runs. Both durable markers must
  // land even though the session is temp. (Before the fix, isConducted(sid)
  // would be false here — markConducted sat after the temp early-return.)
  await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });
  await waitFor(async () => (await isConducted(sid)) === true);
  assert.equal(await isConducted(sid), true, 'conducted marker persisted for a temp session');
  assert.equal(await isTemp(sid), true, 'temp marker persisted (shared code path)');

  // --- RECOVERY side ---
  // Simulate the post-orchestrator-SIGKILL state directly: the jsonl and
  // both sidecar markers survived because _handleExit never ran. (We can't
  // reproduce that by killing the live child here — _handleExit WOULD fire
  // and _deleteTempArtifacts would wipe the markers.) Resuming by id, with
  // NO temp/conducted passed, must re-acquire BOTH flags from the sidecars.
  const survivedSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await markConducted(survivedSid);
  await markTemp(survivedSid);
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${survivedSid}.jsonl`),
    '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n');

  const recovered = await instances.create({ project: 'a', resume: survivedSid });
  assert.equal(recovered.conducted, true, 'conducted recovered on resume from sidecar');
  assert.equal(recovered.temp, true, 'temp recovered on resume from sidecar');
});

test('argument validation rejects a missing required field via isError', async () => {
  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'list_sessions', arguments: {},
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /missing required argument: project/);
});

test('locate_session finds an on-disk session by id, 404s when missing', async () => {
  const { encodeCwd } = await import('../src/projects.js');
  const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');
  await api(baseUrl, 'POST', '/api/projects', { name: 'host' });
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'host')));
  await fs.mkdir(dir, { recursive: true });
  const sid = 'cccccccc-1111-2222-3333-444444444444';
  await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));

  const hit = unwrap(await callTool(baseUrl, 'locate_session', { sessionId: sid }));
  assert.deepEqual(hit, { project: 'host', worktree: null });

  const { body: miss } = await rpc(baseUrl, 'tools/call', {
    name: 'locate_session', arguments: { sessionId: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(miss.result.isError, true);
  assert.match(miss.result.content[0].text, /session not found/);

  const { body: bad } = await rpc(baseUrl, 'tools/call', {
    name: 'locate_session', arguments: {},
  });
  assert.equal(bad.result.isError, true);
});

test('create_worktree + list_worktrees + delete_worktree against a real git repo', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const createRes = unwrap(await callTool(baseUrl, 'create_worktree', { project: 'demo' }));
  assert.match(createRes.worktree, /^demo_worktree_[a-f0-9]{6}$/);
  assert.equal(createRes.baseBranch, 'main');

  const wts = unwrap(await callTool(baseUrl, 'list_worktrees', { project: 'demo' }));
  assert.equal(wts.length, 1);
  assert.equal(wts[0].worktree, createRes.worktree);

  const del = unwrap(await callTool(baseUrl, 'delete_worktree', {
    project: 'demo', worktree: createRes.worktree,
  }));
  assert.equal(del.worktree, createRes.worktree);
  const wts2 = unwrap(await callTool(baseUrl, 'list_worktrees', { project: 'demo' }));
  assert.equal(wts2.length, 0);
});

test('merge_worktree refuses with friendly reason when the worktree is behind', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  // Spawn an instance into a fresh worktree.
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);

  // Move the parent branch forward so the worktree is now "behind".
  await fs.writeFile(path.join(repoPath, 'extra.txt'), 'after\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'second');

  const mergeRes = unwrap(await callTool(baseUrl, 'merge_worktree', { sessionId: spawn.sessionId }));
  assert.equal(mergeRes.ok, false);
  assert.equal(mergeRes.code, 'WORKTREE_BEHIND');
  assert.match(mergeRes.reason, /behind .* click Sync first|call sync_worktree first/i);
});

test('merge_worktree accepts {project, worktree} when the instance is gone', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  // Create a worktree, attach an instance, kill the instance — the
  // worktree itself stays around.
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const wtName = instForSession(instances, spawn.sessionId).worktree.worktreeName;
  await callTool(baseUrl, 'kill_instance', { sessionId: spawn.sessionId });
  assert.equal(instForSession(instances, spawn.sessionId), undefined);

  // The worktree is up-to-date with main (no commits yet on either side),
  // so a merge with --no-ff produces an empty-but-valid merge commit.
  const mergeRes = unwrap(await callTool(baseUrl, 'merge_worktree', {
    project: 'demo', worktree: wtName,
  }));
  assert.equal(mergeRes.ok, true);
  assert.ok(mergeRes.newSha, 'merge produced a new HEAD sha');
});

test('merge_worktree rejects calls without sessionId or {project, worktree}', async () => {
  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'merge_worktree', arguments: {},
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /requires either sessionId or both/);
});

test('create_project creates the directory, seeds CLAUDE.md, and optionally inits git', async () => {
  // Plain create — no git.
  const plain = unwrap(await callTool(baseUrl, 'create_project', { name: 'plain' }));
  assert.equal(plain.name, 'plain');
  assert.equal(plain.gitInit, false);
  const claudeMd = await fs.readFile(path.join(projectsRoot, 'plain', 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /@\.\.\/CLAUDE\.md/);
  // No .git dir.
  await assert.rejects(fs.stat(path.join(projectsRoot, 'plain', '.git')));

  // With git init.
  const repo = unwrap(await callTool(baseUrl, 'create_project', { name: 'with-git', gitInit: true }));
  assert.equal(repo.gitInit, true);
  const gitStat = await fs.stat(path.join(projectsRoot, 'with-git', '.git'));
  assert.ok(gitStat.isDirectory());

  // Name validation now fires at the schema layer (pattern) before the handler.
  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'create_project', arguments: { name: 'bad name with spaces' },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /must match \^\[a-zA-Z0-9/);

  // EEXIST surfaces as isError too.
  const { body: dup } = await rpc(baseUrl, 'tools/call', {
    name: 'create_project', arguments: { name: 'plain' },
  });
  assert.equal(dup.result.isError, true);
  assert.match(dup.result.content[0].text, /already exists/);
});

test('get_recent_messages reads the most recent assistant text from the ring', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'a', mode: 'bypassPermissions',
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

  // Before any turn — no assistant content yet.
  const before = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
  assert.equal(before.messages.length, 0);

  // First turn: text "First " + Bash tool_use.
  await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
  const first = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
  assert.equal(first.messages[0].text, 'First ');
  assert.equal(first.messages[0].hasToolUse, true);
  assert.ok(first.messages[0].blocks.some(b => b.type === 'tool_use' && b.name === 'Bash'));
  assert.ok(first.messages[0].blocks.every(b => b.type !== 'text'), 'tool-call message blocks has no text entries');

  // Second turn: just text "Second!" — should now be the latest.
  await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two', wait: true, waitTimeoutMs: 5000 });
  const second = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
  assert.equal(second.messages[0].text, 'Second!');
  assert.notEqual(second.messages[0].msgId, first.messages[0].msgId);
  assert.ok(!Object.hasOwn(second.messages[0], 'blocks'), 'pure-text message omits blocks field');

  // count:2 returns both turns, oldest-first.
  const both = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 2 }));
  assert.equal(both.messages.length, 2);
  assert.equal(both.messages[0].text, 'First ');
  assert.equal(both.messages[0].hasToolUse, true);
  assert.equal(both.messages[1].text, 'Second!');

  // count larger than available — returns what's there.
  const cap = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 10 }));
  assert.equal(cap.messages.length, 2);
});

test('get_recent_messages filters tool-call-only messages by default', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_TOOL_ONLY;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

    // Turn 1: tool-only. Default filter → messages[] is empty.
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
    const afterToolOnly = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(afterToolOnly.messages.length, 0);

    // Turn 2: text "Hello".
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two', wait: true, waitTimeoutMs: 5000 });
    // Turn 3: tool-only.
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'three', wait: true, waitTimeoutMs: 5000 });

    // Default filter: count:3 yields only the one message with text.
    const filtered = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 3 }));
    assert.equal(filtered.messages.length, 1);
    assert.equal(filtered.messages[0].text, 'Hello');

    // includeToolCalls:true restores all three messages, oldest-first.
    const all = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 3, includeToolCalls: true }));
    assert.equal(all.messages.length, 3);
    assert.equal(all.messages[0].text, '');
    assert.equal(all.messages[0].hasToolUse, true);
    assert.equal(all.messages[1].text, 'Hello');
    assert.equal(all.messages[2].text, '');
    assert.equal(all.messages[2].hasToolUse, true);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('get_recent_messages strips thinking blocks by default, includeThinking restores them', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_THINKING_RECONCILED;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

    // Turn: assistant message with thinking + text "42".
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });

    // Default: thinking stripped, text-bearing message still returned.
    const stripped = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(stripped.messages.length, 1, 'text-bearing message returned even when thinking stripped');
    assert.equal(stripped.messages[0].text, '42');
    assert.ok(!Object.hasOwn(stripped.messages[0], 'blocks'), 'no blocks field when thinking stripped');

    // includeThinking: true reveals the thinking block.
    const withThinking = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, includeThinking: true }));
    assert.equal(withThinking.messages[0].text, '42');
    assert.ok(Object.hasOwn(withThinking.messages[0], 'blocks'), 'blocks present with includeThinking');
    assert.equal(withThinking.messages[0].blocks.length, 1);
    assert.equal(withThinking.messages[0].blocks[0].type, 'thinking');
    assert.equal(withThinking.messages[0].blocks[0].text, 'Pondering. Concluded.');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('get_recent_messages returns plan-bearing messages by default', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_EXIT_PLAN_INLINE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

    const before = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(before.messages.length, 0);

    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

    const after = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(after.messages.length, 1, 'plan-bearing message returned by default');
    assert.equal(after.messages[0].text, '', 'text is empty for plan-only turn');
    assert.equal(after.messages[0].plan, 'Step 1\nStep 2', 'plan field populated');
    assert.equal(after.messages[0].hasToolUse, true);
    assert.ok(!Object.hasOwn(after.messages[0], 'blocks'), 'ExitPlanMode block not duplicated in blocks[]');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('get_recent_messages returns question-bearing messages by default', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_ASK_USER_QUESTION_INLINE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

    const before = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(before.messages.length, 0);

    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'ask me something', wait: true, waitTimeoutMs: 5000 });

    const after = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(after.messages.length, 1, 'question-bearing message returned by default');
    assert.equal(after.messages[0].text, '', 'text is empty for question-only turn');
    assert.ok(Array.isArray(after.messages[0].questions) && after.messages[0].questions.length > 0, 'questions field populated');
    assert.equal(after.messages[0].questions[0].question, 'Which approach?');
    assert.equal(after.messages[0].hasToolUse, true);
    assert.ok(!Object.hasOwn(after.messages[0], 'blocks'), 'AskUserQuestion block not duplicated in blocks[]');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('get_recent_messages: reconciled ExitPlanMode not duplicated in blocks[]', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_EXIT_PLAN_RECONCILED;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });
    const result = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(result.messages.length, 1, 'plan-bearing message returned (reconciled path)');
    assert.equal(result.messages[0].plan, 'Step 1\nStep 2', 'plan field populated (reconciled path)');
    assert.equal(result.messages[0].hasToolUse, true);
    assert.ok(!Object.hasOwn(result.messages[0], 'blocks'), 'ExitPlanMode not in blocks[] (reconciled path)');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('get_recent_messages: reconciled AskUserQuestion not duplicated in blocks[]', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_ASK_USER_QUESTION_RECONCILED;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'a', mode: 'bypassPermissions',
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'ask me', wait: true, waitTimeoutMs: 5000 });
    const result = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(result.messages.length, 1, 'question-bearing message returned (reconciled path)');
    assert.ok(Array.isArray(result.messages[0].questions) && result.messages[0].questions.length > 0, 'questions field populated (reconciled path)');
    assert.equal(result.messages[0].hasToolUse, true);
    assert.ok(!Object.hasOwn(result.messages[0], 'blocks'), 'AskUserQuestion not in blocks[] (reconciled path)');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('project_status returns branch + HEAD + recent commits + top-level files', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  // Add an untracked file + a tracked change so dirty has content.
  await fs.writeFile(path.join(repoPath, 'untracked.txt'), 'u\n');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n');

  const st = unwrap(await callTool(baseUrl, 'project_status', { project: 'demo' }));
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
});

test('project_status scoped to a worktree returns mergeStatus + diffStat vs base', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  const wt = unwrap(await callTool(baseUrl, 'create_worktree', { project: 'demo' }));
  // Commit a change inside the worktree so it's `ahead` of main.
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

  const st = unwrap(await callTool(baseUrl, 'project_status', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.equal(st.worktree, wt.worktree);
  assert.equal(st.baseBranch, 'main');
  assert.equal(st.mergeStatus.ahead, 1);
  assert.equal(st.mergeStatus.behind, 0);
  assert.match(st.diffStat, /new\.txt/);
  // logLimit:0 disables recentCommits.
  const noLog = unwrap(await callTool(baseUrl, 'project_status', {
    project: 'demo', worktree: wt.worktree, logLimit: 0,
  }));
  assert.equal(noLog.recentCommits, undefined);
  // suppress unused warning
  void repoPath;
});

test('project_status on a non-git project returns isGitRepo:false but still lists files', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const st = unwrap(await callTool(baseUrl, 'project_status', { project: 'a' }));
  assert.equal(st.isGitRepo, false);
  // The CLAUDE.md seeded by createProject should be there.
  assert.ok(st.files.some(f => f.name === 'CLAUDE.md' && f.kind === 'file'));
  assert.equal(st.branch, undefined); // git fields omitted on non-repo
});

test('read_file reads UTF-8 by relative path, rejects traversal, caps at maxBytes', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  await fs.writeFile(path.join(repoPath, 'hello.txt'), 'hello world\n');

  const ok = unwrapFile(await callTool(baseUrl, 'read_file', {
    project: 'demo', relativePath: 'hello.txt',
  }));
  assert.equal(ok.encoding, 'utf8');
  assert.equal(ok.content, 'hello world\n');
  assert.equal(ok.truncated, false);

  // Truncation: maxBytes:5 caps to "hello".
  const cut = unwrapFile(await callTool(baseUrl, 'read_file', {
    project: 'demo', relativePath: 'hello.txt', maxBytes: 5,
  }));
  assert.equal(cut.content, 'hello');
  assert.equal(cut.truncated, true);

  // Traversal: blocked.
  const { body: trav } = await rpc(baseUrl, 'tools/call', {
    name: 'read_file', arguments: { project: 'demo', relativePath: '../../etc/hostname' },
  });
  assert.equal(trav.result.isError, true);
  assert.match(trav.result.content[0].text, /escapes project root/);

  // Absolute path: blocked.
  const { body: abs } = await rpc(baseUrl, 'tools/call', {
    name: 'read_file', arguments: { project: 'demo', relativePath: '/etc/hostname' },
  });
  assert.equal(abs.result.isError, true);
  assert.match(abs.result.content[0].text, /project-relative/);

  // Missing file → isError 404.
  const { body: miss } = await rpc(baseUrl, 'tools/call', {
    name: 'read_file', arguments: { project: 'demo', relativePath: 'nope.txt' },
  });
  assert.equal(miss.result.isError, true);
  assert.match(miss.result.content[0].text, /file not found/);
});

test('read_file scoped to a worktree reads from the worktree root, not the parent', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  const wt = unwrap(await callTool(baseUrl, 'create_worktree', { project: 'demo' }));
  // Same filename on both sides, different content.
  await fs.writeFile(path.join(repoPath, 'shared.txt'), 'parent\n');
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'shared.txt'), 'worktree\n');

  const fromWt = unwrapFile(await callTool(baseUrl, 'read_file', {
    project: 'demo', worktree: wt.worktree, relativePath: 'shared.txt',
  }));
  assert.equal(fromWt.content, 'worktree\n');

  const fromParent = unwrapFile(await callTool(baseUrl, 'read_file', {
    project: 'demo', relativePath: 'shared.txt',
  }));
  assert.equal(fromParent.content, 'parent\n');
});

// ---------- spawn_instance temp/mode defaults ----------
//
// The MCP spawn path defaults temp:true (disposable conducted worker) and
// gets mode plan automatically — create() is policy-light and never couples
// temp to mode. The temp⇒bypassPermissions shortcut lives only at the REST
// route POST /api/instances (covered by instances.test.mjs).

async function spawnIdle(args) {
  const summary = unwrap(await callTool(baseUrl, 'spawn_instance', args));
  await waitFor(() => instForSession(instances, summary.sessionId)?.status === 'idle');
  return summary;
}

test('spawn_instance defaults to temp:true with mode still plan (coupling broken)', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo' });
    assert.equal(summary.temp, true, 'temp defaults to true for MCP spawns');
    assert.equal(summary.mode, 'plan', 'mode stays plan despite temp:true');
    assert.equal(summary.conducted, true);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance explicit temp:false wins, mode still plan', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', temp: false });
    assert.equal(summary.temp, false, 'explicit temp:false overrides the default');
    assert.equal(summary.mode, 'plan');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance explicit mode wins over the temp default', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.temp, true, 'temp still defaults to true');
    assert.equal(summary.mode, 'bypassPermissions', 'explicit mode wins');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// ---------- promote_session ----------

test('promote_session flips temp:false on a temp session', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo' });
    assert.equal(summary.temp, true);
    const promoted = unwrap(await callTool(baseUrl, 'promote_session', { sessionId: summary.sessionId }));
    assert.equal(promoted.temp, false, 'promote flips temp to false');
    assert.equal(instForSession(instances, summary.sessionId).temp, false, 'in-memory flag flipped too');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('promote_session on a non-temp session returns a structured error', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', temp: false });
    const res = await callTool(baseUrl, 'promote_session', { sessionId: summary.sessionId });
    assert.equal(res.isError, true, 'not-temp surfaces as isError, not a crash');
    assert.match(res.content.map(c => c.text).join(''), /not temp/);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('promote_session on an unknown sessionId soft-refuses SESSION_UNKNOWN', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    const res = unwrap(await callTool(baseUrl, 'promote_session', { sessionId: 'no-such-session' }));
    assert.equal(res.ok, false, 'unknown session soft-refuses, not isError/crash');
    assert.equal(res.code, 'SESSION_UNKNOWN');
    assert.equal(res.sessionId, 'no-such-session');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// ---------- spawn_instance model alias resolution ----------

test('spawn_instance: haiku alias resolves to concrete model id', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', model: 'haiku', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-haiku-'),
      `expected concrete haiku model id, got: ${summary.model}`,
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: sonnet alias resolves to concrete model id with context-window suffix', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', model: 'sonnet', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-sonnet-'),
      `expected concrete sonnet model id, got: ${summary.model}`,
    );
    // Default sonnet context window is 1m — verify the [1m] suffix was applied
    assert.ok(
      summary.model.endsWith('[1m]'),
      `expected [1m] suffix on sonnet by default, got: ${summary.model}`,
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: full model id passes through unchanged (backward compat)', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', model: 'claude-haiku-4-5', mode: 'bypassPermissions' });
    assert.equal(summary.model, 'claude-haiku-4-5', 'full model id should pass through canonicalization unchanged');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: omitted model leaves summary.model null', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.model, null, 'omitted model should leave model null (account default)');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// ---------- sessionId-only contract: scrubbed view + strict-live resolution ----------

test('sessionId is the only worker handle: returns carry sessionId, never id/callerInstanceId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  assert.ok(spawn.sessionId, 'spawn returns a sessionId handle');
  assert.equal(spawn.id, undefined, 'spawn return carries no instanceId');
  assert.equal(spawn.callerInstanceId, undefined, 'spawn return carries no callerInstanceId');
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');

  const sent = unwrap(await callTool(baseUrl, 'send_prompt', {
    sessionId: spawn.sessionId, text: 'go', wait: true, waitTimeoutMs: 5000,
  }));
  assert.equal(sent.sessionId, spawn.sessionId);
  assert.equal(sent.id, undefined);

  const list = unwrap(await callTool(baseUrl, 'list_instances', {}));
  assert.ok(list.every(i => i.id === undefined && i.callerInstanceId === undefined),
    'list_instances rows carry no instanceId/callerInstanceId');
  assert.ok(list.some(i => i.sessionId === spawn.sessionId), 'worker is listed by sessionId');
});

test('send_prompt on an unknown sessionId soft-refuses SESSION_UNKNOWN', async () => {
  const res = unwrap(await callTool(baseUrl, 'send_prompt', {
    sessionId: '00000000-dead-dead-dead-000000000000', text: 'hi',
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SESSION_UNKNOWN');
});

test('send_prompt on an exited non-temp session soft-refuses SESSION_NOT_LIVE and never auto-respawns', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    // temp:false → the instance is retained in byId after its subprocess exits.
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions', temp: false }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    const countBefore = instances.idsForSession(spawn.sessionId).length;

    // Kill the subprocess directly (NOT instances.remove) so the non-temp
    // instance stays in byId but loses its proc → strict-live should refuse.
    await instForSession(instances, spawn.sessionId).kill({ graceMs: 200 });
    await waitFor(() => !instForSession(instances, spawn.sessionId)?.proc);

    const res = unwrap(await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'hi' }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_NOT_LIVE');
    assert.equal(res.sessionId, spawn.sessionId);
    assert.match(res.reason, /spawn_instance\(\{resume:/);

    // No auto-respawn: still exactly one (dead) instance for the session.
    assert.equal(instances.idsForSession(spawn.sessionId).length, countBefore);
    assert.equal(instForSession(instances, spawn.sessionId).proc, null);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// ---------- spawn_instance({resume}) worktree re-attachment ----------

test('spawn_instance({resume}) re-attaches the recorded worktree, cwd, and replays prior history', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  try {
    const { encodeCwd } = await import('../src/projects.js');
    await makeRealRepo(projectsRoot, 'demo');

    // Spawn a persistent (non-temp) instance into a fresh worktree.
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', createWorktree: true, temp: false,
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    const sessionId = spawn.sessionId;
    const worktreeName = spawn.worktree.worktreeName;
    const branch = spawn.worktree.branch;
    const worktreePath = spawn.cwd;
    assert.notEqual(worktreePath, path.join(projectsRoot, 'demo'),
      'sanity: the worktree cwd differs from the base project path');

    // Run a real turn so a jsonl actually exists under the WORKTREE's
    // encoded cwd (writeSessionMetadata's last-prompt/permission-mode lines,
    // written fire-and-forget off turn_end — wait for it to land on disk).
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });
    const sessionDir = path.join(claudeProjectsRoot, encodeCwd(worktreePath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    await waitFor(async () => { try { await fs.stat(jsonlPath); return true; } catch { return false; } });

    // Seed a distinguishable "prior conversation" line — what a resumed
    // process must actually find and replay for history to load.
    await fs.appendFile(jsonlPath,
      JSON.stringify({ type: 'user', uuid: 'prior-1', message: { role: 'user', content: 'prior context' } }) + '\n');

    // Simulate the session's process having exited: fully drop the in-memory
    // instance so the next resume goes through InstanceManager.create()'s
    // fresh resolution path rather than respawn() (which would reuse the
    // already-correct in-memory cwd and mask the bug).
    await callTool(baseUrl, 'kill_instance', { sessionId });
    assert.equal(instForSession(instances, sessionId), undefined);

    // The bug scenario: resume with ONLY the sessionId — no project, no
    // worktree. Must "just work": recover the recorded project + worktree.
    const resumeSpawn = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: sessionId }));
    await waitFor(() => instForSession(instances, sessionId)?.status === 'idle');

    assert.equal(resumeSpawn.cwd, worktreePath,
      'resumed instance cwd must match the session\'s recorded worktree path, not the base project');
    assert.ok(resumeSpawn.worktree, 'resumed instance must carry worktree metadata');
    assert.equal(resumeSpawn.worktree.worktreeName, worktreeName);
    assert.equal(resumeSpawn.worktree.branch, branch);
    assert.equal(resumeSpawn.temp, false, 'resume must not silently force a persistent session to temp:true');

    // The whole point: prior history must actually be found and replayed —
    // not merely that the cwd/worktree fields look right. history_replayed
    // only fires when loadPersistedTranscript found the jsonl at the
    // (now correctly resolved) cwd.
    const tx = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId }));
    assert.ok(
      tx.events.some(e => e.kind === 'system' && e.subtype === 'history_replayed'),
      'resumed instance must replay prior persisted history from the correctly-resolved worktree cwd',
    );
    assert.ok(
      tx.events.some(e => e.kind === 'user_echo' && e.text === 'prior context'),
      'the seeded prior conversation line must actually appear in the replayed transcript',
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance({resume}) recovers temp:true from the durable sidecar after a SIGKILL-survived exit', async () => {
  // A graceful kill_instance runs _handleExit → _archiveTempSession(), which
  // intentionally unmarks temp (the session becomes an archived-but-resumable
  // regular session) — that's existing, correct behavior, not this bug. The
  // scenario this test guards is the *other* one tempSessions.js exists for:
  // an orchestrator SIGKILL where _handleExit never runs, so the jsonl and
  // the durable temp sidecar marker both survive with no in-memory record.
  // Resuming that session must recover temp:true from the sidecar — not get
  // silently forced true by a blanket default, and not silently dropped to
  // false either.
  const { markTemp } = await import('../src/tempSessions.js');
  const { encodeCwd } = await import('../src/projects.js');
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  const survivedSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await markTemp(survivedSid);
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'a')));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${survivedSid}.jsonl`),
    '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n');

  const resumeSpawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', resume: survivedSid }));
  assert.equal(resumeSpawn.temp, true, 'temp recovered from the durable sidecar on resume, not forced or dropped');
});
