// A successful spawn_instance whose caller is untitled, live and not in plan
// mode queues SELF_TITLE_NUDGE under the call's toolUseId (the CLI's
// params._meta["claudecode/toolUseId"]); the caller's PostToolUse hook for that
// id takes it as additionalContext. The result itself is the conductor view
// alone. One top-level test per row: the root afterEach shuts instances down
// around subtests.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  api, bootServer, freshProjectsRoot, rmrf, registerLocalProject, waitFor, seedSessionJsonl, instForSession,
} from './helpers.mjs';
import * as handlers from '../src/mcp/handlers.ts';
import { getTitle } from '../src/sessionStore.ts';
import { localPlace } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, projectsRoot } = await freshProjectsRoot());
  const repo = path.join(projectsRoot, 'demo');
  await fs.mkdir(repo, { recursive: true });
  await registerLocalProject('demo', repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'README.md'), '# t\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

const SPAWN_TOOL = 'mcp__code-conductor__spawn_instance';

let nextRpcId = 1;
let nextToolUseId = 1;
const freshToolUseId = () => `toolu_self_${nextToolUseId++}`;
async function callTool(name, args, { caller, toolUseId } = {}) {
  const url = baseUrl + '/mcp' + (caller ? `/${encodeURIComponent(caller)}` : '') + '?format=text';
  const params = { name, arguments: args, ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}) };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

// POSTs a PostToolUse envelope to the instance's hook callback, as the CLI does
// after the tool result, and returns the raw answer.
async function postHook(instanceId, toolUseId, toolName = SPAWN_TOOL, extra = {}) {
  const r = await api(baseUrl, 'POST', `/api/instances/${instanceId}/hook-callback`, {
    session_id: 'sess-test', hook_event_name: 'PostToolUse', tool_name: toolName,
    tool_input: {}, tool_response: [], tool_use_id: toolUseId, ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const NUDGE_ANSWER = () => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: handlers.SELF_TITLE_NUDGE } });

async function spawnIdle(project, mode = 'bypassPermissions') {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp: true, mode });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst.sessionId;
}
// Any identified session may be the caller; a plain project session avoids the conductor playbook gate.
const callerSession = (mode) => spawnIdle('demo', mode);
const callerInstId = (caller) => instForSession(instances, caller).id;
const spawnWith = (caller, toolUseId, args = {}) =>
  callTool('spawn_instance', { project: 'demo', mode: 'bypassPermissions', ...args }, { caller, toolUseId });
// A spawn that must have succeeded with exactly the conductor view.
function assertView(v) {
  assert.notEqual(v.ok, false, `spawn was refused: ${JSON.stringify(v)}`);
  assert.equal(typeof v.sessionId, 'string', `spawn returned no sessionId: ${JSON.stringify(v)}`);
  assert.deepEqual(Object.keys(v).sort(), [...handlers.CONDUCTOR_VIEW_KEYS].sort(), 'the result carries no nudge field');
}
// Spawns as `caller` under a fresh toolUseId and returns the caller's hook answer for it.
async function spawnAndHook(caller, args = {}) {
  const id = freshToolUseId();
  const v = await spawnWith(caller, id, args);
  assertView(v);
  return { v, answer: await postHook(callerInstId(caller), id) };
}

// INVARIANT: an untitled, non-plan, identified caller's successful spawn queues
// exactly SELF_TITLE_NUDGE for that call's hook — additionalContext alone, no
// permission decision — and the result is exactly the conductor view.
test('an untitled caller is nudged through the hook', async () => {
  assert.equal(typeof handlers.SELF_TITLE_NUDGE, 'string');
  const caller = await callerSession();
  const { answer } = await spawnAndHook(caller);
  assert.deepEqual(answer, NUDGE_ANSWER());
});

// INVARIANT: the nudge stops once the caller has a stored title.
test('the nudge stops once the caller is titled', async () => {
  const caller = await callerSession();
  assert.deepEqual((await spawnAndHook(caller)).answer, NUDGE_ANSWER());
  await callTool('set_session_title', { title: 'X' }, { caller });
  assert.deepEqual((await spawnAndHook(caller)).answer, {});
});

// INVARIANT: the caller's CURRENT mode decides, not its spawn-time mode.
test('the caller current mode decides', async () => {
  const caller = await callerSession();
  await callTool('set_mode', { sessionId: caller, mode: 'plan' });
  assert.deepEqual((await spawnAndHook(caller)).answer, {});
  await callTool('set_mode', { sessionId: caller, mode: 'bypassPermissions' });
  assert.deepEqual((await spawnAndHook(caller)).answer, NUDGE_ANSWER());
});

// INVARIANT: a caller in plan mode from birth is never nudged.
test('a plan-mode caller from birth is not nudged', async () => {
  const caller = await callerSession('plan');
  assert.deepEqual((await spawnAndHook(caller)).answer, {});
});

// INVARIANT: an anonymous call gets exactly the conductor view and queues nothing
// on any session (no live caller to queue on).
test('an anonymous spawn queues no nudge', async () => {
  const bystander = await callerSession();
  const id = freshToolUseId();
  assertView(await spawnWith(undefined, id));
  assert.deepEqual(await postHook(callerInstId(bystander), id), {});
});

// INVARIANT: a successful resume is nudged like a fresh spawn.
test('a resume is nudged too', async () => {
  const caller = await callerSession();
  const { v: w } = await spawnAndHook(caller);
  const inst = instForSession(instances, w.sessionId);
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId);
  await callTool('kill_instance', { sessionId: w.sessionId });
  await waitFor(() => !instForSession(instances, w.sessionId)?.proc);
  const id = freshToolUseId();
  const back = await callTool('spawn_instance', { resume: w.sessionId }, { caller, toolUseId: id });
  assertView(back);
  assert.deepEqual(await postHook(callerInstId(caller), id), NUDGE_ANSWER());
});

// INVARIANT: the worker's `title` argument never titles the caller, so the caller is still nudged.
test('a worker title does not stand in for the caller title', async () => {
  const caller = await callerSession();
  const { answer } = await spawnAndHook(caller, { title: 'Worker' });
  assert.deepEqual(answer, NUDGE_ANSWER());
  assert.equal(await getTitle(caller), null);
});

// INVARIANT: a refused spawn keeps its refusal shape and queues nothing.
test('a refusal queues no nudge', async () => {
  const caller = await callerSession();
  const id = freshToolUseId();
  const r = await callTool('spawn_instance', { project: 'demo', resume: 'bogus-session-id' }, { caller, toolUseId: id });
  assert.equal(r.code, 'SESSION_UNKNOWN');
  assert.equal(Object.hasOwn(r, 'titleNudge'), false);
  assert.deepEqual(await postHook(callerInstId(caller), id), {});
});

// INVARIANT: correlation is by toolUseId — two parallel spawns each queue under
// their own id, a hook taken in the opposite order still gets exactly one nudge
// per id, and an id no call carried gets {}.
test('parallel spawns: each hook takes its own call\'s nudge', async () => {
  const caller = await callerSession();
  const [a, b] = [freshToolUseId(), freshToolUseId()];
  const [va, vb] = await Promise.all([spawnWith(caller, a), spawnWith(caller, b)]);
  assertView(va);
  assertView(vb);
  const instId = callerInstId(caller);
  assert.deepEqual(await postHook(instId, b), NUDGE_ANSWER());
  assert.deepEqual(await postHook(instId, a), NUDGE_ANSWER());
  assert.deepEqual(await postHook(instId, 'toolu_never_called'), {});
});

// INVARIANT: a queued nudge is taken once — a second hook for the same id gets {}.
test('a nudge is one-shot per toolUseId', async () => {
  const caller = await callerSession();
  const id = freshToolUseId();
  assertView(await spawnWith(caller, id));
  const instId = callerInstId(caller);
  assert.deepEqual(await postHook(instId, id), NUDGE_ANSWER());
  assert.deepEqual(await postHook(instId, id), {});
});

// INVARIANT: a spawn with no `_meta` toolUseId succeeds with the conductor view
// and queues nothing (there is no id to queue under), yet the gating would have
// nudged: the next identified spawn still is.
test('a spawn without a toolUseId succeeds and queues nothing', async () => {
  const caller = await callerSession();
  assertView(await spawnWith(caller, undefined));
  assert.equal(instForSession(instances, caller)._toolNudges._pending.size, 0, 'nothing pending on the caller');
  assert.deepEqual((await spawnAndHook(caller)).answer, NUDGE_ANSWER(), 'control: the caller still qualifies');
});

// INVARIANT: the hook answers whichever call carried the id — an envelope from a
// subagent (agent_id set) is answered like the main thread's.
test('a subagent envelope is answered for its own call', async () => {
  const caller = await callerSession();
  const id = freshToolUseId();
  assertView(await spawnWith(caller, id));
  assert.deepEqual(await postHook(callerInstId(caller), id, SPAWN_TOOL, { agent_id: 'agent-1' }), NUDGE_ANSWER());
});

// INVARIANT: a nudge left untaken is dropped on the caller's next exit from
// `turn`: queued, then driven through a turn back to idle → the hook gets {}.
test('an untaken nudge is cleared when the caller\'s turn ends', async () => {
  const caller = await callerSession();
  const id = freshToolUseId();
  assertView(await spawnWith(caller, id));
  const inst = instForSession(instances, caller);
  await inst.prompt('go');
  await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'turn_end'));
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(await postHook(inst.id, id), {});
});

// A tools/call in JSON format, returning its structuredContent.
async function callToolJson(name, args, { caller, toolUseId }) {
  const res = await fetch(`${baseUrl}/mcp/${encodeURIComponent(caller)}?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call',
      params: { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } },
    }),
  });
  const body = await res.json();
  assert.ok(body?.result?.structuredContent, `tools/call ${name} returned no structuredContent; body=${JSON.stringify(body)}`);
  return body.result.structuredContent;
}

// INVARIANT: a spawn made inside run_code queues no nudge — not under the outer
// run_code call's toolUseId, nor anywhere else on the caller — even though the
// same untitled, non-plan caller IS nudged for a direct spawn (control, first).
test('a spawn inside run_code queues no nudge; a direct spawn by the same caller does', async () => {
  const caller = await callerSession();
  const instId = callerInstId(caller);
  assert.deepEqual((await spawnAndHook(caller)).answer, NUDGE_ANSWER(), 'control: the caller qualifies');

  const r = await callToolJson('run_code', {
    code: "return (await cc.spawn_instance({ project: 'demo', mode: 'bypassPermissions' })).sessionId",
  }, { caller, toolUseId: 'toolu_run_code_R' });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.error, undefined, JSON.stringify(r));
  const workerSid = JSON.parse(r.result);
  assert.ok(instForSession(instances, workerSid), 'the in-script spawn really started a worker');

  assert.deepEqual(await postHook(instId, 'toolu_run_code_R', 'mcp__code-conductor__run_code'), {});
  assert.equal(instForSession(instances, caller)._toolNudges._pending.size, 0, 'nothing pending on the caller');
});
