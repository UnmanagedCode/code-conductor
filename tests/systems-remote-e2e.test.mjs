// THE PHASE'S ACCEPTANCE CRITERION, end to end: a project bound to a system,
// driven through the real REST surface the projects UI calls and through every
// `project_*` MCP tool — created, worktreed, edited, diffed, merged,
// unregistered — WITH NO WORKER EVER SPAWNED.
//
// "No worker spawned" is not incidental: worker sessions on a remote system are
// the NEXT phase, and this one has to be complete without them. The assertion
// is made structurally — the instance registry is checked empty at the end, and
// spawning is separately proven to refuse.
//
// The system is the reference provider: this machine, reached over the wire
// protocol. The trees live outside PROJECTS_ROOT, so any operation that fell
// back to a local path would be operating on a directory that does not exist,
// and every assertion below would fail rather than pass by accident.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git, snapshotTree, assertTreeUnchanged } from './remoteSystem.mjs';
import { projectsRoot } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

let nextRpcId = 1;
async function callTool(baseUrl, name, args, { expectError = false } = {}) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  if (!expectError) assert.ok(!body.result.isError, `tools/call ${name} errored: ${JSON.stringify(body.result)}`);
  else assert.ok(body.result.isError, `tools/call ${name} was expected to refuse: ${JSON.stringify(body.result)}`);
  // A payload tool emits its metadata and its body as SEPARATE content blocks;
  // reading only the first would silently assert against the metadata.
  return body.result.content.map(c => c.text).join('\n');
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

describe('a project on a system, end to end, with no worker', () => {
  let ctx, baseUrl, instances, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
  });
  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // PINS the headline criterion: the whole lifecycle of a remote project over
  // the surfaces a user and a conductor actually drive, with the instance
  // registry empty throughout.
  test('create → worktree → bash → read → status → diff → merge → unregister', async () => {
    const tree = path.join(remote.root, 'app');

    // ── 1. Create it on the system, through the route the New Project dialog posts to.
    const created = await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, systemPath: tree,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.path, tree);
    assert.equal(created.body.system, remote.id);
    assert.equal(await exists(path.join(tree, '.git')), true);
    assert.equal(await exists(path.join(projectsRoot(), 'app')), false,
      'nothing was created on cc\'s own machine');

    // A first commit, so the project has a HEAD to branch a worktree from.
    await git(tree, 'config', 'user.email', 'test@example.com');
    await git(tree, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(tree, 'app.txt'), 'v1\n');
    await git(tree, 'add', '-A');
    await git(tree, 'commit', '-q', '-m', 'initial');

    // ── 2. The listing the sidebar renders reports it as a measured git repo.
    const listed = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(listed.status, 200);
    const row = listed.body.find(p => p.name === 'app');
    assert.ok(row, 'the remote project is in the listing');
    assert.equal(row.systemUnreachable, null, 'a reachable system degrades nothing');
    assert.equal(row.isGitRepo, true, 'the git facts were measured ON THE SYSTEM');
    assert.equal(row.unbornHead, false);
    assert.equal(row.system, remote.id);
    assert.equal(row.systemPath, tree);
    assert.equal(row.path, tree);

    // ── 3. A worktree, through the tool a conductor calls (worktree creation
    //      has no REST route of its own — the UI reaches it via spawn, which is
    //      exactly what must not happen on a remote system this phase).
    const wtText = await callTool(baseUrl, 'create_worktree', { project: 'app', name: 'feature' });
    const wt = (await api(baseUrl, 'GET', '/api/projects/app/worktrees')).body[0];
    assert.ok(wt, `no worktree was registered; create_worktree said: ${wtText}`);
    assert.equal(wt.worktreePath, path.join(remote.root, wt.worktreeName));
    assert.equal(await exists(path.join(wt.worktreePath, 'app.txt')), true, 'a real checkout on the system');
    assert.equal(await exists(path.join(projectsRoot(), wt.worktreeName)), false);

    // ── 4. project_bash, in the worktree, on the system.
    const bashed = await callTool(baseUrl, 'project_bash', {
      project: 'app', worktree: wt.worktreeName, command: 'pwd && cat app.txt',
    });
    assert.match(bashed, new RegExp(wt.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(bashed, /v1/);

    // Make a change and commit it, so there is something to diff and merge.
    await fs.writeFile(path.join(wt.worktreePath, 'app.txt'), 'v2\n');
    await fs.writeFile(path.join(wt.worktreePath, 'added.txt'), 'new file\n');

    // ── 5. project_read, on the system.
    const read = await callTool(baseUrl, 'project_read', {
      project: 'app', worktree: wt.worktreeName, relativePath: 'app.txt',
    });
    assert.match(read, /v2/);

    // ── 6. project_status: the dirty tree, measured on the system.
    const statusDirty = await callTool(baseUrl, 'project_status', {
      project: 'app', worktree: wt.worktreeName,
    });
    assert.match(statusDirty, /app\.txt/);
    assert.match(statusDirty, /added\.txt/);

    // ── 7. project_diff against the base, before committing.
    const diffUncommitted = await callTool(baseUrl, 'project_diff', {
      project: 'app', worktree: wt.worktreeName,
    });
    assert.match(diffUncommitted, /app\.txt/);

    await git(wt.worktreePath, 'add', '-A');
    await git(wt.worktreePath, 'commit', '-q', '-m', 'v2');

    const diffCommitted = await callTool(baseUrl, 'project_diff', {
      project: 'app', worktree: wt.worktreeName,
    });
    assert.match(diffCommitted, /added\.txt/);

    // ── 8. Merge it back, through the MCP tool a conductor calls.
    const merged = await callTool(baseUrl, 'merge_worktree', {
      project: 'app', worktree: wt.worktreeName,
    });
    assert.match(merged, /"ok":true/, merged);
    assert.equal(await fs.readFile(path.join(tree, 'app.txt'), 'utf8'), 'v2\n',
      'the merge landed in the project tree ON THE SYSTEM');
    assert.equal(await exists(path.join(tree, 'added.txt')), true);

    // ── 9. Unregister. D11: the tree survives byte for byte.
    const before = await snapshotTree(tree);
    const del = await api(baseUrl, 'DELETE', '/api/projects/app');
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.system, remote.id);
    assert.equal(del.body.unregisteredOnly, true,
      'the response says the tree was left alone, so the UI can too');
    assertTreeUnchanged(assert, before, await snapshotTree(tree),
      'the remote tree is byte-identical after unregistering');
    assert.equal((await api(baseUrl, 'GET', '/api/projects')).body.length, 0);

    // ── The whole lifecycle ran with no worker anywhere.
    assert.equal(instances.list().length, 0, 'no instance was ever created');
  });

  // PINS: adopting an existing repo on a system works through the same REST
  // route the UI posts to, and the project it produces is fully operable.
  test('adopt an existing repo on the system through the REST surface', async () => {
    const tree = await seedRepo(path.join(remote.root, 'existing'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', {
      name: 'existing', path: tree, system: remote.id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.system, remote.id);
    assert.equal(r.body.external, false, 'a remote adopt is not an `.external` one');
    assert.equal(await exists(path.join(projectsRoot(), '.external', 'existing')), false);

    // CONVENTIONS.md was delivered INTO THE TREE ON THE SYSTEM, as the adopt
    // contract promises for a local one.
    assert.equal(await exists(path.join(tree, 'CONVENTIONS.md')), true);
    assert.match(await fs.readFile(path.join(tree, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);

    const st = await callTool(baseUrl, 'project_status', { project: 'existing' });
    assert.match(st, /CONVENTIONS\.md/, 'the tree is readable through the tools');
    assert.equal(instances.list().length, 0);
  });

  // PINS: `list_projects` — the tool a conductor orients with — reports the
  // placement, so a conductor can see the project is not on cc's machine.
  test('list_projects names the system and the path on it', async () => {
    const tree = await seedRepo(path.join(remote.root, 'app'));
    await api(baseUrl, 'POST', '/api/projects/external', { name: 'app', path: tree, system: remote.id });
    const text = await callTool(baseUrl, 'list_projects', {});
    assert.match(text, new RegExp(`▸ app\\s+${tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, new RegExp(`system ${remote.id}`));
    assert.ok(!/! system unreachable/.test(text), 'a reachable system is not flagged');
  });

  // PINS: the whole flow still works when the provider advertises no optional
  // capability — the fallback is on the remote-project path too, not only in the
  // protocol suites.
  test('the same flow runs against a provider with its capabilities off', async () => {
    disposeSystemHandles();
    const degraded = await bindRemoteSystem({
      id: 'plainbox', flags: ['--no-process-group-signal'],
    });
    const tree = await seedRepo(path.join(degraded.root, 'app'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', {
      name: 'app', path: tree, system: degraded.id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await callTool(baseUrl, 'create_worktree', { project: 'app', name: 'feature' });
    const wt = (await api(baseUrl, 'GET', '/api/projects/app/worktrees')).body[0];
    assert.equal(wt.worktreePath, path.join(degraded.root, wt.worktreeName));
    const out = await callTool(baseUrl, 'project_bash', {
      project: 'app', worktree: wt.worktreeName, command: 'echo alive',
    });
    assert.match(out, /alive/);
    assert.equal(instances.list().length, 0);
  });
});
