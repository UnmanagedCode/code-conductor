// The landing renewal nudge: a conductor's MCP delete_worktree of a worktree
// whose work landed carries `renewNudge` on its result when the opt-in setting
// is on. "Landed" = the persisted `landed` record (written by a successful
// merge) AND no commits left ahead of the base, measured before removal.
//
// One top-level test per row: the root afterEach shuts instances down around
// subtests, so each row builds its own fixture.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  api, bootServer, freshProjectsRoot, rmrf, registerLocalProject, waitFor,
} from './helpers.mjs';
import { createWorktree, getWorktree } from '../src/worktrees.ts';
import { LANDING_RENEW_NUDGE } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

async function commitFile(cwd, filename, content, message) {
  await git(cwd, 'config', 'user.email', 'agent@example.com');
  await git(cwd, 'config', 'user.name', 'agent');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(cwd, filename), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '-m', message);
}

let nextRpcId = 1;
async function callTool(name, args, { caller } = {}) {
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

const setNudge = (on) => api(baseUrl, 'POST', '/api/settings/models/prefs', { landingRenewNudge: on });
const metaOf = (name) => getWorktree('demo', name);

async function spawnIdle(project) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp: true, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst.id;
}
async function conductor() {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  return spawnIdle('.conduct');
}

// A worktree with `commits` commits; optionally merged through MCP.
async function fixture({ commits = 1, merge = false } = {}) {
  const repoPath = await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'job' });
  for (let i = 0; i < commits; i++) await commitFile(wt.worktreePath, `f${i}.txt`, `${i}\n`, `work ${i}`);
  if (merge) {
    const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
    assert.equal(m.ok, true, JSON.stringify(m));
  }
  return { repoPath, wt };
}
const del = (wt, caller) => callTool('delete_worktree', { project: 'demo', worktree: wt.worktreeName }, { caller });
const expected = (wt) => ({ project: 'demo', worktree: wt.worktreeName });

// INVARIANT: a successful merge records `landed: true` on the worktree.
test('a successful merge records landed on the worktree record', async () => {
  const { wt } = await fixture();
  assert.equal((await metaOf(wt.worktreeName)).landed, undefined, 'precondition: absent before the merge');
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.ok, true);
  assert.equal((await metaOf(wt.worktreeName)).landed, true);
});

// INVARIANT: a refused merge (nothing to merge) records nothing.
test('a refused merge on a zero-commit worktree leaves landed absent', async () => {
  const { wt } = await fixture({ commits: 0 });
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.code, 'NOTHING_TO_MERGE');
  assert.equal((await metaOf(wt.worktreeName)).landed, undefined);
});

// INVARIANT: a refused merge (dirty parent) records nothing.
test('a refused merge on a dirty parent leaves landed absent', async () => {
  const { repoPath, wt } = await fixture();
  await fs.writeFile(path.join(repoPath, 'README.md'), 'dirty\n');
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.code, 'PARENT_DIRTY');
  assert.equal((await metaOf(wt.worktreeName)).landed, undefined);
});

// INVARIANT: setting on + conductor caller + landed worktree → renewNudge carries the constant.
test('on, conductor caller, landed: the delete result carries renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), { ...expected(wt), renewNudge: LANDING_RENEW_NUDGE });
});

// INVARIANT: with the setting off the delete result is byte-identical to today's.
test('off, same fixture: the delete result is exactly {project, worktree}', async () => {
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: a worktree that never merged is not nudged.
test('on, never merged: no renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture();
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: a zero-commit worktree is not nudged.
test('on, zero commits: no renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ commits: 0 });
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: work committed after the landing (ahead > 0) is not nudged.
test('on, landed then a new commit: no renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  await commitFile(wt.worktreePath, 'later.txt', 'later\n', 'after landing');
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: only conductor callers are nudged.
test('on, non-conductor caller: no renewNudge', async () => {
  await setNudge(true);
  await api(baseUrl, 'POST', '/api/projects', { name: 'other' });
  const caller = await spawnIdle('other');
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: a call with no live calling session is not nudged.
test('on, no ?caller=: no renewNudge', async () => {
  await setNudge(true);
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, undefined), expected(wt));
});

// INVARIANT: an unreadable landing check fails closed and never changes the delete's outcome.
test('on, base branch renamed after the merge (ahead unknown): delete succeeds, no renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { repoPath, wt } = await fixture({ merge: true });
  await git(repoPath, 'branch', '-m', 'main', 'trunk');
  assert.deepEqual(await del(wt, caller), expected(wt));
});

// INVARIANT: the web UI's REST delete never carries a nudge.
test('on, REST DELETE of a landed worktree: response has no renewNudge', async () => {
  await setNudge(true);
  const { wt } = await fixture({ merge: true });
  const r = await api(baseUrl, 'DELETE', `/api/projects/demo/worktrees/${encodeURIComponent(wt.worktreeName)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal('renewNudge' in r.body, false);
});
