// Integration tests for the git-worktree feature. Each test spins up a
// fresh tmp-home with one real git repo under projectsRoot, then drives
// the orchestrator's worktree REST surface end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { listWorktrees, getWorktree } from '../src/worktrees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// Manual wrap of execFile — promisify(execFile) on this Node build
// resolves to just stdout (a string) instead of {stdout, stderr}.
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

// Create a real git repo at <projectsRoot>/<name>/ with one initial
// commit on a `main` branch so worktrees have something to branch from.
async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

test('createWorktree creates a sibling directory with metadata and a fresh branch', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    // POST /api/instances with worktree:true should create the worktree
    // and spawn an instance into it.
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.worktree, 'instance summary carries worktree metadata');
    assert.match(r.body.worktree.branch, /^claude-orch\//);
    assert.equal(r.body.worktree.baseBranch, 'main');

    // Sibling dir exists and is itself a working tree of the same repo.
    const wts = await listWorktrees('demo');
    assert.equal(wts.length, 1);
    const wt = wts[0];
    assert.match(wt.worktreeName, /^demo_worktree_[a-f0-9]{6}$/);
    assert.equal(path.dirname(wt.worktreePath), ctx.projectsRoot);
    const wtBranch = (await git(wt.worktreePath, 'symbolic-ref', '--short', 'HEAD')).stdout.trim();
    assert.equal(wtBranch, wt.branch);

    // Metadata file is at the worktree root and round-trips.
    const meta = JSON.parse(await fs.readFile(path.join(wt.worktreePath, '.claude-orch-worktree.json'), 'utf8'));
    assert.equal(meta.parentProject, 'demo');
    assert.equal(meta.baseBranch, 'main');
  } finally { await ctx.close(); }
});

test('listProjects hides orchestrator-owned worktree directories', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const list = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    // The freshly-created worktree dir is a sibling of `demo` under
    // projectsRoot, but listProjects must skip it.
    const names = list.body.map(p => p.name);
    assert.deepEqual(names, ['demo'], `projects list leaked a worktree dir: ${names.join(', ')}`);

    // The project entry advertises its worktree + isGitRepo for the UI.
    const demo = list.body.find(p => p.name === 'demo');
    assert.equal(demo.isGitRepo, true);
    assert.equal(demo.worktrees.length, 1);
    assert.equal(demo.worktrees[0].parentProject, 'demo');
  } finally { await ctx.close(); }
});

test('createWorktree rejects when the project is not a git repo', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    // Non-git project: just `mkdir`, no `git init`.
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'plain' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'plain', mode: 'bypassPermissions', worktree: true,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not a git repository/);
  } finally { await ctx.close(); }
});

test('spawn with worktree:"<existing>" reuses the worktree without re-creating it', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const first = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    assert.equal(first.status, 201);
    const wtName = first.body.worktree.worktreeName;
    // Kill the first instance so a second can attach without conflict.
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${first.body.id}`);

    const second = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: wtName,
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.worktree.worktreeName, wtName);
    assert.equal(second.body.worktree.branch, first.body.worktree.branch);

    // Still only ONE worktree on disk — the second spawn must not have
    // created another.
    const wts = await listWorktrees('demo');
    assert.equal(wts.length, 1);
  } finally { await ctx.close(); }
});

test('DELETE /api/projects/:name/worktrees/:wt removes the worktree dir + branch when clean', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const wtName = created.body.worktree.worktreeName;
    const wtBranch = created.body.worktree.branch;
    // Kill the live instance so the worktree isn't blocked by it.
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${created.body.id}`);

    const del = await api(ctx.baseUrl, 'DELETE',
      `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}`);
    assert.equal(del.status, 200);

    // Directory is gone.
    await assert.rejects(fs.stat(path.join(ctx.projectsRoot, wtName)));
    // Branch is gone.
    const branches = (await git(repoPath, 'branch', '--list', wtBranch)).stdout.trim();
    assert.equal(branches, '', `branch ${wtBranch} should have been deleted`);
  } finally { await ctx.close(); }
});

test('DELETE worktree refuses (409) when an instance is still attached, then succeeds with ?force=1', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const wtName = created.body.worktree.worktreeName;
    const id = created.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle');

    const blocked = await api(ctx.baseUrl, 'DELETE',
      `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /running instance/i);
    // Instance is still around.
    assert.ok(ctx.instances.get(id));

    const forced = await api(ctx.baseUrl, 'DELETE',
      `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}?force=1`);
    assert.equal(forced.status, 200);
    // Force-remove should have killed the attached instance.
    await waitFor(() => !ctx.instances.get(id)?.proc, { timeout: 2000 });
  } finally { await ctx.close(); }
});

test('fastForwardParent fast-forwards parent main onto worktree branch after the worktree gets a new commit', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const wtName = created.body.worktree.worktreeName;
    const id = created.body.id;
    const wt = await getWorktree('demo', wtName);

    // Kill the instance so it doesn't hold any file handles in the
    // worktree while we mutate it directly via git from the test.
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${id}`);

    // Add a commit inside the worktree — this is what the agent would
    // normally do during its turn.
    await fs.writeFile(path.join(wt.worktreePath, 'agent.txt'), 'agent work\n');
    await git(wt.worktreePath, 'config', 'user.email', 'agent@example.com');
    await git(wt.worktreePath, 'config', 'user.name', 'agent');
    await git(wt.worktreePath, 'config', 'commit.gpgsign', 'false');
    await git(wt.worktreePath, 'add', '.');
    await git(wt.worktreePath, 'commit', '-q', '-m', 'agent work');
    const wtSha = (await git(wt.worktreePath, 'rev-parse', 'HEAD')).stdout.trim();

    // Spawn a new instance into the worktree just so the FF endpoint
    // has something to route through (it looks up the instance to find
    // the worktree metadata).
    const second = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: wtName,
    });
    const id2 = second.body.id;
    await waitFor(() => ctx.instances.get(id2)?.status === 'idle');

    const ff = await api(ctx.baseUrl, 'POST', `/api/instances/${id2}/fast-forward-parent`);
    assert.equal(ff.status, 200);
    assert.equal(ff.body.ok, true, `ff failed: ${ff.body.reason}`);
    assert.equal(ff.body.newSha, wtSha, 'parent main now points at the worktree-branch tip');

    // Confirm by reading the parent repo's HEAD directly.
    const parentSha = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
    assert.equal(parentSha, wtSha);
  } finally { await ctx.close(); }
});

test('fastForwardParent refuses (returns reason) when parent has switched off the baseBranch', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const id = created.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle');

    // Switch the parent off main to a new branch.
    await git(repoPath, 'switch', '-q', '-c', 'experimental');

    const ff = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fast-forward-parent`);
    assert.equal(ff.status, 200);
    assert.equal(ff.body.ok, false);
    assert.match(ff.body.reason, /parent repo is on 'experimental'/);
  } finally { await ctx.close(); }
});

test('rebase-prompt endpoint sends the templated prompt to the agent', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    const id = created.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle');

    const events = [];
    ctx.instances.on('event', ({ id: eid, ev }) => { if (eid === id) events.push(ev); });

    const r = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rebase-prompt`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    // The orchestrator emits a user_echo with the rebase prompt text.
    await waitFor(() => events.some(e => e.kind === 'user_echo'));
    const echo = events.find(e => e.kind === 'user_echo');
    assert.match(echo.text, /isolated git worktree/);
    assert.match(echo.text, /git rebase main/);
    assert.match(echo.text, /REBASE_DONE/);
  } finally { await ctx.close(); }
});

test('rebase-prompt rejects non-worktree instances', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions',
    });
    const id = created.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle');

    const r = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rebase-prompt`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not attached to a worktree/);
  } finally { await ctx.close(); }
});
