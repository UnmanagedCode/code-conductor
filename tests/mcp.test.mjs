// Integration tests for the MCP server mounted at /mcp. Drives the
// transport via fetch — same shape a `claude mcp add --transport http`
// client would use. Reuses the fake-claude subprocess via bootServer().

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, stripMessageBoundaryHeader, driveTurn } from './helpers.mjs';
import { setTierBackend, setTierEnabled, setDebugByDefault, setDefaultSpawnTier, setTierEffort } from '../src/appSettings.ts';

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
// The plain-text tools invert that: their whole result is a rendering, one
// block, no metadata to parse (src/mcp/content.ts textResult).
function text(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  assert.equal(result.content.length, 1, 'a rendered read result is a single block');
  return result.content[0].text;
}
// project_read convenience: merge the body back onto the metadata as `content`.
function unwrapFile(result) {
  const { meta, bodies } = unwrapPayload(result);
  return { ...meta, content: bodies[0] ?? '' };
}
// get_recent_messages convenience: reattach each message's text from its body,
// stripping the boundary header get_recent_messages prefixes when it returns
// more than one message (see stripMessageBoundaryHeader).
function unwrapMessages(result) {
  const { meta, bodies } = unwrapPayload(result);
  return {
    sessionId: meta.sessionId,
    messages: meta.messages.map((m, i) => ({ ...m, text: stripMessageBoundaryHeader(bodies[i] ?? '') })),
  };
}

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

// A repo with NO commit — an unborn HEAD, what project creation now leaves.
async function makeUnbornRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  return repoPath;
}

// Isolate one project's block out of renderProjects' text. Blocks open with
// `▸ <name>  <path>` and run to the next one.
function projectBlock(listText, name) {
  const block = listText.split(/^▸ /m).find(b => b.startsWith(`${name}  `));
  assert.ok(block, `no list_projects block for ${name}`);
  return block;
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
    'adopt_project',
    'answer_question',
    'approve_plan',
    'create_project', 'create_workspace', 'create_worktree',
    'delete_workspace', 'delete_worktree',
    'describe_playbook',
    'get_recent_messages', 'get_transcript',
    'interrupt_turn',
    'kill_instance',
    'list_conductor_conventions',
    'list_playbooks', 'list_project_conventions', 'list_projects', 'list_sessions',
    'list_workspaces', 'list_worktrees',
    'locate_session',
    'merge_worktree',
    'playbook_state',
    'prune_session',
    'project_bash', 'project_diff', 'project_read', 'project_status',
    'reject_plan', 'rename_workspace', 'renew_session', 'respawn_instance',
    'send_prompt', 'set_mode',
    'set_project_workspace',
    'set_idle_timeout',
    'spawn_instance', 'sync_worktree',
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

test('adopt_project registers an out-of-root repo and returns its realpath as JSON', async () => {
  // The repo lives under `home`, not under projectsRoot (`home/project`).
  const repoPath = await makeRealRepo(home, 'outside-repo');
  const res = unwrap(await callTool(baseUrl, 'adopt_project', { name: 'ext', path: repoPath }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.external, true);
  assert.equal(res.path, await fs.realpath(repoPath));

  // Discovery rides the existing text-rendered list_projects, which now marks it.
  const out = text(await callTool(baseUrl, 'list_projects', {}));
  assert.match(out, new RegExp(`^▸ ext {2}${res.path}$`, 'm'));
  assert.match(out, /^ {2}external$/m, 'the external deviant reaches the rendering');
});

test('an adopt_project refusal keeps its machine-readable code through the MCP envelope', async () => {
  // JSON, not textResult: a `code` cannot survive the text-only rendered-read
  // channel, and the conductor is told to act on this one.
  const plain = path.join(home, 'not-a-repo');
  await fs.mkdir(plain, { recursive: true });
  const res = unwrap(await callTool(baseUrl, 'adopt_project', { name: 'nope', path: plain }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TARGET_NOT_A_REPO', JSON.stringify(res));
  assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
});

test('list_projects sees projects created via REST', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'alpha' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'beta' });
  const out = text(await callTool(baseUrl, 'list_projects', {}));
  assert.match(out, /^PROJECTS \(2\)$/m);
  for (const name of ['alpha', 'beta']) {
    assert.match(out, new RegExp(`^▸ ${name} {2}\\S+/${name}$`, 'm'),
      `${name} is listed with its absolute path`);
  }
  assert.ok(out.indexOf('▸ alpha') < out.indexOf('▸ beta'), 'stable name order');
  // Both entries carry the per-project counts, not just the header.
  assert.equal((out.match(/^ {2}live \d+$/gm) ?? []).length, 2);
  // `live` is a count and nothing else — naming the workers is list_sessions'
  // job, and printing ids in both places is what made them look inconsistent.
  assert.equal(out.split('\n').filter(l => /^\s+[0-9a-f-]{36}$/.test(l)).length, 0,
    `no sessionId may appear in a project block:\n${out}`);
  assert.equal((out.match(/^ {2}worktrees \d+$/gm) ?? []).length, 2);
  assert.equal((out.match(/^ {2}sessions \d+ {3}last /gm) ?? []).length, 2);
});

test('spawn_instance + send_prompt + get_transcript round-trip', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // Spawn a fresh instance via MCP.
  const spawnRes = await callTool(baseUrl, 'spawn_instance', {
    project: 'a', mode: 'bypassPermissions',
  });
  const spawn = unwrap(spawnRes);
  assert.ok(spawn.sessionId, 'spawn returns sessionId');
  await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);

  // Send a prompt and drive it to turn_end.
  const promptRes = await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', {
    sessionId: spawn.sessionId, text: 'go',
  }));
  const promptBody = unwrap(promptRes);
  assert.equal(promptBody.sessionId, spawn.sessionId);

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

  // fromSeq filter (inclusive): after the turn, asking fromSeq=lastSeq+1 returns nothing.
  const tail = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId, fromSeq: tx.lastSeq + 1 }));
  assert.equal(tail.events.length, 0);
});

test('get_transcript + get_recent_messages survive a trimmed ring', async () => {
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '20';
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle' && instForSession(instances, spawn.sessionId).sessionId);
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go' }));

    // Force eviction with synthetic history; the newest assistant text
    // must remain reachable for get_recent_messages.
    const inst = instForSession(instances, spawn.sessionId);
    // A DISTINCT blockIdx per delta: the ring folds consecutive
    // same-(msgId, blockIdx) deltas into one slot, so a shared blockIdx would
    // occupy 1 slot and never trim — killing the precondition this test is
    // named for. reconstructMessages concatenates every block of a msgId, so
    // 'the latest words' still surfaces through get_recent_messages below.
    for (let i = 0; i < 100; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'mNew', blockIdx: i, text: i === 99 ? 'the latest words' : `pad ${i} ` });
    }
    inst._emitUi({ kind: 'text_end', msgId: 'mNew', blockIdx: 99 });
    assert.ok(inst.ring.trimmedBefore > 0, 'ring actually trimmed');

    const tx = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId }));
    assert.equal(tx.trimmedBefore, inst.ring.trimmedBefore);
    // fromSeq below trimmedBefore (inclusive): this fixture has no on-disk
    // jsonl (the fake CLI doesn't write one), so disk-fallback finds nothing
    // and the dropped range is served from the ring only, with a
    // history_gap marker at the seam (Step 3 — the unreconstructable evicted
    // span is marked, not silently dropped). (Real disk-backed paging into a
    // dropped range is covered in tests/mcp-recent-disk.test.mjs.)
    const below = unwrap(await callTool(baseUrl, 'get_transcript', { sessionId: spawn.sessionId, fromSeq: 0 }));
    assert.ok(below.events.length > 0);
    assert.equal(below.events[0].kind, 'history_gap', 'the unreplayable evicted span is marked');
    const firstReal = below.events.find(e => typeof e._seq === 'number');
    assert.ok(firstReal && firstReal._seq >= below.trimmedBefore);
    assert.equal(typeof below.hasMore, 'boolean');
    assert.equal(typeof below.nextFrom, 'number');

    const recent = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(recent.messages.length, 1);
    assert.ok(recent.messages[0].text.includes('the latest words'));
  } finally {
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('interrupt_turn: soft (default) reports interrupting (armed) and sends nothing; force aborts the turn', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);

    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' });
    await waitFor(() => instForSession(instances, spawn.sessionId).status === 'idle');

    // Slow turn — stays in `turn` (scenario emits no result for it). Wait for
    // its text block to open so the armed abort has a boundary to wait for.
    await callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two please be slow' });
    const inst = instForSession(instances, spawn.sessionId);
    await waitFor(() => inst.status === 'turn' && !inst._quiescence.empty);

    // Soft (force omitted): armed, turn continues, nothing sent to the CLI yet.
    const soft = unwrap(await callTool(baseUrl, 'interrupt_turn', { sessionId: spawn.sessionId }));
    assert.equal(soft.status, 'turn');
    assert.equal(soft.interrupting, true, 'interrupting:true means ARMED');
    assert.equal(inst.interrupting, true);
    assert.equal(inst._interruptFired, false, 'no control_request while a block is open');

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
  const { encodeCwd } = await import('../src/projects.ts');
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // Conducted session: spawned via the MCP spawn_instance tool. MCP spawns
  // default to temp:true with no MCP knob to override it, so this test is
  // about list annotation (MCP conducted:true vs HTTP false), not temp
  // durability — promote in-process afterward. A non-temp session is the
  // simplest fixture for that: it survives kill_instance without its jsonl
  // being wiped.
  const cond = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  assert.equal(cond.conducted, true, 'MCP-spawned summary carries conducted:true');
  const condInst = instForSession(instances, cond.sessionId);
  await waitFor(() => condInst.status === 'idle' && condInst.sessionId);
  await condInst.promoteToNormal();
  // Drive a turn so the durable marker is persisted on turn_end.
  await driveTurn(instances, cond.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: cond.sessionId, text: 'go' }));
  // BOTH ids are needed here, and keeping them apart is the point: a LIVE row is
  // rendered from the instance (public id) while an inactive row and the durable
  // sidecar both come off disk (backing id).
  const condSid = condInst.sessionId;
  const condBacking = condInst.backingSessionId;

  // Non-conducted session: spawned via the browser / HTTP path.
  const httpRes = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
  assert.equal(httpRes.body.conducted, false, 'HTTP-spawned summary carries conducted:false');
  const httpInst = instances.get(httpRes.body.id);
  await waitFor(() => httpInst.status === 'idle' && httpInst.sessionId);
  const httpSid = httpInst.sessionId;
  const httpBacking = httpInst.backingSessionId;

  // The durable marker lands in the central-store sidecar.
  const sidecar = path.join(projectsRoot, '.code-conductor', 'conducted-sessions.json');
  await waitFor(async () => {
    try { return JSON.parse(await fs.readFile(sidecar, 'utf8')).sessions?.includes(condBacking); }
    catch { return false; }
  });

  // Materialize both jsonls (the fake CLI doesn't write them).
  const dir = path.join(claudeProjectsRoot, encodeCwd(condInst.cwd));
  await fs.mkdir(dir, { recursive: true });
  for (const sid of [condBacking, httpBacking]) {
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n');
  }

  // A session renders either as a multi-line LIVE block or as one inactive
  // row, so pull the whole entry rather than assuming a single line.
  const entryFor = (sid, s) => {
    const lines = s.split('\n').map(l => l.trim());
    const at = lines.findIndex(l => l === `${sid}` || l.startsWith(`${sid} `) || l.endsWith(`LIVE ${sid}`));
    if (at < 0) return null;
    const rest = lines.slice(at + 1);
    const end = rest.findIndex(l => l === '');
    return [lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
  };
  const out = text(await callTool(baseUrl, 'list_sessions', { project: 'a' }));
  assert.ok(entryFor(condSid, out), `conducted session is returned (separation, not a filter):\n${out}`);
  assert.ok(entryFor(httpSid, out), 'non-conducted session is returned');
  assert.match(entryFor(condSid, out), /\bconducted\b/, 'MCP session marked conducted');
  assert.doesNotMatch(entryFor(httpSid, out), /\bconducted\b/, 'HTTP session carries no marker');

  // The marker is durable: it survives the live instance going away
  // (simulating restart/resume recognition) because it reads from the
  // on-disk sidecar, not the in-memory instance.
  await callTool(baseUrl, 'kill_instance', { sessionId: cond.sessionId });
  const out2 = text(await callTool(baseUrl, 'list_sessions', { project: 'a' }));
  // Now an INACTIVE row off its own transcript. It still reports the session's
  // PUBLIC id (that transcript is `current`), while the durable marker it is
  // flagged from is looked up by filename — the two ids doing their own jobs.
  assert.match(entryFor(condSid, out2) ?? '', /\bconducted\b/,
    'conducted marker persists after the instance exits');
});

test('temp conducted session persists the conducted marker and recovers it on resume', async () => {
  // Regression: a default MCP-spawned worker is BOTH temp:true and
  // conducted:true. The durable conducted marker must be written DESPITE temp
  // (i.e. before the `if (this.temp) return;` early-return in
  // _writeSessionMetadata) — otherwise an orchestrator SIGKILL (where the
  // on-exit _archiveTempSession never runs, so the jsonl + sidecars survive)
  // leaves nothing for create() to recover and the session resumes with
  // conducted falsy. This exercises both halves: the durable WRITE (a live
  // temp+conducted turn) and the RECOVERY (create({resume}) reading sidecars).
  const { isConducted, markConducted } = await import('../src/conductedSessions.ts');
  const { isTemp, markTemp } = await import('../src/tempSessions.ts');
  const { encodeCwd } = await import('../src/projects.ts');
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });

  // --- WRITE side (the fix) ---
  // Spawn with MCP defaults: temp:true + conducted:true (the buggy combo).
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  assert.equal(spawn.conducted, true, 'MCP spawn defaults to conducted:true');
  assert.equal(spawn.temp, true, 'MCP spawn defaults to temp:true');
  const inst = instForSession(instances, spawn.sessionId);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const sid = inst.backingSessionId;   // both sidecars are transcript-keyed

  // Drive a turn so _writeSessionMetadata() runs. Both durable markers must
  // land even though the session is temp. (Before the fix, isConducted(sid)
  // would be false here — markConducted sat after the temp early-return.)
  await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'go' }));
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
  // list_sessions takes no required argument any more (omitting `project`
  // means "everything"), so the machinery is pinned on a tool that does.
  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'locate_session', arguments: {},
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /missing required argument: sessionId/);
});

test('list_sessions narrowed to a worktree needs the project it belongs to', async () => {
  const out = JSON.parse(text(await callTool(baseUrl, 'list_sessions', { worktree: 'demo_worktree_ab12' })));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROJECT_REQUIRED');
});

test('locate_session finds an on-disk session by id, 404s when missing', async () => {
  const { encodeCwd } = await import('../src/projects.ts');
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

  const wts = text(await callTool(baseUrl, 'list_worktrees', { project: 'demo' }));
  assert.match(wts, /^WORKTREES \(1\) — demo$/m);
  assert.ok(wts.includes(createRes.worktree), 'the new worktree is listed');

  const del = unwrap(await callTool(baseUrl, 'delete_worktree', {
    project: 'demo', worktree: createRes.worktree,
  }));
  assert.equal(del.worktree, createRes.worktree);
  assert.equal(text(await callTool(baseUrl, 'list_worktrees', { project: 'demo' })),
    'WORKTREES (none)');
});

test('merge_worktree refuses with friendly reason when the worktree is behind', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  // Spawn an instance into a fresh worktree.
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const wtName = instForSession(instances, spawn.sessionId).worktree.worktreeName;

  // Move the parent branch forward so the worktree is now "behind".
  await fs.writeFile(path.join(repoPath, 'extra.txt'), 'after\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'second');

  const mergeRes = unwrap(await callTool(baseUrl, 'merge_worktree', { project: 'demo', worktree: wtName }));
  assert.equal(mergeRes.ok, false);
  assert.equal(mergeRes.code, 'WORKTREE_BEHIND');
  assert.match(mergeRes.reason, /behind .* click Sync first|call sync_worktree first/i);
});

test('merge_worktree merges by {project, worktree} after the instance is gone', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  // Create a worktree, attach an instance, kill the instance — the
  // worktree itself stays around.
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const wt = instForSession(instances, spawn.sessionId).worktree;
  // Commit something in the worktree so it's ahead of base — an empty
  // merge (ahead:0) is refused with NOTHING_TO_MERGE (see below).
  await fs.writeFile(path.join(wt.worktreePath, 'agent.txt'), 'agent work\n');
  await git(wt.worktreePath, 'config', 'user.email', 'agent@example.com');
  await git(wt.worktreePath, 'config', 'user.name', 'agent');
  await git(wt.worktreePath, 'config', 'commit.gpgsign', 'false');
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'agent work');
  await callTool(baseUrl, 'kill_instance', { sessionId: spawn.sessionId });
  assert.equal(instForSession(instances, spawn.sessionId), undefined);

  const mergeRes = unwrap(await callTool(baseUrl, 'merge_worktree', {
    project: 'demo', worktree: wt.worktreeName,
  }));
  assert.equal(mergeRes.ok, true, `merge failed: ${mergeRes.reason}`);
  assert.ok(mergeRes.newSha, 'merge produced a new HEAD sha');
});

test('merge_worktree refuses NOTHING_TO_MERGE when the worktree has no commits ahead of base', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const wtName = instForSession(instances, spawn.sessionId).worktree.worktreeName;

  const mergeRes = unwrap(await callTool(baseUrl, 'merge_worktree', { project: 'demo', worktree: wtName }));
  assert.equal(mergeRes.ok, false);
  assert.equal(mergeRes.code, 'NOTHING_TO_MERGE');
});

test('merge_worktree refuses WORKTREE_DIRTY when the worktree has uncommitted changes, allowDirty overrides', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true,
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId).sessionId);
  const wt = instForSession(instances, spawn.sessionId).worktree;

  await git(wt.worktreePath, 'config', 'user.email', 'agent@example.com');
  await git(wt.worktreePath, 'config', 'user.name', 'agent');
  await git(wt.worktreePath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(wt.worktreePath, 'agent.txt'), 'agent work\n');
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'agent work');
  // Additional uncommitted file dirties the tree after the commit.
  await fs.writeFile(path.join(wt.worktreePath, 'scratch.txt'), 'not committed\n');

  const refused = unwrap(await callTool(baseUrl, 'merge_worktree', {
    project: 'demo', worktree: wt.worktreeName,
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'WORKTREE_DIRTY');

  const allowed = unwrap(await callTool(baseUrl, 'merge_worktree', {
    project: 'demo', worktree: wt.worktreeName, allowDirty: true,
  }));
  assert.equal(allowed.ok, true, `merge failed: ${allowed.reason}`);
});

// merge_worktree names the WORKTREE only — there is no {sessionId} form, so
// project+worktree are schema-required and a sessionId is an unknown argument.
test('merge_worktree requires project + worktree and rejects a sessionId', async () => {
  const missing = await rpc(baseUrl, 'tools/call', {
    name: 'merge_worktree', arguments: {},
  });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /missing required argument: project/);

  const withSession = await rpc(baseUrl, 'tools/call', {
    name: 'merge_worktree', arguments: { project: 'demo', worktree: 'wt', sessionId: 'abc' },
  });
  assert.equal(withSession.body.result.isError, true);
  assert.match(withSession.body.result.content[0].text, /unexpected argument 'sessionId'/);
});

test('create_project creates the directory, seeds CLAUDE.md, and inits git', async () => {
  const plain = unwrap(await callTool(baseUrl, 'create_project', { name: 'plain' }));
  assert.equal(plain.name, 'plain');
  const claudeMd = await fs.readFile(path.join(projectsRoot, 'plain', 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd, '@CONVENTIONS.md\n');
  // The repo is created with no git-related argument passed — init is not opt-in.
  const gitStat = await fs.stat(path.join(projectsRoot, 'plain', '.git'));
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
  await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' }));
  const first = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
  assert.equal(first.messages[0].text, 'First ');
  assert.equal(first.messages[0].hasToolUse, true);
  assert.ok(first.messages[0].blocks.some(b => b.type === 'tool_use' && b.name === 'Bash'));
  assert.ok(first.messages[0].blocks.every(b => b.type !== 'text'), 'tool-call message blocks has no text entries');

  // Second turn: just text "Second!" — should now be the latest.
  await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two' }));
  const second = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
  assert.equal(second.messages[0].text, 'Second!');
  assert.notEqual(second.messages[0].msgId, first.messages[0].msgId);
  assert.ok(!Object.hasOwn(second.messages[0], 'blocks'), 'pure-text message omits blocks field');

  // count:2 returns both turns, oldest-first.
  const bothRaw = await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId, count: 2 });
  const both = unwrapMessages(bothRaw);
  assert.equal(both.messages.length, 2);
  assert.equal(both.messages[0].text, 'First ');
  assert.equal(both.messages[0].hasToolUse, true);
  assert.equal(both.messages[1].text, 'Second!');
  // Raw (unstripped) bodies carry the boundary line once >1 message is returned.
  const bothRawBodies = bothRaw.content.slice(1).map(c => c.text);
  assert.match(bothRawBodies[0], /^--- message 1\/2 · .+ · 6 chars ---\nFirst /);
  assert.match(bothRawBodies[1], /^--- message 2\/2 · .+ · 7 chars ---\nSecond!$/);

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
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' }));
    const afterToolOnly = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(afterToolOnly.messages.length, 0);

    // Turn 2: text "Hello".
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'two' }));
    // Turn 3: tool-only.
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'three' }));

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
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'one' }));

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

    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'plan this' }));

    const after = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(after.messages.length, 1, 'plan-bearing message returned by default');
    assert.equal(after.messages[0].text, '--- plan ---\nStep 1\nStep 2', 'plan rendered into the body, fenced');
    assert.equal(after.messages[0].hasPlan, true, 'hasPlan marker populated');
    assert.equal(after.messages[0].plan, undefined, 'plan content no longer duplicated in metadata');
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

    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'ask me something' }));

    const after = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(after.messages.length, 1, 'question-bearing message returned by default');
    assert.equal(
      after.messages[0].text,
      '--- questions ---\n1. Which approach? (multiSelect: false) · header: Approach\n   - Option A: Fast\n   - Option B: Safe',
      'questions rendered into the body, index-numbered with options and multiSelect',
    );
    assert.equal(after.messages[0].questionCount, 1, 'questionCount marker populated');
    assert.equal(after.messages[0].questions, undefined, 'questions content no longer duplicated in metadata');
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
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'plan this' }));
    const result = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(result.messages.length, 1, 'plan-bearing message returned (reconciled path)');
    assert.equal(result.messages[0].text, '--- plan ---\nStep 1\nStep 2', 'plan rendered into the body (reconciled path)');
    assert.equal(result.messages[0].hasPlan, true, 'hasPlan marker populated (reconciled path)');
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
    await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId: spawn.sessionId, text: 'ask me' }));
    const result = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId: spawn.sessionId }));
    assert.equal(result.messages.length, 1, 'question-bearing message returned (reconciled path)');
    assert.equal(
      result.messages[0].text,
      '--- questions ---\n1. Which approach? (multiSelect: false) · header: Approach\n   - A: Fast\n   - B: Safe',
      'questions rendered into the body (reconciled path)',
    );
    assert.equal(result.messages[0].questionCount, 1, 'questionCount marker populated (reconciled path)');
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

  const st = text(await callTool(baseUrl, 'project_status', { project: 'demo' }));
  assert.match(st, /^demo$/m, 'no worktree suffix on a project-root status');
  assert.match(st, /^branch main$/m);
  assert.match(st, /^HEAD [0-9a-f]{40} initial$/m);
  assert.match(st, /^COMMITS \(1\)$/m);
  assert.match(st, /^ {2}[0-9a-f]{7} initial$/m);
  const section = (name) => {
    const at = st.indexOf(`${name} (`);
    assert.ok(at >= 0, `${name} section missing from:\n${st}`);
    return st.slice(at).split('\n\n')[0];
  };
  const files = section('FILES');
  assert.ok(files.includes('README.md') && files.includes('untracked.txt'));
  // Dirty lines should include both the modified and untracked files.
  const dirty = section('DIRTY');
  assert.ok(dirty.includes('README.md'), `dirty missing README.md:\n${dirty}`);
  assert.ok(dirty.includes('untracked.txt'), `dirty missing untracked.txt:\n${dirty}`);
});

test('project_status scoped to a worktree returns mergeStatus + diffStat vs base', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  const wt = unwrap(await callTool(baseUrl, 'create_worktree', { project: 'demo' }));
  // Commit a change inside the worktree so it's `ahead` of main.
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

  const st = text(await callTool(baseUrl, 'project_status', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.match(st, new RegExp(`^demo {2}worktree ${wt.worktree}$`, 'm'));
  assert.match(st, /^base main@[0-9a-f]{12} {3}ahead 1 {2}behind 0$/m);
  assert.match(st, /^DIFFSTAT \(vs main\)$/m);
  assert.match(st, /new\.txt/);
  // logLimit:0 disables recentCommits.
  const noLog = text(await callTool(baseUrl, 'project_status', {
    project: 'demo', worktree: wt.worktree, logLimit: 0,
  }));
  assert.ok(!noLog.includes('COMMITS'), 'logLimit:0 omits the commits section entirely');
  // suppress unused warning
  void repoPath;
});

test('project_status on a non-git project returns isGitRepo:false but still lists files', async () => {
  // Creation always inits a repo now, so reach the non-repo state with a bare
  // mkdir + the CLAUDE.md the file-listing assertion below needs.
  await fs.mkdir(path.join(projectsRoot, 'a'), { recursive: true });
  await fs.writeFile(path.join(projectsRoot, 'a', 'CLAUDE.md'), '@CONVENTIONS.md\n');
  const st = text(await callTool(baseUrl, 'project_status', { project: 'a' }));
  assert.match(st, /^! not a git repo$/m);
  // The CLAUDE.md the fixture above wrote should be there, and as a file (no
  // trailing slash — that is how the rendering encodes files[].kind).
  assert.match(st, /(^| )CLAUDE\.md( |$)/m);
  // git sections omitted on a non-repo
  for (const absent of ['branch ', 'HEAD ', 'DIRTY', 'COMMITS']) {
    assert.ok(!st.includes(absent), `non-repo status must not render ${absent}`);
  }
});

test('list_projects flags a repo with no commits and stays silent on a normal one', async () => {
  await makeUnbornRepo(projectsRoot, 'fresh');
  await makeRealRepo(projectsRoot, 'demo');
  const list = text(await callTool(baseUrl, 'list_projects', {}));
  assert.match(projectBlock(list, 'fresh'), /! no commits yet/);
  assert.ok(!/! no commits yet/.test(projectBlock(list, 'demo')),
    'a repo with commits must render exactly as before');
});

test('list_projects never reports a non-repo project as having an unborn HEAD', async () => {
  // hasUnbornHead() cannot tell "no repo" from "no commits" — `rev-parse
  // --verify --quiet HEAD` exits non-zero for both — so the isGitRepo guard in
  // the handler is the ONLY thing keeping both deviant lines off a bare-mkdir
  // project's block. Without it a non-repo renders as a repo that just needs a
  // commit, which is the opposite of the truth.
  await fs.mkdir(path.join(projectsRoot, 'plain'), { recursive: true });
  await makeUnbornRepo(projectsRoot, 'fresh');
  const list = text(await callTool(baseUrl, 'list_projects', {}));
  const plain = projectBlock(list, 'plain');
  assert.match(plain, /! not a git repo/);
  assert.ok(!/! no commits yet/.test(plain),
    `a non-repo must not also claim an unborn HEAD: ${plain}`);
  // The unborn project in the same render proves the flag is live, so the
  // assertion above is a real guard and not a payload that is off everywhere.
  assert.match(projectBlock(list, 'fresh'), /! no commits yet/);
});

test('project_status on an unborn HEAD says no commits yet instead of a blank HEAD', async () => {
  await makeUnbornRepo(projectsRoot, 'fresh');
  const st = text(await callTool(baseUrl, 'project_status', { project: 'fresh' }));
  assert.ok(!st.includes('! not a git repo'), 'an unborn repo is still a git repo');
  assert.match(st, /^branch main$/m);
  assert.match(st, /^HEAD — no commits yet$/m);
  assert.ok(!/^HEAD — —$/m.test(st), 'must not fall through to the blank-HEAD rendering');
});

test('project_read reads UTF-8 by relative path, rejects traversal, caps at maxBytes', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  await fs.writeFile(path.join(repoPath, 'hello.txt'), 'hello world\n');

  const ok = unwrapFile(await callTool(baseUrl, 'project_read', {
    project: 'demo', relativePath: 'hello.txt',
  }));
  assert.equal(ok.encoding, 'utf8');
  assert.equal(ok.content, 'hello world\n');
  assert.equal(ok.truncated, false);

  // Truncation: maxBytes:5 caps to "hello".
  const cut = unwrapFile(await callTool(baseUrl, 'project_read', {
    project: 'demo', relativePath: 'hello.txt', maxBytes: 5,
  }));
  assert.equal(cut.content, 'hello');
  assert.equal(cut.truncated, true);

  // Traversal: blocked.
  const { body: trav } = await rpc(baseUrl, 'tools/call', {
    name: 'project_read', arguments: { project: 'demo', relativePath: '../../etc/hostname' },
  });
  assert.equal(trav.result.isError, true);
  assert.match(trav.result.content[0].text, /escapes project root/);

  // Absolute path: blocked.
  const { body: abs } = await rpc(baseUrl, 'tools/call', {
    name: 'project_read', arguments: { project: 'demo', relativePath: '/etc/hostname' },
  });
  assert.equal(abs.result.isError, true);
  assert.match(abs.result.content[0].text, /project-relative/);

  // Missing file → isError 404.
  const { body: miss } = await rpc(baseUrl, 'tools/call', {
    name: 'project_read', arguments: { project: 'demo', relativePath: 'nope.txt' },
  });
  assert.equal(miss.result.isError, true);
  assert.match(miss.result.content[0].text, /file not found/);
});

test('project_read scoped to a worktree reads from the worktree root, not the parent', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  const wt = unwrap(await callTool(baseUrl, 'create_worktree', { project: 'demo' }));
  // Same filename on both sides, different content.
  await fs.writeFile(path.join(repoPath, 'shared.txt'), 'parent\n');
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'shared.txt'), 'worktree\n');

  const fromWt = unwrapFile(await callTool(baseUrl, 'project_read', {
    project: 'demo', worktree: wt.worktree, relativePath: 'shared.txt',
  }));
  assert.equal(fromWt.content, 'worktree\n');

  const fromParent = unwrapFile(await callTool(baseUrl, 'project_read', {
    project: 'demo', relativePath: 'shared.txt',
  }));
  assert.equal(fromParent.content, 'parent\n');
});

// ---------- spawn_instance temp/mode defaults ----------
//
// The MCP spawn path defaults temp:true (archived-on-exit conducted worker,
// transcript retained and resumable) and gets mode plan automatically —
// create() is policy-light and never couples temp to mode. The
// temp⇒bypassPermissions shortcut lives only at the REST route
// POST /api/instances (covered by instances.test.mjs).

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

test('spawn_instance explicit debug:false overrides an ON debugByDefault default (MCP path)', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await setDebugByDefault(true);
    const summary = await spawnIdle({ project: 'demo', debug: false });
    assert.equal(summary.debug, false, 'explicit debug:false overrides the ON default on the MCP spawn path too');
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

test('spawn_instance: sonnet alias resolves to the family default at its native window', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', model: 'sonnet', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-sonnet-'),
      `expected concrete sonnet model id, got: ${summary.model}`,
    );
    // The sonnet family default is Sonnet 5, which is natively 1M and so launches
    // BARE — the `[1m]` tag exists only for Sonnet 4.x, which ships separate
    // 200k/1M builds. Capacity is reported as a number, not inferred from a suffix.
    assert.equal(summary.model, 'claude-sonnet-5');
    assert.equal(summary.contextWindowTokens, 1_000_000);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: full model id passes through unchanged (deliberate Settings override)', async () => {
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

// ---------- spawn_instance: an omitted model resolves the DEFAULT SPAWN TIER ----------
//
// A bare `claude` with no --model runs on whatever the ACCOUNT resolves as its
// default — not cc's choice to make, and non-deterministic per worker. So an
// omitted `model` on a FRESH spawn resolves defaultSpawnBinding() = the tier
// selected in Settings → Models, through its binding. Every test here rebinds
// that tier to a model distinguishable from DEFAULT_TIER_BACKEND's `powerful`
// entry, so a pass can't be a coincidence between the default tier's model and
// whatever the fake CLI would otherwise report.

test('spawn_instance: omitted model resolves the default spawn tier binding', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await setDefaultSpawnTier('balanced');
    await setTierBackend('balanced', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.model, 'claude-haiku-4-5', 'omitted model resolves the default tier binding, never null');
    assert.equal(summary.backend, 'claude');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// summary.model is server bookkeeping; this is the only assertion that the flag
// actually reaches the CLI, so a fix that populates the summary without emitting
// --model dies here.
test('spawn_instance: omitted model emits --model on the launched argv', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  const argvPath = path.join(home, 'argv-mcp-nomodel.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
  try {
    await setDefaultSpawnTier('balanced');
    await setTierBackend('balanced', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    await waitFor(async () => { try { await fs.stat(argvPath); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
    const i = argv.indexOf('--model');
    assert.ok(i >= 0, `--model must reach the CLI; argv was: ${argv.join(' ')}`);
    assert.equal(argv[i + 1], 'claude-haiku-4-5');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// Kills the mutant that hardcodes DEFAULT_SPAWN_TIER / DEFAULT_TIER_BACKEND
// instead of reading models.defaultTier: `fast` is not the shipped default tier.
test('spawn_instance: omitted model follows models.defaultTier, not a hardcoded tier', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await setDefaultSpawnTier('fast');
    await setTierBackend('fast', { backend: 'claude', model: 'claude-sonnet-5' });
    await setTierBackend('powerful', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.model, 'claude-sonnet-5', 'the tier named by models.defaultTier decides');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// Pins the FIRST fallback rung (getDefaultSpawnTier → DEFAULT_SPAWN_TIER) while
// still proving the stored BINDING is read rather than DEFAULT_TIER_BACKEND.
test('spawn_instance: omitted model with models.defaultTier unset uses the powerful tier BINDING', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    // defaultTier deliberately never set in this fresh store.
    await setTierBackend('powerful', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.model, 'claude-haiku-4-5');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// The default tier's row governs BOTH of its axes: spawning on it means its
// stored default effort applies too (resolveSpawnEffort sees the resolved tier).
// Deliberate side effect of setting `tier` on the default-resolution path.
test('spawn_instance: omitted model also picks up the default tier\'s default effort', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await setDefaultSpawnTier('balanced');
    await setTierBackend('balanced', { backend: 'claude', model: 'claude-haiku-4-5' });
    await setTierEffort('balanced', 'low'); // distinguishable from DEFAULT_EFFORT ('high')
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', mode: 'bypassPermissions' });
    assert.equal(summary.model, 'claude-haiku-4-5');
    assert.equal(summary.effort, 'low', 'the resolved default tier\'s stored effort governs');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// Regression guard (passes before the fix too): the new default branch is gated
// on !resume, so a resume still recovers the model it last ran from the jsonl.
// An ungated branch — the most likely wrong implementation — hijacks this.
// instances.test.mjs covers the same invariant over REST; nothing covered MCP.
test('spawn_instance: a resume with no model recovers the jsonl model, not the default tier', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const { encodeCwd } = await import('../src/projects.ts');
  try {
    await setDefaultSpawnTier('fast');
    await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-mcp-model' });
    const projectPath = path.join(projectsRoot, 'resume-mcp-model');
    const sid = '77777777-aaaa-bbbb-cccc-dddddddddddd';
    const sessionDir = path.join(claudeProjectsRoot, encodeCwd(projectPath));
    await fs.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', message: {
        id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hello' }],
      } },
    ];
    await fs.writeFile(path.join(sessionDir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const summary = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'resume-mcp-model', resume: sid, // intentionally no `model`
    }));
    await waitFor(() => instForSession(instances, summary.sessionId)?.status === 'idle');
    const inst = instForSession(instances, summary.sessionId);
    assert.equal(inst.model, 'claude-sonnet-4-6[1m]', 'the jsonl model wins over the default tier on a resume');
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

// ---------- spawn_instance capability-tier resolution ----------

test('spawn_instance: fast tier resolves through its bound backend (haiku) to a concrete model id', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const summary = await spawnIdle({ project: 'demo', model: 'fast', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-haiku-'),
      `expected concrete haiku model id via the fast tier, got: ${summary.model}`,
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: rebinding a tier changes what that tier resolves to', async () => {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await setTierBackend('powerful', { backend: 'claude', model: 'claude-fable-5' }); // was opus by default
    const summary = await spawnIdle({ project: 'demo', model: 'powerful', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-fable-'),
      `expected the rebound backend (fable) to resolve, got: ${summary.model}`,
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: legacy family alias pins to that literal backend even after its default tier is rebound', async () => {
  // Regression test for the chosen backward-compat strategy: a legacy
  // "sonnet" caller must keep getting Sonnet, unaffected by rebinding the
  // 'balanced' tier (which defaults to sonnet) to a different backend.
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await setTierBackend('balanced', { backend: 'claude', model: 'claude-opus-4-8' }); // rebind the tier that used to default to sonnet
    const summary = await spawnIdle({ project: 'demo', model: 'sonnet', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-sonnet-'),
      `legacy "sonnet" alias must still resolve to Sonnet regardless of tier rebinding, got: ${summary.model}`,
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
});

test('spawn_instance: legacy family alias resolves even when every tier bound to it is disabled', async () => {
  // "Disabled families are still resolved when passed explicitly" carries
  // over unchanged to tiers — a legacy alias bypasses tier enablement too.
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    await setTierEnabled('frontier', false);
    const summary = await spawnIdle({ project: 'demo', model: 'fable', mode: 'bypassPermissions' });
    assert.ok(
      typeof summary.model === 'string' && summary.model.startsWith('claude-fable-'),
      `expected fable to resolve despite the frontier tier being disabled, got: ${summary.model}`,
    );
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

  const sent = unwrap(await driveTurn(instances, spawn.sessionId, () => callTool(baseUrl, 'send_prompt', {
    sessionId: spawn.sessionId, text: 'go',
  })));
  assert.equal(sent.sessionId, spawn.sessionId);
  assert.equal(sent.id, undefined);

  const out = text(await callTool(baseUrl, 'list_sessions', {}));
  assert.ok(out.includes(spawn.sessionId), 'worker is listed by sessionId');
  assert.ok(!out.includes(instForSession(instances, spawn.sessionId).id),
    'the per-process instanceId never reaches this surface');
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
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    // Promote so the instance is retained in byId after its subprocess exits.
    await instForSession(instances, spawn.sessionId).promoteToNormal();
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
    const { encodeCwd } = await import('../src/projects.ts');
    await makeRealRepo(projectsRoot, 'demo');

    // Spawn into a fresh worktree, then promote to a persistent (non-temp) session.
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', {
      project: 'demo', mode: 'bypassPermissions', createWorktree: true,
    }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    await instForSession(instances, spawn.sessionId).promoteToNormal();
    const sessionId = spawn.sessionId;
    const worktreeName = spawn.worktree.worktreeName;
    const branch = spawn.worktree.branch;
    const worktreePath = spawn.cwd;
    assert.notEqual(worktreePath, path.join(projectsRoot, 'demo'),
      'sanity: the worktree cwd differs from the base project path');

    // Run a real turn so a jsonl actually exists under the WORKTREE's
    // encoded cwd (writeSessionMetadata's last-prompt/permission-mode lines,
    // written fire-and-forget off turn_end — wait for it to land on disk).
    await driveTurn(instances, sessionId, () => callTool(baseUrl, 'send_prompt', { sessionId, text: 'go' }));
    const sessionDir = path.join(claudeProjectsRoot, encodeCwd(worktreePath));
    // The transcript is named by the BACKING id; `sessionId` above is the public
    // handle the resume below deliberately uses instead.
    const backingId = instForSession(instances, sessionId).backingSessionId;
    const jsonlPath = path.join(sessionDir, `${backingId}.jsonl`);
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
  // scenario this test guards is the *other* one tempSessions.ts exists for:
  // an orchestrator SIGKILL where _handleExit never runs, so the jsonl and
  // the durable temp sidecar marker both survive with no in-memory record.
  // Resuming that session must recover temp:true from the sidecar — not get
  // silently forced true by a blanket default, and not silently dropped to
  // false either.
  const { markTemp } = await import('../src/tempSessions.ts');
  const { encodeCwd } = await import('../src/projects.ts');
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
