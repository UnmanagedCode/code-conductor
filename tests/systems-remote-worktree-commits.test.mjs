// THE COMMIT-HISTORY VIEW, ADDRESSED AT A WORKTREE.
//
// A worktree of a REMOTE project lives ON THE SYSTEM, under
// `<dirname(project path)>/.worktrees/<project>/<key>` by default
// (`worktreePathFor`), so there is nothing under cc's projects root to find and
// no store record that registers it as a project — the only addressing form
// that can reach it is `(project, worktree)`. The local arm of these same
// invariants is tests/project-commits.test.mjs; this file is the remote arm,
// and the fixture's tree root is a temp dir OUTSIDE PROJECTS_ROOT, so any code
// that composes a path from `projectsRoot()` lands where the tree is not and
// the assertion fails instead of passing by accident.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git } from './remoteSystem.mjs';
import { adoptProject, projectsRoot } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

describe('commit history for a worktree on a system', () => {
  let ctx, baseUrl, home, remote, tree, wt;

  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    wt = await createWorktree('app', { name: 'feature' });
    // The condition every assertion below turns on: the worktree is on the
    // system, not under cc's projects root — and in the ONE uniform layout,
    // `<worktrees root>/<project>/<key>`, with no per-kind exception.
    assert.equal(wt.worktreePath,
      path.posix.join(remote.root, '.worktrees', 'app', wt.worktreeName));
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // Commit on the worktree branch, so its history differs from the parent's.
  async function commitInWorktree(file, body, message) {
    await fs.writeFile(path.join(wt.worktreePath, file), body);
    await git(wt.worktreePath, 'add', '-A');
    await git(wt.worktreePath, 'commit', '-q', '-m', message);
    const { stdout } = await git(wt.worktreePath, 'rev-parse', 'HEAD');
    return stdout.trim();
  }

  // PINS: the headline defect — the commit list reaches a worktree whose tree
  // is on a system, and reports THAT worktree's branch and history.
  test('GET /worktrees/:wt/commits returns the worktree branch history', async () => {
    await commitInWorktree('feature.js', 'export const x = 1;\n', 'worktree commit');

    const r = await api(baseUrl, 'GET',
      `/api/projects/app/worktrees/${encodeURIComponent(wt.worktreeName)}/commits`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.project, 'app', 'the parent project names the response');
    assert.equal(r.body.worktreeName, wt.worktreeName, 'echoes the canonical worktree name');
    assert.equal(r.body.branch, wt.branch, 'HEAD is read in the worktree, not the parent tree');
    assert.deepEqual(r.body.commits.map(c => c.subject), ['worktree commit', 'initial']);
  });

  // PINS: the ahead computation gets its base from the worktree's own record —
  // the parent tree has no upstream, so a count can only come from meta.baseBranch.
  test('aheadCount/aheadOf are measured against the recorded base branch', async () => {
    await commitInWorktree('feature.js', 'export const x = 1;\n', 'worktree commit');

    const r = await api(baseUrl, 'GET',
      `/api/projects/app/worktrees/${encodeURIComponent(wt.worktreeName)}/commits`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.aheadOf, wt.baseBranch);
    assert.equal(r.body.aheadCount, 1, 'exactly the one commit made on the worktree branch');
    assert.deepEqual(r.body.commits.map(c => c.ahead), [true, false]);
  });

  // PINS: `git status` runs in the worktree ON THE SYSTEM, not in the parent
  // tree. Adoption leaves untracked files in the parent, so the parent answers
  // TRUE throughout — which is what makes the fresh worktree's `false` the
  // discriminator: a status taken in the parent could not produce it.
  test('hasUncommitted tracks the remote worktree, not the parent tree', async () => {
    const wtUrl = `/api/projects/app/worktrees/${encodeURIComponent(wt.worktreeName)}/commits`;

    const parent = await api(baseUrl, 'GET', '/api/projects/app/commits');
    assert.equal(parent.body.hasUncommitted, true, 'control: the parent tree is dirty throughout');

    const clean = await api(baseUrl, 'GET', wtUrl);
    assert.equal(clean.status, 200, JSON.stringify(clean.body));
    assert.equal(clean.body.hasUncommitted, false, 'the fresh worktree is clean');

    await fs.writeFile(path.join(wt.worktreePath, 'README.md'), '# dirtied in the worktree\n');

    const dirty = await api(baseUrl, 'GET', wtUrl);
    assert.equal(dirty.status, 200, JSON.stringify(dirty.body));
    assert.equal(dirty.body.hasUncommitted, true);
  });

  // PINS: tapping a commit in that list resolves on the system too — the whole
  // view is the new addressing form, not just the list. (A worktree shares its
  // parent's object database, so this route's TARGET is not what distinguishes
  // it; what it pins is that the form exists and reaches the system rather than
  // composing a path under cc's projects root.)
  test('GET /worktrees/:wt/commits/:sha/diff returns that commit\'s change', async () => {
    const sha = await commitInWorktree('feature.js', 'export const x = 1;\n', 'worktree commit');

    const r = await api(baseUrl, 'GET',
      `/api/projects/app/worktrees/${encodeURIComponent(wt.worktreeName)}/commits/${sha}/diff`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.commitMessage, 'worktree commit');
    assert.deepEqual(r.body.files.map(f => f.path), ['feature.js']);
    assert.equal(r.body.files[0].status, 'added');

    // The discriminator, since the target cannot be one: an unknown worktree is
    // refused, so the name reaching this route is RESOLVED, not ignored.
    const unknown = await api(baseUrl, 'GET',
      `/api/projects/app/worktrees/app_worktree_nope/commits/${sha}/diff`);
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error, "worktree 'app_worktree_nope' not found under project 'app'");
  });

  // PINS: the "Working tree" row of that list resolves on the system too.
  test('GET /worktrees/:wt/commits/uncommitted/diff returns the dirty file', async () => {
    await fs.writeFile(path.join(wt.worktreePath, 'README.md'), '# dirtied in the worktree\n');

    const r = await api(baseUrl, 'GET',
      `/api/projects/app/worktrees/${encodeURIComponent(wt.worktreeName)}/commits/uncommitted/diff`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.files.map(f => f.path), ['README.md']);
    assert.equal(r.body.totalAdds, 1);

    const parent = await api(baseUrl, 'GET', '/api/projects/app/commits/uncommitted/diff');
    assert.deepEqual(parent.body.files, [], 'control: the parent tree has no uncommitted change');
  });

  // PINS: the fix is the new addressing form, NOT a widening of getProject. A
  // worktree dir name is not a project name, and on a system there is nothing
  // under projectsRoot() that could make it look like one.
  test('the bare worktree-dir-name spelling is still not a project', async () => {
    assert.equal(await fs.stat(path.join(projectsRoot(), wt.worktreeName)).then(() => true, () => false),
      false, 'sanity: nothing local carries that name');

    const r = await api(baseUrl, 'GET',
      `/api/projects/${encodeURIComponent(wt.worktreeName)}/commits`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not found/);
  });

  // PINS: an unknown worktree under a real project is a 404 naming both, not a
  // 500 — the resolver's miss is an addressing error, and both surfaces read it
  // from the same throw.
  test('an unknown worktree under a real project is a 404', async () => {
    const r = await api(baseUrl, 'GET', '/api/projects/app/worktrees/app_worktree_nope/commits');
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "worktree 'app_worktree_nope' not found under project 'app'");
  });
});
