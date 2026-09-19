// WHERE A REMOTE PROJECT'S WORKTREES GO. One layout —
// `<worktrees root>/<project>/<key>` — with only the ROOT varying: a system's
// configured `worktreesDir`, else a `.worktrees` beside the project's own tree.
//
// The system row is the only place that can carry the setting: a remote TARGET
// is discovered from the provider at resolve time and is not registered state.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { adoptProject, readProjectRecord, projectStoreDir } from '../src/projects.ts';
import { createWorktree, worktreePathFor } from '../src/worktrees.ts';
import { updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

describe('a remote project\'s worktree root', () => {
  let ctx, home, remote, tree;

  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // PINS: AC7's default. cc owns no area on another machine, so the default
  // sits beside the tree that is already there — and it is the SAME
  // `<root>/<project>/<key>` shape the local layout uses, not a sibling.
  test('a remote project\'s worktree defaults to dirname(path)/.worktrees/<project>/<key>', async () => {
    const wt = await createWorktree('app', { name: 'feature' });
    assert.equal(wt.worktreeName, 'feature');
    assert.equal(wt.worktreePath,
      path.posix.join(path.posix.dirname(tree), '.worktrees', 'app', 'feature'));
    assert.ok((await fs.stat(wt.worktreePath)).isDirectory(), 'and the checkout is really there');
  });

  // PINS: AC7's opt-in. A row-level setting moves the root, and it moves the
  // DERIVATION too — `worktreePathFor` is what the transcript guard uses, so a
  // setting honoured only at creation would put the guard out of step with the
  // thing it guards.
  test('a system row\'s worktreesDir overrides it', async () => {
    const custom = path.join(remote.root, 'cc-worktrees');
    await fs.mkdir(custom, { recursive: true });
    await updateSystem(remote.id, { worktreesDir: custom });

    const wt = await createWorktree('app', { name: 'feature' });
    assert.equal(wt.worktreePath, path.posix.join(custom, 'app', 'feature'));
    assert.equal(worktreePathFor({ name: 'app', path: tree, system: remote.id }, 'feature'),
      wt.worktreePath, 'the derivation agrees with what was created');
  });

  // PINS: there is NO per-project override. The record carries a location, not
  // a worktree root, and a hand-added field must not move the layout — mutate
  // the record and assert the path is unchanged.
  test('a project-record field does not override it', async () => {
    const before = worktreePathFor({ name: 'app', path: tree, system: remote.id }, 'feature');
    const record = await readProjectRecord('app');
    await fs.writeFile(path.join(projectStoreDir('app'), 'project.json'),
      JSON.stringify({ ...record, worktreesDir: '/somewhere/else' }, null, 2));

    const wt = await createWorktree('app', { name: 'feature' });
    assert.equal(wt.worktreePath, before);
    assert.ok(!wt.worktreePath.startsWith('/somewhere/else'));
  });
});
