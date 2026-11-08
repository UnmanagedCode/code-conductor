// A successful spawn_instance whose caller is untitled, live and not in plan
// mode carries `titleNudge` (SELF_TITLE_NUDGE). One top-level test per row: the
// root afterEach shuts instances down around subtests.
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

let nextRpcId = 1;
async function callTool(name, args, { caller } = {}) {
  const url = baseUrl + '/mcp' + (caller ? `/${encodeURIComponent(caller)}` : '') + '?format=text';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

async function spawnIdle(project, mode = 'bypassPermissions') {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp: true, mode });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst.sessionId;
}
// Any identified session may be the caller; a plain project session avoids the conductor playbook gate.
const callerSession = (mode) => spawnIdle('demo', mode);
const spawn = (caller, args = {}) => callTool('spawn_instance', { project: 'demo', mode: 'bypassPermissions', ...args }, { caller });
const isNudge = (v) => { assert.equal(typeof handlers.SELF_TITLE_NUDGE, 'string'); assert.equal(v.titleNudge, handlers.SELF_TITLE_NUDGE); };
// A negative row must come from a spawn that succeeded, not a refusal.
const hasNudge = (v) => {
  assert.notEqual(v.ok, false, `spawn was refused: ${JSON.stringify(v)}`);
  assert.equal(typeof v.sessionId, 'string', `spawn returned no sessionId: ${JSON.stringify(v)}`);
  return Object.hasOwn(v, 'titleNudge');
};

// INVARIANT: an untitled, non-plan, identified caller's successful spawn carries exactly SELF_TITLE_NUDGE beside the conductor view.
test('an untitled caller is nudged', async () => {
  const caller = await callerSession();
  const v = await spawn(caller);
  isNudge(v);
  assert.deepEqual(Object.keys(v).sort(), [...handlers.CONDUCTOR_VIEW_KEYS, 'titleNudge'].sort());
});

// INVARIANT: the nudge stops once the caller has a stored title.
test('the nudge stops once the caller is titled', async () => {
  const caller = await callerSession();
  assert.equal(hasNudge(await spawn(caller)), true);
  await callTool('set_session_title', { title: 'X' }, { caller });
  assert.equal(hasNudge(await spawn(caller)), false);
});

// INVARIANT: the caller's CURRENT mode decides, not its spawn-time mode.
test('the caller current mode decides', async () => {
  const caller = await callerSession();
  await callTool('set_mode', { sessionId: caller, mode: 'plan' });
  assert.equal(hasNudge(await spawn(caller)), false);
  await callTool('set_mode', { sessionId: caller, mode: 'bypassPermissions' });
  assert.equal(hasNudge(await spawn(caller)), true);
});

// INVARIANT: a caller in plan mode from birth is never nudged.
test('a plan-mode caller from birth is not nudged', async () => {
  const caller = await callerSession('plan');
  assert.equal(hasNudge(await spawn(caller)), false);
});

// INVARIANT: an anonymous call gets exactly the conductor view.
test('an anonymous spawn carries no nudge', async () => {
  const v = await spawn(undefined);
  assert.equal(hasNudge(v), false);
  assert.deepEqual(Object.keys(v).sort(), [...handlers.CONDUCTOR_VIEW_KEYS].sort());
});

// INVARIANT: a successful resume is nudged like a fresh spawn.
test('a resume is nudged too', async () => {
  const caller = await callerSession();
  const w = await spawn(caller);
  const inst = instForSession(instances, w.sessionId);
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId);
  await callTool('kill_instance', { sessionId: w.sessionId });
  await waitFor(() => !instForSession(instances, w.sessionId)?.proc);
  const back = await callTool('spawn_instance', { resume: w.sessionId }, { caller });
  isNudge(back);
});

// INVARIANT: the worker's `title` argument never titles the caller, so the caller is still nudged.
test('a worker title does not stand in for the caller title', async () => {
  const caller = await callerSession();
  const v = await spawn(caller, { title: 'Worker' });
  isNudge(v);
  assert.equal(await getTitle(caller), null);
});

// INVARIANT: a refused spawn keeps its refusal shape and carries no nudge.
test('a refusal carries no nudge', async () => {
  const caller = await callerSession();
  const r = await callTool('spawn_instance', { project: 'demo', resume: 'bogus-session-id' }, { caller });
  assert.equal(r.code, 'SESSION_UNKNOWN');
  assert.equal(Object.hasOwn(r, 'titleNudge'), false);
});
