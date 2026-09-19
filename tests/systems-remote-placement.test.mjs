// THE THIRD PLACEMENT: a project whose tree lives on another system.
//
// A remote project's tree is on another machine. Every branch that used to ask
// "in-root or external?" in the codebase is therefore a site that had to
// learn a third answer, and the failure mode being guarded against is not a
// crash — it is a call that composes a path under the LOCAL projects root,
// finds nothing there, and REPORTS SUCCESS while the real tree is untouched.
//
// So the fixture keeps the two path spaces disjoint: the system's trees live
// under a temp dir outside PROJECTS_ROOT. Any code that still reaches for
// `path.join(projectsRoot(), name)` lands where the tree is not, and the
// assertion below fails rather than passing by accident.
//
// One test per marked site, plus the record shapes the sites agree on.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git, snapshotTree, assertTreeUnchanged } from './remoteSystem.mjs';
import {
  createProject, deleteProject, adoptProject, getProject, listProjects,
  resolveProjectDir, projectsRoot, projectStoreDir,
} from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles, LOCAL_SYSTEM_ID } from '../src/systems/registry.ts';
import { liveSystemProto } from './systemHandle.mjs';

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function readRecord(name) {
  try { return JSON.parse(await fs.readFile(path.join(projectStoreDir(name), 'project.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

describe('remote project placement', () => {
  let home, remote;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // ── SITE 1: resolveProjectDir, the hub ───────────────────────────────

  // PINS: a record naming a system resolves to that system's path and that
  // system's handle — the whole reason every other site can be correct.
  test('the hub resolves a remote record to its system path and handle', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });

    const resolved = await resolveProjectDir('app');
    assert.equal(resolved.path, tree);
    assert.equal(resolved.system.id, remote.id);

    const proj = await getProject('app');
    assert.equal(proj.path, tree);
    assert.equal(proj.system.id, remote.id);
  });

  // PINS: the hub reads the RECORD, not the local filesystem — a directory
  // sitting at the local in-root name must not shadow the remote placement.
  // Without this the hub's in-root stat wins and every downstream operation
  // silently runs on cc's own machine.
  test('a local directory at the same name does not shadow the remote tree', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    // A decoy: same name, under the local projects root, with its own content.
    const decoy = path.join(projectsRoot(), 'app');
    await fs.mkdir(decoy, { recursive: true });
    await fs.writeFile(path.join(decoy, 'LOCAL_DECOY'), 'wrong machine\n');

    const resolved = await resolveProjectDir('app');
    assert.equal(resolved.path, tree, 'the remote path wins over a local directory of the same name');
    assert.equal(await exists(path.join(resolved.path, 'LOCAL_DECOY')), false);
  });

  // PINS: the RECORD is the registration, so a remote project stays resolvable
  // when its tree is gone. Without this, unregistering an unreachable tree
  // (D11's whole path) would 404.
  test('a remote project resolves even when the tree on the system is absent', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    await fs.rm(tree, { recursive: true, force: true });
    assert.equal((await getProject('app')).path, tree);
  });

  // PINS: a record naming a system with no path is refused BY NAME rather than
  // resolving to some path — there is no tree to place.
  test('a record cc cannot parse refuses 500, naming the file', async () => {
    await fs.mkdir(projectStoreDir('broken'), { recursive: true });
    await fs.writeFile(path.join(projectStoreDir('broken'), 'project.json'),
      JSON.stringify({ system: remote.id }));
    await assert.rejects(
      () => resolveProjectDir('broken'),
      (e) => e.statusCode === 500 && /malformed/.test(e.message),
    );
  });

  // ── SITE 2: listProjects' union ──────────────────────────────────────

  // PINS: the listing is store-derived, so a remote project is visible at all —
  // and carries the placement fields, with `path` being the path on the system.
  test('the listing carries a remote project with its path on the system', async () => {
    await createProject('localone');
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });

    const rows = await listProjects();
    assert.deepEqual(rows.map(r => r.name), ['app', 'localone']);
    const app = rows.find(r => r.name === 'app');
    assert.equal(app.system, remote.id);
    assert.equal(app.path, tree, 'the listing agrees with the hub about where the tree is');
    assert.equal(app.external, undefined, 'a project row carries no kind flag');
    const loc = rows.find(r => r.name === 'localone');
    assert.equal(loc.system, LOCAL_SYSTEM_ID);
    assert.equal(loc.path, path.join(projectsRoot(), 'localone'));
  });

  // PINS: a name with BOTH a remote record and a same-named local directory is
  // ONE project, and the record decides where it is. The decoy is what gives
  // this teeth — a resolver that still probed the projects root would answer
  // with the directory.
  test('a name with a remote record and a same-named local directory is listed once', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    await fs.mkdir(path.join(projectsRoot(), 'app'), { recursive: true });
    const rows = await listProjects();
    assert.deepEqual(rows.map(r => r.name), ['app']);
    assert.equal(rows[0].path, tree);
  });

  // The `.external` half of the old dedup is gone with the mechanism: there is
  // no second registration artefact left for a record to win against.

  // ── SITE 3: createProject ────────────────────────────────────────────

  // PINS: creating on a system does the mkdir, `git init` and the seed files ON
  // THE SYSTEM at the caller's path — and creates nothing under the local
  // projects root.
  test('create builds the tree on the system, and nothing locally', async () => {
    const tree = path.join(remote.root, 'app');
    const created = await createProject('app', {
      system: remote.id, systemPath: tree, conventionsDoc: '# conventions\n',
    });
    assert.equal(created.path, tree);
    assert.equal(created.system, remote.id);

    assert.equal(await exists(path.join(tree, '.git')), true, 'a repo, on the system');
    assert.equal(await fs.readFile(path.join(tree, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');
    assert.equal(await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8'), '# conventions\n');
    assert.equal(await exists(path.join(projectsRoot(), 'app')), false,
      'nothing is created under the local projects root');
    assert.deepEqual(await readRecord('app'),
      { location: { kind: 'remote', system: remote.id, remoteId: null, path: tree } });
  });

  // PINS: an unreachable system refuses the create and leaves NO record — a
  // registration for a project that was never built is a phantom.
  test('create on an unreachable system refuses and registers nothing', async () => {
    const { addSystem } = await import('../src/appSettings.ts');
    // Registered without a provider command: reachable to name, not to use.
    await addSystem({ id: 'namedonly', label: 'Named only' });
    await assert.rejects(
      () => createProject('app', { system: 'namedonly', systemPath: '/app' }),
      (e) => e.statusCode === 501 && /namedonly/.test(e.message),
    );
    assert.equal(await readRecord('app'), null);
    assert.equal((await listProjects()).length, 0);
  });

  // PINS: a path that already exists on the system is a 409, not a silent
  // adoption of whatever is there.
  test('create refuses a path that already exists on the system', async () => {
    const tree = path.join(remote.root, 'taken');
    await fs.mkdir(tree, { recursive: true });
    await assert.rejects(
      () => createProject('app', { system: remote.id, systemPath: tree }),
      (e) => e.statusCode === 409,
    );
    assert.equal(await readRecord('app'), null, 'a refused create leaves no record');
  });

  // PINS: the path must be absolute — a relative one would be resolved against
  // whatever cwd the provider happens to have.
  test('create refuses a relative systemPath', async () => {
    await assert.rejects(
      () => createProject('app', { system: remote.id, systemPath: 'app' }),
      (e) => e.statusCode === 400 && /absolute/.test(e.message),
    );
  });

  // ── SITE 4: deleteProject (D11) ──────────────────────────────────────

  // PINS D11: deleting a remote project UNREGISTERS it — the record and the
  // local store entry go, the remote tree is byte-identical, and the result
  // names the system it was unregistered from.
  test('delete unregisters only, and never touches the remote tree', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    await fs.writeFile(path.join(tree, 'work.txt'), 'user work\n');
    const before = await snapshotTree(tree);

    // A removal reaching the tree is the failure this exists to catch, at BOTH
    // layers: the System's own removal shapes and the shell it derives them
    // from. Wrapped on the LIVE handle's prototype, so it observes the handle
    // the registry actually hands out.
    const sys = (await getProject('app')).system;
    const proto = liveSystemProto(sys);
    const removals = [];
    const orig = { removeTree: proto.removeTree, unlink: proto.unlink, exec: proto.exec };
    proto.removeTree = function (p) { removals.push(`removeTree ${p}`); return orig.removeTree.call(this, p); };
    proto.unlink = function (p) { removals.push(`unlink ${p}`); return orig.unlink.call(this, p); };
    proto.exec = function (spec, o) {
      const cmd = 'argv' in spec ? spec.argv.join(' ') : spec.shell;
      if (/\brm\b|\bunlink\b/.test(cmd)) removals.push(`exec ${cmd}`);
      return orig.exec.call(this, spec, o);
    };
    let result;
    try { result = await deleteProject('app'); }
    finally { Object.assign(proto, orig); }

    assert.deepEqual(result,
      { name: 'app', path: tree, system: remote.id, remoteId: null, directoryDeleted: false });
    assert.deepEqual(removals, [], `no removal was issued on the system: ${removals.join('; ')}`);
    assertTreeUnchanged(assert, before, await snapshotTree(tree), 'the remote tree is byte-identical');

    assert.equal(await readRecord('app'), null, 'the record is gone');
    assert.equal(await exists(projectStoreDir('app')), false, 'the local store entry goes with it');
    assert.equal((await listProjects()).length, 0, 'and the project is unregistered');
  });

  // PINS: unregistering does not require the system to be reachable — a system
  // that is down must not strand its projects in the registry for ever.
  test('delete works when the system cannot be reached', async () => {
    const tree = path.join(remote.root, 'app');
    await createProject('app', { system: remote.id, systemPath: tree });
    const before = await snapshotTree(tree);
    const { updateSystem } = await import('../src/appSettings.ts');
    // Drop the provider command: the row still names the system, nothing reaches it.
    await updateSystem(remote.id, { launch: null });

    const result = await deleteProject('app');
    assert.equal(result.path, tree);
    assert.equal(result.system, remote.id);
    assertTreeUnchanged(assert, before, await snapshotTree(tree), 'the tree survives untouched');
    assert.equal((await listProjects()).length, 0);
  });

  // ── SITE 5: adoptProject ─────────────────────────────────────────────

  // PINS: adopting a repo that already exists on a system writes a RECORD whose
  // location names that system — the same one mechanism every project uses.
  test('adopt on a system records the placement', async () => {
    const tree = await seedRepo(path.join(remote.root, 'existing'));
    const r = await adoptProject('existing', tree, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, tree);
    assert.equal(r.system, remote.id);
    assert.equal(await exists(path.join(projectsRoot(), 'existing')), false,
      'nothing is written under the local projects root');
    assert.deepEqual(await readRecord('existing'),
      { location: { kind: 'remote', system: remote.id, remoteId: null, path: tree } });
    assert.equal((await getProject('existing')).path, tree);
  });

  // PINS: duplicates compare (system, path), not path alone — the same path on
  // two different machines is two different trees.
  test('the duplicate check is on (system, path), not path', async () => {
    const tree = await seedRepo(path.join(remote.root, 'shared'));
    assert.equal((await adoptProject('one', tree, { system: remote.id })).ok, true);
    assert.deepEqual(await readRecord('one'), { location: { kind: 'remote', system: remote.id, remoteId: null, path: tree } });

    const again = await adoptProject('two', tree, { system: remote.id });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'TARGET_ALREADY_MANAGED');
    assert.match(again.reason, /'one'/);

    const other = await bindRemoteSystem({ id: 'otherbox' });
    const elsewhere = await seedRepo(path.join(other.root, 'shared'));
    // Same LAST path segment, different system — and, more importantly, the
    // check must key on the system too.
    assert.equal((await adoptProject('three', elsewhere, { system: other.id })).ok, true);
    assert.deepEqual(await readRecord('three'), { location: { kind: 'remote', system: other.id, remoteId: null, path: elsewhere } });
  });

  // PINS: the local-projects-root containment tests are skipped for a remote
  // adopt — a path on another machine has no relationship to cc's own root,
  // even when the two strings match.
  test('a remote path equal to the local projects root is still adoptable', async () => {
    // The system's own copy of a directory whose path string equals the local
    // projects root would be refused by the local containment test.
    const mirrored = await seedRepo(path.join(remote.root, 'mirror'));
    const r = await adoptProject('mirror', mirrored, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await readRecord('mirror'), { location: { kind: 'remote', system: remote.id, remoteId: null, path: mirrored } });
    // And the local test still applies to a LOCAL adopt.
    const local = await adoptProject('inroot', projectsRoot(), {});
    assert.equal(local.ok, false);
    assert.equal(local.code, 'TARGET_ALREADY_MANAGED');
  });

  // PINS: validation runs ON THE SYSTEM — the record proves the plain tree
  // there was the one measured, and a path that exists only locally is NOT
  // found.
  test('adopt validates the target on the system, not locally', async () => {
    const notARepo = path.join(remote.root, 'plain');
    await fs.mkdir(notARepo, { recursive: true });
    const r = await adoptProject('plain', notARepo, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await readRecord('plain'), { location: { kind: 'remote', system: remote.id, remoteId: null, path: notARepo } });

    // A repo that exists on cc's own machine but not on the system must not be
    // adoptable onto the system: that is the wrong-machine read.
    const localOnly = await seedRepo(path.join(home, 'local-only-repo'));
    await fs.rm(path.join(remote.root, path.basename(localOnly)), { recursive: true, force: true });
    const q = await adoptProject('localonly', path.join(remote.root, 'nothing-here'), { system: remote.id });
    assert.equal(q.ok, false);
    assert.equal(q.code, 'TARGET_NOT_FOUND');
    assert.equal(await exists(localOnly), true);
  });

  // PINS: a subdirectory of a repo is refused on a system too — adopting one
  // would give every diff and worktree the wrong toplevel.
  test('adopt refuses a subdirectory of a repo on the system', async () => {
    const repo = await seedRepo(path.join(remote.root, 'repo'));
    const sub = path.join(repo, 'packages');
    await fs.mkdir(sub, { recursive: true });
    const r = await adoptProject('sub', sub, { system: remote.id });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TARGET_INSIDE_REPO');
    assert.match(r.reason, /toplevel/);
    assert.equal(await readRecord('sub'), null, 'a refused adopt records nothing');
  });

  // PINS: a system with no `git` binary adopts rather than 502s. Neither probe
  // answers there — the provider emits a protocol `error` frame and runGit
  // takes its classified-spawn-error branch — and it is only because
  // classifySpawnError resolves ENOENT (rather than EUNKNOWN) that it RETURNS
  // code 1 instead of throwing GIT_DID_NOT_RUN. The `rev-parse` regex matches
  // BOTH probes and fires on every match, so this also proves the allow branch
  // is reached with both of them unanswered.
  test('a system with no git binary adopts a plain directory rather than refusing', async () => {
    const tree = path.join(remote.root, 'nogit');
    await fs.mkdir(tree, { recursive: true });
    const { updateSystem } = await import('../src/appSettings.ts');
    const { flakyLaunch } = await import('./remoteSystem.mjs');
    await updateSystem(remote.id, { launch: flakyLaunch({ errorFrame: 'rev-parse', errorCode: 'ENOENT' }) });

    const r = await adoptProject('nogit', tree, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await readRecord('nogit'), { location: { kind: 'remote', system: remote.id, remoteId: null, path: tree } });
  });

  // ── SITE 6: createWorktree's parent directory ────────────────────────

  // PINS: a remote project's worktree DIRECTORY is created ON THE SYSTEM —
  // never under the local projects root, which would leave the directory here
  // while every git command ran there. One layout, `<root>/<project>/<key>`,
  // with only the root differing: a `.worktrees` beside the tree by default,
  // because cc owns no area on another machine.
  test('a worktree of a remote project lands on the system', async () => {
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);

    const wt = await createWorktree('app', { name: 'feature' });
    assert.equal(wt.worktreePath,
      path.posix.join(remote.root, '.worktrees', 'app', wt.worktreeName));
    assert.equal(await exists(path.join(wt.worktreePath, '.git')), true,
      'the checkout really exists there');
    assert.equal(await exists(path.join(projectsRoot(), wt.worktreeName)), false,
      'and nothing was created under the local projects root');
    assert.equal(await exists(path.join(projectsRoot(), '.worktrees', 'app', wt.worktreeName)), false,
      "a remote project's worktree is never created in cc's own local area");

    // git agrees it is a registered worktree of the remote repo.
    const list = await git(tree, 'worktree', 'list', '--porcelain');
    assert.match(list.stdout, new RegExp(`worktree ${wt.worktreePath}\\b`));
  });
});
