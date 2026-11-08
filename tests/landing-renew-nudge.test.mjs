// The landing renewal nudge: a conductor's MCP delete_worktree of a worktree
// whose work landed carries `renewNudge` on its result when the setting is on
// (the default). "Landed" = the in-memory landing record (set by a successful
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
import { createWorktree, getWorktree, worktreeWorkLanded } from '../src/worktrees.ts';
import {
  recordWorktreeLanding, worktreeLandingRecorded, forgetWorktreeLandings, clearWorktreeLandings,
} from '../src/worktreeLandings.ts';
import { removeProjectStoreDir, orchStoreRoot } from '../src/projects.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { LANDING_RENEW_NUDGE } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); clearWorktreeLandings(); await rmrf(home); });

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

const setNudge = (on) => api(baseUrl, 'POST', '/api/settings/models/prefs', { landingRenewNudge: on });
const recorded = async (name) => {
  const meta = await getWorktree('demo', name);
  return worktreeLandingRecorded('demo', meta.worktreeName, meta.createdAt);
};

async function spawnIdle(project) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp: true, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst.sessionId;
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

// INVARIANT: a successful merge records the landing in the in-memory set.
test('a successful merge records the landing', async () => {
  const { wt } = await fixture();
  assert.equal(await recorded(wt.worktreeName), false, 'precondition: absent before the merge');
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.ok, true);
  assert.equal(await recorded(wt.worktreeName), true);
});

// INVARIANT: a refused merge (nothing to merge) records nothing.
test('a refused merge on a zero-commit worktree records no landing', async () => {
  const { wt } = await fixture({ commits: 0 });
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.code, 'NOTHING_TO_MERGE');
  assert.equal(await recorded(wt.worktreeName), false);
});

// INVARIANT: a refused merge (dirty parent) records nothing.
test('a refused merge on a dirty parent records no landing', async () => {
  const { repoPath, wt } = await fixture();
  await fs.writeFile(path.join(repoPath, 'README.md'), 'dirty\n');
  const m = await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName });
  assert.equal(m.code, 'PARENT_DIRTY');
  assert.equal(await recorded(wt.worktreeName), false);
});

// INVARIANT: setting on + conductor caller + landed worktree → renewNudge carries the constant.
test('on, conductor caller, landed: the delete result carries renewNudge', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), { ...expected(wt), renewNudge: LANDING_RENEW_NUDGE });
});

// INVARIANT: absent means on: with nothing saved, a landed conductor delete carries renewNudge.
test('default (nothing saved), conductor caller, landed: the delete result carries renewNudge', async () => {
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), { ...expected(wt), renewNudge: LANDING_RENEW_NUDGE });
});

// INVARIANT: only models.landingRenewNudgeOn is read: a value saved under the
// retired key does not suppress the nudge.
test('a value saved under models.landingRenewNudgeEnabled does not suppress the nudge', async () => {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(path.join(orchStoreRoot(), 'settings.json'), JSON.stringify({ models: { landingRenewNudgeEnabled: false } }));
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.deepEqual(await del(wt, caller), { ...expected(wt), renewNudge: LANDING_RENEW_NUDGE });
});

// INVARIANT: with the setting off the delete result is byte-identical to today's.
test('off, same fixture: the delete result is exactly {project, worktree}', async () => {
  await setNudge(false);
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
test('on, anonymous (no caller path): no renewNudge', async () => {
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

// INVARIANT: removing a worktree clears its landing, so a same-name successor with a
// new commit is never nudged on its predecessor's merge.
test('a delete clears the landing: a re-created same-name worktree is not nudged', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  assert.equal(await recorded(wt.worktreeName), true, 'precondition');
  assert.equal((await del(wt, caller)).renewNudge, LANDING_RENEW_NUDGE);
  assert.equal(worktreeLandingRecorded('demo', wt.worktreeName, wt.createdAt), false, 'the delete cleared the entry');
  const again = await createWorktree('demo', { name: 'job' });
  await commitFile(again.worktreePath, 'next.txt', 'next\n', 'new work');
  assert.deepEqual(await del(again, caller), expected(again));
});

// Runs fn with a `git` shim first on PATH that logs each invocation's argv, and
// returns the logged lines. The server and these helpers all spawn from process.env.
async function gitCallsDuring(fn) {
  const real = (await new Promise((res, rej) => execFile('sh', ['-c', 'command -v git'], (e, o) => e ? rej(e) : res(o)))).trim();
  const dir = await mkdtemp('cc-gitshim-');
  const log = path.join(dir, 'calls.log');
  await fs.writeFile(path.join(dir, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  try { await fn(); } finally { process.env.PATH = savedPath; }
  return (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}
const aheadCountCalls = (calls) => calls.filter(c => c.includes('rev-list') && c.includes('--left-right'));

// INVARIANT: with the setting off, delete_worktree makes no landing check (no ahead/behind git call).
test('off: a landed delete by a conductor runs no ahead/behind comparison', async () => {
  await setNudge(false);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  const calls = await gitCallsDuring(() => del(wt, caller));
  assert.ok(calls.length > 0, 'the shim observed the delete\'s own git calls');
  assert.deepEqual(aheadCountCalls(calls), []);
});

// Positive control for the row above: the same fixture with the setting on is seen
// running the comparison, so the shim can tell the two apart.
test('on: the same delete runs the ahead/behind comparison (shim control)', async () => {
  await setNudge(true);
  const caller = await conductor();
  const { wt } = await fixture({ merge: true });
  const calls = await gitCallsDuring(() => del(wt, caller));
  assert.equal(aheadCountCalls(calls).length, 1);
});

// INVARIANT: a recorded landing matches only the worktree with the recorded
// createdAt — a same-name meta with another createdAt is not landed while the
// stale entry is still present.
test('a landing matches only the recorded createdAt, while the entry is present', () => {
  recordWorktreeLanding('demo', 'job', '2026-01-01T00:00:00.000Z');
  assert.equal(worktreeLandingRecorded('demo', 'job', '2026-01-01T00:00:00.000Z'), true);
  assert.equal(worktreeLandingRecorded('demo', 'job', '2026-02-02T00:00:00.000Z'), false);
});

// INVARIANT: worktreeWorkLanded rejects a same-name meta of a different worktree
// (other createdAt) even though a landing for that name is recorded and ahead is 0.
test('worktreeWorkLanded is false for a same-name worktree with another createdAt', async () => {
  const { wt } = await fixture({ merge: true });
  const meta = await getWorktree('demo', wt.worktreeName);
  assert.equal(await worktreeWorkLanded('demo', meta), true, 'control: the recorded worktree is landed');
  assert.equal(await worktreeWorkLanded('demo', { ...meta, createdAt: '1999-01-01T00:00:00.000Z' }), false);
});

// INVARIANT: forgetting a project's landings drops that project's entries only
// (a name-prefix of another project does not collide).
test('forgetWorktreeLandings drops one project\'s entries and leaves the others', () => {
  recordWorktreeLanding('demo', 'a', 't');
  recordWorktreeLanding('demo', 'b', 't');
  recordWorktreeLanding('demo2', 'a', 't');
  forgetWorktreeLandings('demo');
  assert.deepEqual(
    [worktreeLandingRecorded('demo', 'a', 't'), worktreeLandingRecorded('demo', 'b', 't'), worktreeLandingRecorded('demo2', 'a', 't')],
    [false, false, true],
  );
});

// INVARIANT: wiping a project's store subtree (adopt-replace, library rollback,
// project delete all go through removeProjectStoreDir) forgets its landings.
test('removeProjectStoreDir forgets the project\'s landings', async () => {
  const { wt } = await fixture({ merge: true });
  assert.equal(await recorded(wt.worktreeName), true, 'precondition');
  await removeProjectStoreDir('demo');
  assert.equal(worktreeLandingRecorded('demo', wt.worktreeName, wt.createdAt), false);
});
