// Integration tests for the git-worktree feature. Each test spins up a
// fresh tmp-home with one real git repo under projectsRoot, then drives
// the orchestrator's worktree REST surface end-to-end.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { listWorktrees, getWorktree, getWorktreeMergeStatus } from '../src/worktrees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

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
async function makeRealRepo(name) {
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
  const repoPath = await makeRealRepo('demo');
  // POST /api/instances with worktree:true should create the worktree
  // and spawn an instance into it.
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.worktree, 'instance summary carries worktree metadata');
  assert.match(r.body.worktree.branch, /^code-conductor\//);
  assert.equal(r.body.worktree.baseBranch, 'main');

  // Sibling dir exists and is itself a working tree of the same repo.
  const wts = await listWorktrees('demo');
  assert.equal(wts.length, 1);
  const wt = wts[0];
  assert.match(wt.worktreeName, /^demo_worktree_[a-f0-9]{6}$/);
  assert.equal(path.dirname(wt.worktreePath), projectsRoot);
  const wtBranch = (await git(wt.worktreePath, 'symbolic-ref', '--short', 'HEAD')).stdout.trim();
  assert.equal(wtBranch, wt.branch);

  // Metadata file lives in the workspace-wide central store and
  // round-trips. The worktree dir itself stays clean (no `.code-conductor/`).
  const metaPath = path.join(
    projectsRoot, '.code-conductor', 'projects', 'demo',
    'worktrees', wt.worktreeName, 'worktree.json',
  );
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(meta.parentProject, 'demo');
  assert.equal(meta.baseBranch, 'main');
  await assert.rejects(
    fs.stat(path.join(wt.worktreePath, '.code-conductor')),
    { code: 'ENOENT' },
    'worktree dir must not contain a .code-conductor/ dotfolder',
  );
  // suppress unused warning
  void repoPath;
});

test('listProjects hides orchestrator-owned worktree directories', async () => {
  await makeRealRepo('demo');
  await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const list = await api(baseUrl, 'GET', '/api/projects');
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
});

test('createWorktree rejects when the project is not a git repo', async () => {
  // Non-git project: just `mkdir`, no `git init`.
  await api(baseUrl, 'POST', '/api/projects', { name: 'plain' });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'plain', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not a git repository/);
});

test('spawn with worktree:"<existing>" reuses the worktree without re-creating it', async () => {
  await makeRealRepo('demo');
  const first = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(first.status, 201);
  const wtName = first.body.worktree.worktreeName;
  // Kill the first instance so a second can attach without conflict.
  await api(baseUrl, 'DELETE', `/api/instances/${first.body.id}`);

  const second = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: wtName,
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.worktree.worktreeName, wtName);
  assert.equal(second.body.worktree.branch, first.body.worktree.branch);

  // Still only ONE worktree on disk — the second spawn must not have
  // created another.
  const wts = await listWorktrees('demo');
  assert.equal(wts.length, 1);
});

test('DELETE /api/projects/:name/worktrees/:wt removes the worktree dir + branch when clean', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtBranch = created.body.worktree.branch;
  // Kill the live instance so the worktree isn't blocked by it.
  await api(baseUrl, 'DELETE', `/api/instances/${created.body.id}`);

  const del = await api(baseUrl, 'DELETE',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}`);
  assert.equal(del.status, 200);

  // Directory is gone.
  await assert.rejects(fs.stat(path.join(projectsRoot, wtName)));
  // Branch is gone.
  const branches = (await git(repoPath, 'branch', '--list', wtBranch)).stdout.trim();
  assert.equal(branches, '', `branch ${wtBranch} should have been deleted`);
});

test('DELETE worktree refuses (409) when an instance is still attached, then succeeds with ?force=1', async () => {
  await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  const blocked = await api(baseUrl, 'DELETE',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /running instance/i);
  // Instance is still around.
  assert.ok(instances.get(id));

  const forced = await api(baseUrl, 'DELETE',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}?force=1`);
  assert.equal(forced.status, 200);
  // Force-remove should have killed the attached instance. Inherit the
  // default deadline rather than capping at a tight 2s (kill grace + child
  // exit can run long under concurrent CPU contention).
  await waitFor(() => !instances.get(id)?.proc);
});

// Configure the worktree's git identity so commits made by the test
// against the worktree path succeed even on hosts where no global
// user.email is set.
async function configureWorktreeIdentity(worktreePath) {
  await git(worktreePath, 'config', 'user.email', 'agent@example.com');
  await git(worktreePath, 'config', 'user.name', 'agent');
  await git(worktreePath, 'config', 'commit.gpgsign', 'false');
}

// Add a commit inside the worktree — mirrors what the agent would do
// during a real turn. Returns the new HEAD SHA.
async function commitInWorktree(worktreePath, filename, content, message) {
  await fs.writeFile(path.join(worktreePath, filename), content);
  await configureWorktreeIdentity(worktreePath);
  await git(worktreePath, 'add', '.');
  await git(worktreePath, 'commit', '-q', '-m', message);
  return (await git(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
}

async function commitInParent(repoPath, filename, content, message) {
  await fs.writeFile(path.join(repoPath, filename), content);
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', message);
  return (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
}

test('POST /sync returns already-in-sync when worktree matches parent', async () => {
  await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, 'already-in-sync');
  assert.equal(r.body.ahead, 0);
  assert.equal(r.body.behind, 0);
});

test('POST /sync fast-forwards the worktree when it is purely behind a clean parent', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Parent advances; worktree's branch tip stays where it was — so the
  // worktree is purely behind. With a clean tree, sync must FF.
  const parentSha = await commitInParent(repoPath, 'parent.txt', 'parent work\n', 'parent work');

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, `sync failed: ${r.body.reason}`);
  assert.equal(r.body.action, 'fast-forwarded');
  assert.equal(r.body.newSha, parentSha);

  // Worktree HEAD now points at the parent's new tip.
  const wtSha = (await git(wt.worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
  assert.equal(wtSha, parentSha);
});

test('POST /sync falls back to the rebase prompt when the pure-behind worktree has uncommitted changes', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Parent advances; worktree has an uncommitted file.
  await commitInParent(repoPath, 'parent.txt', 'parent work\n', 'parent work');
  await fs.writeFile(path.join(wt.worktreePath, 'wip.txt'), 'uncommitted\n');

  const events = [];
  instances.on('event', ({ id: eid, ev }) => { if (eid === id) events.push(ev); });

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, 'rebase-prompt-sent');

  await waitFor(() => events.some(e => e.kind === 'user_echo'));
  const echo = events.find(e => e.kind === 'user_echo');
  assert.match(echo.text, /isolated git worktree/);
  assert.match(echo.text, /git rebase main/);
  assert.match(echo.text, /REBASE_DONE/);
});

test('POST /sync auto-rebases the worktree when it has diverged without conflicts', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Both sides commit different files → diverged but no conflict.
  await commitInParent(repoPath, 'parent.txt', 'parent work\n', 'parent work');
  await instances.get(id).kill({ graceMs: 200 });
  await commitInWorktree(wt.worktreePath, 'agent.txt', 'agent work\n', 'agent work');

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, `sync failed: ${r.body.reason}`);
  assert.equal(r.body.action, 'rebased');
  assert.equal(r.body.behind, 0);
  assert.ok(r.body.newSha, 'rebased result carries new HEAD sha');

  // Worktree HEAD should now be ahead of the parent's new tip (rebased on top).
  const wtSha = (await git(wt.worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
  assert.equal(wtSha, r.body.newSha);
  // Worktree branch must be a descendant of the parent commit.
  const parentSha = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
  const isAncestor = await git(repoPath, 'merge-base', '--is-ancestor', parentSha, wtSha)
    .then(() => true).catch(() => false);
  assert.ok(isAncestor, 'worktree HEAD should be a descendant of the parent tip after rebase');
});

test('POST /sync falls back to the rebase prompt when the diverged worktree has conflicts', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Both sides modify the same line → guaranteed conflict.
  await commitInParent(repoPath, 'shared.txt', 'parent version\n', 'parent edit');
  await instances.get(id).kill({ graceMs: 200 });
  await commitInWorktree(wt.worktreePath, 'shared.txt', 'agent version\n', 'agent edit');
  // Re-spawn so the sync endpoint has a live instance for the prompt.
  const second = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: wtName,
  });
  const id2 = second.body.id;
  await waitFor(() => instances.get(id2)?.status === 'idle');

  const events = [];
  instances.on('event', ({ id: eid, ev }) => { if (eid === id2) events.push(ev); });

  const r = await api(baseUrl, 'POST', `/api/instances/${id2}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, 'rebase-prompt-sent');
  assert.equal(r.body.ahead, 1);
  assert.equal(r.body.behind, 1);

  // Worktree must be clean — rebase was aborted before falling back.
  const status = (await git(wt.worktreePath, 'status', '--porcelain')).stdout.trim();
  assert.equal(status, '', 'worktree should be clean after aborted rebase');

  await waitFor(() => events.some(e => e.kind === 'user_echo'));
  const echo = events.find(e => e.kind === 'user_echo');
  assert.match(echo.text, /git rebase main/);
});

test('POST /sync refuses the rebase prompt when the instance is not running (conflict fallback)', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Both sides modify the same line → guaranteed conflict so auto-rebase
  // fails and the code must fall back to sending the rebase prompt. With
  // the instance stopped, that fallback path should return ok:false.
  await commitInParent(repoPath, 'shared.txt', 'parent version\n', 'parent edit');
  await instances.get(id).kill({ graceMs: 200 });
  await commitInWorktree(wt.worktreePath, 'shared.txt', 'agent version\n', 'agent edit');
  await waitFor(() => !instances.get(id)?.proc);

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /not running/i);

  // Worktree must be clean — aborted rebase should not leave stray files.
  const status = (await git(wt.worktreePath, 'status', '--porcelain')).stdout.trim();
  assert.equal(status, '', 'worktree should be clean after aborted rebase');
});

test('POST /merge creates a merge commit on the parent when worktree is ahead (--no-ff)', async () => {
  const repoPath = await makeRealRepo('demo');
  // Capture the parent's tip before any worktree work so we can later
  // assert the merge commit has the right first parent.
  const parentBeforeSha = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();

  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Stop the live proc, add a commit on the worktree branch, then
  // re-attach an instance so the route can find one.
  await instances.get(id).kill({ graceMs: 200 });
  const wtSha = await commitInWorktree(wt.worktreePath, 'agent.txt', 'agent work\n', 'agent work');
  const second = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: wtName,
  });
  const id2 = second.body.id;
  await waitFor(() => instances.get(id2)?.status === 'idle');

  const r = await api(baseUrl, 'POST', `/api/instances/${id2}/merge`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, `merge failed: ${r.body.reason}`);
  // --no-ff means the parent's new tip is a brand-new merge commit, not
  // the worktree's tip.
  assert.notEqual(r.body.newSha, wtSha, 'merge commit should be distinct from worktree tip');

  const parentSha = (await git(repoPath, 'rev-parse', 'HEAD')).stdout.trim();
  assert.equal(parentSha, r.body.newSha);

  // The new commit must be a true merge: two parents, first is the old
  // parent tip, second is the worktree's tip.
  const parents = (await git(repoPath, 'rev-list', '--parents', '-n', '1', parentSha))
    .stdout.trim().split(/\s+/);
  assert.equal(parents.length, 3, `expected merge commit (3 fields), got: ${parents.join(' ')}`);
  assert.equal(parents[0], parentSha);
  assert.equal(parents[1], parentBeforeSha);
  assert.equal(parents[2], wtSha);

  // Git's default merge message — we explicitly didn't customize it.
  const msg = (await git(repoPath, 'log', '-1', '--format=%s', parentSha)).stdout.trim();
  assert.match(msg, /^Merge branch 'code-conductor\//);
});

test('POST /merge fast-forwards the worktree branch so it is left at behind:0', async () => {
  await makeRealRepo('demo');

  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  await instances.get(id).kill({ graceMs: 200 });
  await commitInWorktree(wt.worktreePath, 'agent.txt', 'agent work\n', 'agent work');
  const second = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: wtName,
  });
  const id2 = second.body.id;
  await waitFor(() => instances.get(id2)?.status === 'idle');

  const r = await api(baseUrl, 'POST', `/api/instances/${id2}/merge`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, `merge failed: ${r.body.reason}`);
  assert.equal(r.body.worktreeFastForwarded, true);

  // The worktree's branch should now point at the merge commit itself —
  // it's no longer left one commit behind the parent's new HEAD.
  const wtSha = (await git(wt.worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
  assert.equal(wtSha, r.body.newSha);

  const refreshed = await getWorktree('demo', wtName);
  const status = await getWorktreeMergeStatus(refreshed);
  assert.deepEqual(status, { ahead: 0, behind: 0 });
});

test('POST /merge refuses with a Sync-first hint when the worktree is behind the parent', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Parent advances → worktree is now behind.
  await commitInParent(repoPath, 'parent.txt', 'parent work\n', 'parent work');

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/merge`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /click Sync first/);
});

test('POST /merge surfaces mergeWorktreeIntoParent\'s own refusal when parent has switched branches', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Switch the parent to a different branch — the worktree is still
  // up to date with main, so the Sync-first gate doesn't trip, but
  // fastForwardParent will refuse on the "parent is on '<other>'" path.
  await git(repoPath, 'switch', '-q', '-c', 'experimental');

  const r = await api(baseUrl, 'POST', `/api/instances/${id}/merge`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /parent repo is on 'experimental'/);
});

test('POST /merge refuses NOTHING_TO_MERGE when the worktree has no commits ahead of base', async () => {
  await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Nothing committed in the worktree, parent unchanged — ahead:0/behind:0.
  const r = await api(baseUrl, 'POST', `/api/instances/${id}/merge`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'NOTHING_TO_MERGE');
});

test('POST /merge refuses WORKTREE_DIRTY when the worktree has uncommitted changes, allowDirty overrides', async () => {
  await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  await waitFor(() => instances.get(id)?.status === 'idle');

  await instances.get(id).kill({ graceMs: 200 });
  // Commit something so the branch is ahead, then leave an *additional*
  // uncommitted file dirtying the tree.
  await commitInWorktree(wt.worktreePath, 'agent.txt', 'agent work\n', 'agent work');
  await fs.writeFile(path.join(wt.worktreePath, 'scratch.txt'), 'not committed\n');
  const second = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: wtName,
  });
  const id2 = second.body.id;
  await waitFor(() => instances.get(id2)?.status === 'idle');

  const refused = await api(baseUrl, 'POST', `/api/instances/${id2}/merge`);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'WORKTREE_DIRTY');

  const allowed = await api(baseUrl, 'POST', `/api/instances/${id2}/merge`, { allowDirty: true });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true, `merge failed: ${allowed.body.reason}`);
});

test('GET /api/projects exposes mergeStatus tracking ahead/behind for each worktree', async () => {
  const repoPath = await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const id = created.body.id;
  const wt = await getWorktree('demo', wtName);
  // Kill the instance so we can mutate the worktree from the test
  // without racing the (silent) subprocess.
  await api(baseUrl, 'DELETE', `/api/instances/${id}`);

  // Fresh worktree: no commits on either side.
  let r = await api(baseUrl, 'GET', '/api/projects');
  let demo = r.body.find(p => p.name === 'demo');
  let me = demo.worktrees.find(w => w.worktreeName === wtName);
  assert.deepEqual(me.mergeStatus, { ahead: 0, behind: 0 });

  // Add a commit inside the worktree — it's now ahead of main.
  await fs.writeFile(path.join(wt.worktreePath, 'agent.txt'), 'agent work\n');
  await git(wt.worktreePath, 'config', 'user.email', 'agent@example.com');
  await git(wt.worktreePath, 'config', 'user.name', 'agent');
  await git(wt.worktreePath, 'config', 'commit.gpgsign', 'false');
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'agent work');

  r = await api(baseUrl, 'GET', '/api/projects');
  demo = r.body.find(p => p.name === 'demo');
  me = demo.worktrees.find(w => w.worktreeName === wtName);
  assert.equal(me.mergeStatus.ahead, 1, 'one unmerged commit in worktree');
  assert.equal(me.mergeStatus.behind, 0);

  // Advance the parent's main by an independent commit — now both sides
  // have diverged so we are ahead 1 / behind 1.
  await fs.writeFile(path.join(repoPath, 'parent.txt'), 'parent work\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'parent work');

  r = await api(baseUrl, 'GET', '/api/projects');
  demo = r.body.find(p => p.name === 'demo');
  me = demo.worktrees.find(w => w.worktreeName === wtName);
  assert.equal(me.mergeStatus.ahead, 1);
  assert.equal(me.mergeStatus.behind, 1);
});

test('sync and merge reject non-worktree instances', async () => {
  await makeRealRepo('demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions',
  });
  const id = created.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  const s = await api(baseUrl, 'POST', `/api/instances/${id}/sync`);
  assert.equal(s.status, 400);
  assert.match(s.body.error, /not attached to a worktree/);

  const m = await api(baseUrl, 'POST', `/api/instances/${id}/merge`);
  assert.equal(m.status, 400);
  assert.match(m.body.error, /not attached to a worktree/);
});

test('GET /api/projects exposes mergeStatus for the project branch vs its configured upstream', async () => {
  const repoPath = await makeRealRepo('demo');

  // Bare repo nearby to act as origin. Living outside projectsRoot
  // keeps it from being picked up as a sibling project.
  const remotePath = path.join(path.dirname(projectsRoot), 'demo-remote.git');
  await fs.mkdir(remotePath, { recursive: true });
  await git(remotePath, 'init', '--bare', '-q', '-b', 'main');

  await git(repoPath, 'remote', 'add', 'origin', remotePath);
  await git(repoPath, 'push', '-q', '-u', 'origin', 'main');

  // Up to date with origin/main right after the push.
  let r = await api(baseUrl, 'GET', '/api/projects');
  let demo = r.body.find(p => p.name === 'demo');
  assert.deepEqual(demo.mergeStatus, { ahead: 0, behind: 0, upstream: 'origin/main' });

  // Local-only commit — ahead by one, behind zero.
  await fs.writeFile(path.join(repoPath, 'local.txt'), 'local work\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'local work');

  r = await api(baseUrl, 'GET', '/api/projects');
  demo = r.body.find(p => p.name === 'demo');
  assert.equal(demo.mergeStatus.ahead, 1, 'one unpushed commit');
  assert.equal(demo.mergeStatus.behind, 0);
  assert.equal(demo.mergeStatus.upstream, 'origin/main');

  // Advance origin/main from a second working copy, then fetch into
  // demo so its cached origin/main moves forward. demo's branch and
  // origin/main have now diverged: ahead 1 / behind 1.
  const otherPath = path.join(path.dirname(projectsRoot), 'demo-other');
  await fs.mkdir(otherPath, { recursive: true });
  await git(otherPath, 'clone', '-q', remotePath, '.');
  await git(otherPath, 'config', 'user.email', 'other@example.com');
  await git(otherPath, 'config', 'user.name', 'other');
  await git(otherPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(otherPath, 'remote.txt'), 'remote work\n');
  await git(otherPath, 'add', '.');
  await git(otherPath, 'commit', '-q', '-m', 'remote work');
  await git(otherPath, 'push', '-q', 'origin', 'main');

  await git(repoPath, 'fetch', '-q', 'origin');

  r = await api(baseUrl, 'GET', '/api/projects');
  demo = r.body.find(p => p.name === 'demo');
  assert.equal(demo.mergeStatus.ahead, 1);
  assert.equal(demo.mergeStatus.behind, 1);
  assert.equal(demo.mergeStatus.upstream, 'origin/main');
});

test('GET /api/projects reports null mergeStatus when the branch has no upstream', async () => {
  await makeRealRepo('solo');

  const r = await api(baseUrl, 'GET', '/api/projects');
  const solo = r.body.find(p => p.name === 'solo');
  assert.deepEqual(solo.mergeStatus, { ahead: null, behind: null, upstream: null });
});
