// DELETE MEANS DEREGISTER. The record goes; the tree stays unless the caller
// ticks `deleteDirectory`, and for a project on another machine there is no
// tick at all — cc removes its record of a tree it does not own, never the
// tree.
//
// The cascade REFUSES rather than force-removing: a worktree that is dirty,
// dirty-unknown or depended-on 409s the whole delete. That is what
// `removeAllWorktreesForProject`'s `force:false` buys, and the switch is inert
// without the dirty arm below.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import {
  adoptProject, deleteProject, listProjects, readProjectRecord, registerProject,
  projectStoreDir, localWorktreesRoot,
} from '../src/projects.ts';
import { createWorktree, listWorktrees } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

async function makeProject(name) {
  const dir = await makeRepo(path.join(projectsRoot, name));
  await registerLocalProject(name, dir);
  return dir;
}

const del = (name, body) => api(baseUrl, 'DELETE', `/api/projects/${encodeURIComponent(name)}`, body ?? {});

// ── AC8: the tree stays unless the caller asks ─────────────────────────────

// PINS: AC8, at its sharpest blast radius. The old behaviour `rm -rf`'d an
// in-root project unconditionally; the default now leaves the tree on disk.
test('deleting a local in-root project leaves its directory on disk', async () => {
  const dir = await makeProject('demo');
  const r = await del('demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.directoryDeleted, false);
  assert.ok((await fs.stat(dir)).isDirectory(), 'the tree survives');
  assert.equal(await readProjectRecord('demo'), null, 'and the project is deregistered');
  assert.deepEqual((await listProjects()).map(p => p.name), []);
});

// PINS: the opt-in actually works — a default-only implementation passes the
// test above and fails this one.
test('deleteDirectory:true removes it', async () => {
  const dir = await makeProject('demo');
  const r = await del('demo', { deleteDirectory: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.directoryDeleted, true);
  await assert.rejects(() => fs.stat(dir), 'the tree is gone');
});

// PINS: AC8's second half. cc owns no area on another machine, so the opt-in is
// refused rather than quietly ignored — an ignored tick would tell the user the
// removal happened.
test('deleteDirectory:true on a remote project is refused 400', async () => {
  await registerProject('boxproj', { kind: 'remote', system: 'box', remoteId: null, path: '/srv/app' });
  const r = await del('boxproj', { deleteDirectory: true });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(await readProjectRecord('boxproj'), 'and the refusal wrote nothing');
});

// PINS: an adopted project's tree survives the default delete exactly as an
// in-root one does — one behaviour for every project, which is only safe
// because it is the non-destructive one.
test('deleting an adopted project leaves the user\'s repo untouched', async () => {
  const outside = await makeRepo(path.join(home, 'my-repo'));
  const real = await fs.realpath(outside);
  assert.equal((await adoptProject('ext', outside)).ok, true);
  const r = await del('ext');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await fs.stat(real)).isDirectory());
  assert.equal(await readProjectRecord('ext'), null);
});

// ── AC9: the cascade refuses ───────────────────────────────────────────────

// PINS: AC9's dirty arm — THE test the `force:false` switch exists for. Under
// `force:true` the cascade skips the entire guard block and this passes a
// delete that throws away uncommitted work.
test('a dirty worktree refuses the delete and the project still lists', async () => {
  await makeProject('demo');
  const wt = await createWorktree('demo');
  await fs.writeFile(path.join(wt.worktreePath, 'dirty.txt'), 'uncommitted\n');

  const r = await del('demo');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /uncommitted changes/);
  assert.deepEqual((await listProjects()).map(p => p.name), ['demo'], 'the project is still registered');
  assert.ok((await fs.stat(wt.worktreePath)).isDirectory(), 'and its checkout is untouched');
});

// PINS: the dirty-UNKNOWN half. A check that FAILED is not a check that passed,
// and the checkout exists — so there IS uncommitted work this delete could
// destroy without having measured it.
test('a worktree whose dirty check fails on an EXISTING checkout refuses', async () => {
  await makeProject('demo');
  const wt = await createWorktree('demo');
  // Break git INSIDE the checkout while leaving BOTH the directory and the
  // parent's registration of it in place: the checkout still exists and the
  // parent is still a repo, so the "nothing to protect" discrimination does not
  // fire — but `git status` in the worktree cannot answer.
  await fs.writeFile(path.join(wt.worktreePath, '.git'), 'gitdir: /nonexistent-gitdir\n');

  const r = await del('demo');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok((await fs.stat(wt.worktreePath)).isDirectory());
});

// PINS: the dependents half. `listDependentWorktrees` matches `baseWorktree`
// LITERALLY, and a reference matching nothing yields an EMPTY list rather than
// an error — so this also pins that the guard is actually reachable.
test('a depended-on worktree refuses', async () => {
  await makeProject('demo');
  const base = await createWorktree('demo', { name: 'base' });
  await fs.writeFile(path.join(base.worktreePath, 'f.txt'), 'x\n');
  await git(base.worktreePath, 'add', '.');
  await git(base.worktreePath, 'commit', '-q', '-m', 'base work');
  await createWorktree('demo', { baseWorktree: 'base', name: 'child' });

  const r = await del('demo');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /is the base for/);
  assert.deepEqual((await listProjects()).map(p => p.name), ['demo']);
});

// PINS: AC9 AS AMENDED — the ABSENCE of an ahead/unmerged check. Removing a
// worktree does not delete its branch, so committed work survives in the
// project repo's shared object store; only UNCOMMITTED work lives solely in the
// checkout, and that is exactly what dirty / dirty-unknown covers.
test('a worktree that is merely AHEAD does not refuse', async () => {
  await makeProject('demo');
  const wt = await createWorktree('demo', { name: 'ahead' });
  await fs.writeFile(path.join(wt.worktreePath, 'f.txt'), 'committed\n');
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'ahead of base');

  const r = await del('demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await readProjectRecord('demo'), null);
});

// PINS: the gone-tree trap. Without the "nothing to protect" discrimination the
// record resolves, `listWorktrees` gets no git filter so every registration
// lists, every dirty check fails as dirty-unknown, and the project becomes
// permanently undeletable — a regression against the old behaviour, where
// removeTree on an absent path was a silent success.
test('a project whose tree vanished out-of-band still deletes', async () => {
  const dir = await makeProject('demo');
  await createWorktree('demo');
  await rmrf(dir);

  const r = await del('demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await readProjectRecord('demo'), null);
});

// PINS: the discrimination itself, at one worktree rather than a whole vanished
// project — a checkout that is not there holds no uncommitted work, so its
// registration is DROPPED rather than refused.
test('a worktree whose checkout is gone is dropped, not refused', async () => {
  await makeProject('demo');
  const wt = await createWorktree('demo');
  await rmrf(wt.worktreePath);

  const r = await del('demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await readProjectRecord('demo'), null);
});

// ── the cc-owned half cc DOES remove ───────────────────────────────────────

// PINS: cc's own worktree area for the project goes with it, whether or not the
// tree did. Its checkouts are cc-created, so leaving them would orphan a
// directory nobody can reach through a record any more.
test('delete removes <root>/.worktrees/<project>/', async () => {
  await makeProject('demo');
  const wt = await createWorktree('demo');
  const projWorktrees = path.join(localWorktreesRoot(), 'demo');
  assert.ok(wt.worktreePath.startsWith(projWorktrees + path.sep), wt.worktreePath);
  assert.ok((await fs.stat(projWorktrees)).isDirectory());

  assert.equal((await del('demo')).status, 200);
  await assert.rejects(() => fs.stat(projWorktrees));
  await assert.rejects(() => fs.stat(projectStoreDir('demo')), 'and the store entry');
});

// PINS: a REMOTE project's worktree registrations are dropped and nothing on
// the system is touched — the D11 shape, unchanged.
test('a remote project\'s worktree registrations are dropped with no git run', async () => {
  await registerProject('boxproj', { kind: 'remote', system: 'box', remoteId: null, path: '/srv/app' });
  const store = path.join(projectStoreDir('boxproj'), 'worktrees', 'r');
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, 'worktree.json'), JSON.stringify({
    parentProject: 'boxproj', parentPath: '/srv/app', worktreeName: 'r',
    worktreePath: '/srv/.worktrees/boxproj/r', branch: 'code-conductor/r',
    baseBranch: 'main', baseSha: '0'.repeat(40), createdAt: new Date().toISOString(),
  }));

  const r = await del('boxproj');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await readProjectRecord('boxproj'), null);
  assert.deepEqual(await listWorktrees('boxproj').catch(() => []), []);
});
