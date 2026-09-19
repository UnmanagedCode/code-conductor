// Migration 0037 — every project gets a `location` record, plugin checkouts move
// under `.plugins/`, local worktree checkouts move under `.worktrees/<project>/`,
// remote worktree registrations are dropped, and `.external/` goes.
//
// EVERY TEST NAMES THE STATE IT REPRODUCES, not just the behaviour it asserts.
// The crash-window cases build the on-disk state the interruption LEAVES —
// "between the plugin rename and the record write" is a directory at
// `.plugins/<name>` with nothing at `<root>/<name>` and no record — rather than
// injecting a fault mid-run, because a fixture is the interruption point and a
// seam is only an approximation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import * as m0037 from '../migrations/0037-project-location-records.mjs';

const STORE = '.code-conductor';
const BACKUP = 'migrated-backup-0037';
const LEDGER = 'migration-0037-unresolved.json';
const WORKTREES_DIR = '.worktrees';

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

async function mkRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-0037-'));
  return fs.realpath(dir);
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
}

const storeDir = (root, name) => path.join(root, STORE, 'projects', name);
const wtStore = (root, name, key) => path.join(storeDir(root, name), 'worktrees', key);
const recordOf = (root, name) => readJson(path.join(storeDir(root, name), 'project.json'));

// A real git repo with one commit — enough for `git worktree add/move`.
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

// A legacy worktree: `git worktree add` at the legacy sibling path, plus the
// legacy store registration keyed `<project>_worktree_<slug>`.
async function addLegacyWorktree(root, project, repo, slug, { base = null } = {}) {
  const key = `${project}_worktree_${slug}`;
  const dir = path.join(root, key);
  const from = base ? path.join(root, `${project}_worktree_${base}`) : repo;
  await git(from, 'worktree', 'add', '-q', dir, '-b', `code-conductor/${slug}`);
  await writeJson(path.join(wtStore(root, project, key), 'worktree.json'), {
    parentProject: project,
    parentPath: from,
    worktreeName: key,
    worktreePath: dir,
    branch: `code-conductor/${slug}`,
    baseBranch: 'main',
    baseSha: '0'.repeat(40),
    ...(base ? { baseWorktree: `${project}_worktree_${base}` } : {}),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });
  return { key, dir };
}

// ── the full fixture ──────────────────────────────────────────────────────
// Everything the plan's fixture list names, in one root, so a single run
// exercises every source, every refusal and every probe clause together.
async function buildFixture() {
  const root = await mkRoot();
  const outside = path.join(root, '..', path.basename(root) + '-outside');
  await fs.mkdir(outside, { recursive: true });
  const outsideReal = await fs.realpath(outside);
  const ext = path.join(root, '.external');
  await fs.mkdir(ext, { recursive: true });

  // 1. An in-root project with a real repo, a local worktree, and a two-deep
  //    chain hanging off that worktree.
  const inroot = await makeRepo(path.join(root, 'inroot'));
  const wtA = await addLegacyWorktree(root, 'inroot', inroot, 'a');
  const wtB = await addLegacyWorktree(root, 'inroot', inroot, 'b', { base: 'a' });

  // 2. An adopted project: a working `.external` symlink to a tree outside the
  //    root, whose own worktree checkout lives INSIDE `.external/`.
  const adoptedTarget = await makeRepo(path.join(outsideReal, 'adopted-repo'));
  await fs.symlink(adoptedTarget, path.join(ext, 'adopted'));
  const adoptedWtDir = path.join(ext, 'adopted_worktree_x');
  // Deliberately NOT a real git worktree: `git worktree move` refuses it, which
  // is the ledgered-move arm C2 has to converge around.
  await fs.mkdir(adoptedWtDir, { recursive: true });
  await writeJson(path.join(wtStore(root, 'adopted', 'adopted_worktree_x'), 'worktree.json'), {
    parentProject: 'adopted', parentPath: adoptedTarget,
    worktreeName: 'adopted_worktree_x', worktreePath: adoptedWtDir,
    branch: 'code-conductor/x', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });

  // 3. A BROKEN `.external` symlink — the target was deleted out-of-band.
  await fs.symlink(path.join(outsideReal, 'vanished'), path.join(ext, 'broken'));

  // 4. A remote record, with a registered remote worktree and a second
  //    registration that has NO worktree.json at all (writeMeta is a
  //    non-atomic mkdir + writeFile, so this state exists today).
  await writeJson(path.join(storeDir(root, 'boxproj'), 'project.json'),
    { system: 'box', remoteId: 'c1', systemPath: '/srv/app' });
  await writeJson(path.join(wtStore(root, 'boxproj', 'boxproj_worktree_r'), 'worktree.json'), {
    parentProject: 'boxproj', parentPath: '/srv/app',
    worktreeName: 'boxproj_worktree_r', worktreePath: '/srv/boxproj_worktree_r',
    branch: 'code-conductor/r', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });
  await fs.mkdir(wtStore(root, 'boxproj', 'boxproj_worktree_nojson'), { recursive: true });

  // 5. A remote record with NO systemPath — not a placement, unreconstructable.
  await writeJson(path.join(storeDir(root, 'nopath'), 'project.json'), { system: 'box' });

  // 6. A workspace-only record whose tree is gone: no directory, no link.
  await writeJson(path.join(storeDir(root, 'ghost'), 'project.json'), { workspace: 'X' });

  // 7. A plugin checkout in the root.
  await fs.mkdir(path.join(root, 'code-share'), { recursive: true });
  await writeJson(path.join(root, 'code-share', 'conductor.plugin.json'), { id: 'code-share' });

  // 8. A plugin checkout that HAS a registered worktree — moving its main
  //    checkout would invalidate the worktree's gitdir back-reference.
  await fs.mkdir(path.join(root, 'code-hub'), { recursive: true });
  await writeJson(path.join(root, 'code-hub', 'conductor.plugin.json'), { id: 'code-hub' });
  await writeJson(path.join(wtStore(root, 'code-hub', 'code-hub_worktree_h'), 'worktree.json'), {
    parentProject: 'code-hub', parentPath: path.join(root, 'code-hub'),
    worktreeName: 'code-hub_worktree_h', worktreePath: path.join(root, 'code-hub_worktree_h'),
    branch: 'code-conductor/h', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });

  // 9. A directory whose name fails NAME_RE and holds a plugin manifest.
  await fs.mkdir(path.join(root, 'foo bar'), { recursive: true });
  await writeJson(path.join(root, 'foo bar', 'conductor.plugin.json'), { id: 'foo-bar' });

  // 10. A directory whose name fails NAME_RE with no manifest.
  await fs.mkdir(path.join(root, 'has space'), { recursive: true });

  // 11. `.conduct`.
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });

  return { root, outsideReal, inroot, adoptedTarget, adoptedWtDir, wtA, wtB };
}

const logs = () => {
  const lines = [];
  return { log: (...a) => lines.push(a.join(' ')), lines };
};

// ── AC11 + the record half ────────────────────────────────────────────────

test('every project gets a location and no project tree moves', async () => {
  // INVARIANT: AC11 — after the migration every registered project resolves
  // from its record, and the trees themselves are where they were (inode
  // identity per tree, so a copy would not pass).
  const { root, inroot, adoptedTarget } = await buildFixture();
  const inrootIno = (await fs.stat(inroot)).ino;
  const adoptedIno = (await fs.stat(adoptedTarget)).ino;

  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, true);

  assert.deepEqual((await recordOf(root, 'inroot')).location, { kind: 'local', path: inroot });
  assert.deepEqual((await recordOf(root, 'adopted')).location, { kind: 'local', path: adoptedTarget });
  assert.deepEqual((await recordOf(root, 'boxproj')).location,
    { kind: 'remote', system: 'box', remoteId: 'c1', path: '/srv/app' });
  assert.equal((await fs.stat(inroot)).ino, inrootIno);
  assert.equal((await fs.stat(adoptedTarget)).ino, adoptedIno);
});

test('the plugin checkout moves to .plugins/<name> and its record follows', async () => {
  // INVARIANT: step 3 — a plugin's checkout leaves the projects root and its
  // record names the new path, so nothing resolves through the old one.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  const moved = path.join(root, '.plugins', 'code-share');
  assert.ok(await exists(path.join(moved, 'conductor.plugin.json')));
  assert.equal(await exists(path.join(root, 'code-share')), false);
  assert.deepEqual((await recordOf(root, 'code-share')).location, { kind: 'local', path: moved });
});

test(".external's symlinks are gone and each target survives as location.path", async () => {
  // INVARIANT: AC3 + step 6 — no symlink remains, and the adopted target is
  // addressable through the record instead.
  const { root, adoptedTarget } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.equal(await exists(path.join(root, '.external', 'adopted')), false);
  assert.equal(await exists(path.join(root, '.external', 'broken')), false);
  assert.deepEqual((await recordOf(root, 'adopted')).location, { kind: 'local', path: adoptedTarget });
});

test('a broken .external link becomes a relocatable record', async () => {
  // INVARIANT: source b's broken-link arm — the raw readlink target survives as
  // a record, so the project stays addressable and the adopt dialog's
  // relocation branch has something to repoint.
  const { root, outsideReal } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.deepEqual((await recordOf(root, 'broken')).location,
    { kind: 'local', path: path.join(outsideReal, 'vanished') });
});

test('a remote record with no systemPath moves to the backup dir', async () => {
  // INVARIANT: the unreconstructable case is MOVED ASIDE, never destroyed —
  // and removing the input is what lets C1 go green with no exclusion list.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.equal(await exists(path.join(storeDir(root, 'nopath'), 'project.json')), false);
  assert.deepEqual(
    await readJson(path.join(root, STORE, BACKUP, 'orphaned-records', 'nopath', 'project.json')),
    { system: 'box' });
});

test('a workspace-only record with no location source moves aside, and C1 goes green', async () => {
  // INVARIANT: a store row no source can locate. Without the move-aside C1 —
  // "every project.json has a location" — is permanently red and every boot
  // re-runs the whole migration.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.equal(await exists(path.join(storeDir(root, 'ghost'), 'project.json')), false);
  assert.deepEqual(
    await readJson(path.join(root, STORE, BACKUP, 'orphaned-records', 'ghost', 'project.json')),
    { workspace: 'X' });
  const second = await m0037.run({ root, log: logs().log });
  assert.equal(second.applied, false, 'C1 is green on the second run');
});

test('a directory whose name fails NAME_RE mints no record', async () => {
  // INVARIANT: step 1c — minting a record for `has space` would produce a
  // project the new listing filters out: registered nowhere, listed nowhere.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.equal(await exists(path.join(storeDir(root, 'has space'), 'project.json')), false);
  assert.ok(await exists(path.join(root, 'has space')), 'and the directory is left alone');
});

test('a non-NAME_RE directory holding a plugin manifest is neither moved nor left blocking the probe', async () => {
  // INVARIANT: step 3's enumeration scope, and step 1c's. Minting a record for
  // a name the listing filters out produces a project registered nowhere and
  // listed nowhere, and moving its tree into `.plugins/` would do that to a
  // directory nobody adopted. All three symptoms are asserted, because an
  // unscoped enumeration and an unscoped step 1c fail DIFFERENT ones.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.equal(await exists(path.join(root, '.plugins', 'foo bar')), false);
  assert.equal(await exists(path.join(storeDir(root, 'foo bar'), 'project.json')), false);
  assert.ok(await exists(path.join(root, 'foo bar', 'conductor.plugin.json')));
  const second = await m0037.run({ root, log: logs().log });
  assert.equal(second.applied, false);
});

// ── the authorised breaking drop ──────────────────────────────────────────

test('a pre-existing REMOTE worktree registration is dropped and its orphaned path is logged', async () => {
  // INVARIANT: step 2 — the migration cannot reach another machine to move a
  // checkout, so it FORGETS the registration and NAMES the directory it is
  // abandoning. Silently abandoning it would be worse than naming it.
  const { root } = await buildFixture();
  const l = logs();
  const r = await m0037.run({ root, log: l.log });
  assert.equal(await exists(wtStore(root, 'boxproj', 'boxproj_worktree_r')), false);
  assert.ok(l.lines.some(x => x.includes('/srv/boxproj_worktree_r')),
    'the orphaned checkout path is logged');
  assert.deepEqual(r.summary.droppedRemoteWorktrees.sort(),
    ['boxproj/boxproj_worktree_nojson', 'boxproj/boxproj_worktree_r']);
});

test('a remote registration with NO worktree.json still logs a derived orphan path', async () => {
  // INVARIANT: step 2's fallback. `writeMeta` is a non-atomic mkdir+writeFile,
  // so a registration directory with no json exists — and those are exactly the
  // rows most likely to be junk, so the logging obligation must not skip them.
  const { root } = await buildFixture();
  const l = logs();
  await m0037.run({ root, log: l.log });
  assert.equal(await exists(wtStore(root, 'boxproj', 'boxproj_worktree_nojson')), false);
  assert.ok(l.lines.some(x => x.includes('/srv/boxproj_worktree_nojson')),
    'the legacy sibling rule derives the path the json would have carried');
});

// ── local worktree relocation ─────────────────────────────────────────────

test('each LOCAL worktree moves under .worktrees/<project>/<key>, store key and worktree.json both rewritten', async () => {
  // INVARIANT: step 4 + AC6 — one layout for every local checkout, and the
  // store key, the `worktreeName` and the directory basename end up one string.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  const dest = path.join(root, '.worktrees', 'inroot', 'a');
  assert.ok(await exists(dest));
  assert.equal(await exists(path.join(root, 'inroot_worktree_a')), false);
  assert.equal(await exists(wtStore(root, 'inroot', 'inroot_worktree_a')), false);
  const meta = await readJson(path.join(wtStore(root, 'inroot', 'a'), 'worktree.json'));
  assert.equal(meta.worktreeName, 'a');
  assert.equal(meta.worktreePath, dest);
});

test('a CHAIN whose BASE is ledgered keeps the child\'s references valid — AND the dependents guard still fires', async () => {
  // INVARIANT: step 4's topological reference repair, asserted through its
  // CONSEQUENCE. The base's move is refused (its worktree is git-LOCKED), so it
  // keeps its legacy key and path; the child must then name that legacy
  // identity. A path-only assertion would pass while `listDependentWorktrees`
  // silently returned [] — which is a hole in AC9 itself — so the test calls
  // the dependents predicate and requires it to name the child.
  const { root, wtA } = await buildFixture();
  await git(wtA.dir, 'worktree', 'lock', wtA.dir);
  await m0037.run({ root, log: logs().log });

  assert.ok(await exists(wtStore(root, 'inroot', 'inroot_worktree_a')), 'the base keeps its legacy key');
  assert.ok(await exists(wtA.dir), 'and its checkout stays where it was');
  const child = await readJson(path.join(wtStore(root, 'inroot', 'b'), 'worktree.json'));
  assert.equal(child.baseWorktree, 'inroot_worktree_a');
  assert.equal(child.parentPath, wtA.dir);

  process.env.PROJECTS_ROOT = root;
  const { listDependentWorktrees } = await import('../src/worktrees.ts');
  assert.deepEqual(await listDependentWorktrees('inroot', 'inroot_worktree_a'), ['b'],
    'the dependents guard still fires on the base');
});

test('a CHAIN whose CHILD is ledgered still has its references repaired to the base\'s NEW identity', async () => {
  // INVARIANT: the mirror case. Repairing back-references is decoupled from
  // moving, so a checkout whose move was refused still gets correct references
  // — "derive from the base's final location" alone closes only one direction.
  const { root, inroot, wtB } = await buildFixture();
  await git(inroot, 'worktree', 'lock', wtB.dir);
  await m0037.run({ root, log: logs().log });

  assert.ok(await exists(wtStore(root, 'inroot', 'inroot_worktree_b')), 'the child keeps its legacy key');
  const child = await readJson(path.join(wtStore(root, 'inroot', 'inroot_worktree_b'), 'worktree.json'));
  assert.equal(child.baseWorktree, 'a', "and names the base's NEW key");
  assert.equal(child.parentPath, path.join(root, '.worktrees', 'inroot', 'a'));
});

// ── crash windows, reproduced as on-disk state ────────────────────────────

test('a run interrupted BETWEEN the plugin rename and the record write recovers', async () => {
  // STATE REPRODUCED: exactly the window between step 3's two fs calls — the
  // checkout sits at `.plugins/<name>`, nothing is at `<root>/<name>`, and NO
  // record exists (a plugin had none before this migration). Without source e
  // this is unrecoverable: no clause sees it — a records clause is vacuous with
  // no project.json on disk, and nothing about `<root>/<name>` is true of a
  // directory that has already been renamed away from it.
  const root = await mkRoot();
  await fs.mkdir(path.join(root, '.plugins', 'code-share'), { recursive: true });
  await writeJson(path.join(root, '.plugins', 'code-share', 'conductor.plugin.json'), { id: 'code-share' });

  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, true);
  assert.deepEqual((await recordOf(root, 'code-share')).location,
    { kind: 'local', path: path.join(root, '.plugins', 'code-share') });
});

test('a run interrupted BETWEEN the store rename and the worktree.json rewrite recovers', async () => {
  // STATE REPRODUCED: exactly the window between step 4's store rename and its
  // json rewrite — the store key is already the bare `a` while `worktree.json`
  // still carries `worktreeName: 'inroot_worktree_a'` and a `worktreePath`
  // pointing at the VACATED legacy directory. An infix-based completion probe
  // reads the key as done and never heals it.
  const root = await mkRoot();
  const repo = await makeRepo(path.join(root, 'inroot'));
  await writeJson(path.join(storeDir(root, 'inroot'), 'project.json'),
    { location: { kind: 'local', path: repo } });
  const dest = path.join(root, '.worktrees', 'inroot', 'a');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(repo, 'worktree', 'add', '-q', dest, '-b', 'code-conductor/a');
  await writeJson(path.join(wtStore(root, 'inroot', 'a'), 'worktree.json'), {
    parentProject: 'inroot', parentPath: repo,
    worktreeName: 'inroot_worktree_a',
    worktreePath: path.join(root, 'inroot_worktree_a'),
    branch: 'code-conductor/a', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });

  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, true);
  const meta = await readJson(path.join(wtStore(root, 'inroot', 'a'), 'worktree.json'));
  assert.equal(meta.worktreeName, 'a');
  assert.equal(meta.worktreePath, dest);
});

test('a run interrupted mid-record-rewrite completes on the next run', async () => {
  // STATE REPRODUCED: step 5 half-done — one record already in the new shape,
  // one still legacy. Source a′ reads the new one verbatim so the mixed-shape
  // store re-derives coherently instead of the new record falling through to
  // the legacy sources.
  const root = await mkRoot();
  const a = await makeRepo(path.join(root, 'alpha'));
  await fs.mkdir(path.join(root, 'beta'), { recursive: true });
  await writeJson(path.join(storeDir(root, 'alpha'), 'project.json'),
    { location: { kind: 'local', path: a } });

  await m0037.run({ root, log: logs().log });
  assert.deepEqual((await recordOf(root, 'alpha')).location, { kind: 'local', path: a });
  assert.deepEqual((await recordOf(root, 'beta')).location,
    { kind: 'local', path: path.join(root, 'beta') });
});

// ── ledger interactions ───────────────────────────────────────────────────

test('a refused plugin move ledgers the name and the probe still converges', async () => {
  // INVARIANT: step 3's registered-worktree refusal. Moving a main checkout
  // invalidates every worktree's gitdir back-reference, so the move is REFUSED
  // about the input and ledgered — and the ledger entry is what stops step 3
  // retrying it on every boot.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.ok(await exists(path.join(root, 'code-hub', 'conductor.plugin.json')),
    'the checkout is left in place');
  assert.equal(await exists(path.join(root, '.plugins', 'code-hub')), false);
  const ledger = await readJson(path.join(root, STORE, LEDGER));
  assert.ok(ledger.plugins.includes('code-hub'));
  const second = await m0037.run({ root, log: logs().log });
  assert.equal(second.applied, false, 'a ledgered refusal is a converged state');
});

test('a refused worktree move on an ADOPTED project leaves the checkout in .external/ and C2 still goes green', async () => {
  // INVARIANT: C2 must be "no SYMLINK remains", not "`.external` is absent".
  // An adopted project's worktree lives inside `.external/`; a ledgered move
  // leaves a real directory there and `fs.rmdir` on a non-empty directory
  // fails, so the absent-form clause could never go green.
  const { root, adoptedWtDir } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.ok(await exists(adoptedWtDir), 'the checkout stays where it was');
  const ledger = await readJson(path.join(root, STORE, LEDGER));
  assert.ok(ledger.worktrees.includes('adopted/adopted_worktree_x'));
  const entries = await fs.readdir(path.join(root, '.external'), { withFileTypes: true });
  assert.equal(entries.filter(e => e.isSymbolicLink()).length, 0);
  const second = await m0037.run({ root, log: logs().log });
  assert.equal(second.applied, false, 'C2 converges around the ledgered checkout');
});

// ── the conductor project, the snapshot and convergence ───────────────────

test('.conduct gets a record and stays hidden from list_projects', async () => {
  // INVARIANT: source d. `.conduct` is a registered project like any other now,
  // and the LISTING is what keeps it out of the sidebar rather than a dot-dir
  // skip on a filesystem walk.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  assert.deepEqual((await recordOf(root, '.conduct')).location,
    { kind: 'local', path: path.join(root, '.conduct') });
  process.env.PROJECTS_ROOT = root;
  const { listProjects } = await import('../src/projects.ts');
  const names = (await listProjects()).map(p => p.name);
  assert.ok(!names.includes('.conduct'));
  const withIt = (await listProjects({ includeConduct: true })).map(p => p.name);
  assert.ok(withIt.includes('.conduct'));
});

test('re-running writes NO second snapshot directory', async () => {
  // INVARIANT: the FIXED-path snapshot. A stamped name produced a backup
  // directory per boot, and a snapshot taken on a resumed run captures a
  // half-migrated store — worse than useless. This is the directly observable
  // form of "the probe converges".
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  await m0037.run({ root, log: logs().log });
  const backups = (await fs.readdir(path.join(root, STORE)))
    .filter(n => n.startsWith('migrated-backup'));
  assert.deepEqual(backups, [BACKUP]);
});

test('the snapshot holds every pre-migration record, .external target and worktree registration', async () => {
  // INVARIANT: nothing unreconstructable is destroyed — the `.external` targets
  // and the dropped remote registrations exist nowhere else after the run.
  const { root, adoptedTarget } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  const backup = path.join(root, STORE, BACKUP);
  const links = await readJson(path.join(backup, 'external-links.json'));
  assert.equal(links.adopted, adoptedTarget);
  const wts = await readJson(path.join(backup, 'initial-worktrees.json'));
  assert.equal(wts['boxproj/boxproj_worktree_r'].worktreePath, '/srv/boxproj_worktree_r');
  assert.deepEqual(await readJson(path.join(backup, 'projects', 'boxproj', 'project.json')),
    { system: 'box', remoteId: 'c1', systemPath: '/srv/app' });
});

test('re-running is a fast no-op', async () => {
  // INVARIANT: the convergence probe itself — all four clauses green on an
  // already-migrated store, so a full snapshot is not written on every boot.
  const { root } = await buildFixture();
  assert.equal((await m0037.run({ root, log: logs().log })).applied, true);
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

// ── a record that is PRESENT and UNREADABLE ───────────────────────────────

test('a TORN project.json with a locatable tree is healed, not skipped', async () => {
  // STATE REPRODUCED: the old `writeMeta` was a non-atomic mkdir + writeFile, so
  // a record half-written before a crash exists in the field. It is PRESENT and
  // unparseable — a state a reader that returns the same value for "absent" and
  // "unreadable" cannot tell from a row with no record at all, and therefore
  // skips: never located, never moved aside, never healed, while the records
  // clause reads it as red for ever.
  const root = await mkRoot();
  const tree = path.join(root, 'alpha');
  await fs.mkdir(tree, { recursive: true });
  await fs.mkdir(storeDir(root, 'alpha'), { recursive: true });
  await fs.writeFile(path.join(storeDir(root, 'alpha'), 'project.json'), '{ "workspace": "Dev", "worksp');

  assert.equal((await m0037.run({ root, log: logs().log })).applied, true);
  assert.deepEqual((await recordOf(root, 'alpha')).location, { kind: 'local', path: tree });
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false,
    'the records clause goes green — a torn record cannot wedge the probe');
});

test('a TORN project.json with NO locatable tree is moved aside, and the probe converges', async () => {
  // STATE REPRODUCED: the same torn write, for a legacy REMOTE record whose
  // project has no directory under the root — so no source can locate it. It
  // must reach the SAME terminal state an unlocatable readable row reaches
  // (moved aside, which removes the input) rather than being skipped for ever.
  const root = await mkRoot();
  await fs.mkdir(storeDir(root, 'boxproj'), { recursive: true });
  await fs.writeFile(path.join(storeDir(root, 'boxproj'), 'project.json'),
    '{"system":"box","systemPa');

  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, true);
  assert.deepEqual(r.summary.orphanedRecords, ['boxproj']);
  assert.equal(await exists(path.join(storeDir(root, 'boxproj'), 'project.json')), false);
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false,
    'three runs would otherwise report applied:true with records:0 for ever');
});

test('the snapshot holds a torn record\'s RAW BYTES, not a parsed shape', async () => {
  // STATE REPRODUCED: a torn record whose readable half carries a workspace the
  // migration cannot recover. Backing it up as the PARSED shape stores `{}` —
  // destroying the one input the snapshot exists for, at exactly the input
  // "never destroy data you can't reconstruct" is about.
  const root = await mkRoot();
  await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
  await fs.mkdir(storeDir(root, 'alpha'), { recursive: true });
  const torn = '{ "workspace": "Dev", "worksp';
  await fs.writeFile(path.join(storeDir(root, 'alpha'), 'project.json'), torn);

  await m0037.run({ root, log: logs().log });
  assert.equal(
    await fs.readFile(path.join(root, STORE, BACKUP, 'projects', 'alpha', 'project.json'), 'utf8'),
    torn);
});

// ── the fresh-install shortcut ────────────────────────────────────────────

test('a root holding ONLY a non-NAME_RE directory is not silently skipped', async () => {
  // STATE REPRODUCED: the pre-migration listing had no name filter on its
  // in-root loop, so `my proj` was a first-class listed project. It cannot be
  // migrated (the new listing filters it out), and step 1c promises it is
  // "skipped and logged" — but a shortcut that reads the root as EMPTY takes
  // it away with no snapshot, no log and no record. The same shape beside any
  // other project takes the full path and IS logged, so the silence is a
  // property of the shortcut rather than of the directory.
  const root = await mkRoot();
  await fs.mkdir(path.join(root, 'my proj'), { recursive: true });

  const l = logs();
  await m0037.run({ root, log: l.log });
  assert.ok(l.lines.some(x => x.includes('my proj')),
    `a project that cannot be migrated must be named: ${l.lines.join(' | ')}`);
});

// ── a ledgered row whose checkout really did move ─────────────────────────

test('a ledgered worktree whose checkout IS at the destination is adopted, not left legacy', async () => {
  // STATE REPRODUCED: `git worktree move` killed or timed out after it moved
  // the checkout but before its exit code was read, so the entry was ledgered
  // AND the checkout is at the destination. Run 2 must probe the destination
  // and adopt reality: a ledger entry that gates the dest-exists branch leaves
  // the store key legacy and `worktreePath` naming a vacated directory, and the
  // worktrees clause excludes ledgered rows, so it reads converged for ever.
  const root = await mkRoot();
  const repo = await makeRepo(path.join(root, 'inroot'));
  await writeJson(path.join(storeDir(root, 'inroot'), 'project.json'),
    { location: { kind: 'local', path: repo } });
  const dest = path.join(root, WORKTREES_DIR, 'inroot', 'a');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(repo, 'worktree', 'add', '-q', dest, '-b', 'code-conductor/a');
  const legacyKey = 'inroot_worktree_a';
  await writeJson(path.join(wtStore(root, 'inroot', legacyKey), 'worktree.json'), {
    parentProject: 'inroot', parentPath: repo,
    worktreeName: legacyKey, worktreePath: path.join(root, legacyKey),
    branch: 'code-conductor/a', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });
  await writeJson(path.join(root, STORE, LEDGER), { plugins: [], worktrees: [`inroot/${legacyKey}`] });

  await m0037.run({ root, log: logs().log });
  assert.ok(await exists(wtStore(root, 'inroot', 'a')), 'the store key follows the checkout');
  assert.equal(await exists(wtStore(root, 'inroot', legacyKey)), false);
  const meta = await readJson(path.join(wtStore(root, 'inroot', 'a'), 'worktree.json'));
  assert.equal(meta.worktreeName, 'a');
  assert.equal(meta.worktreePath, dest, 'and no longer names the vacated directory');
});

// ── a LOCAL registration with no worktree.json ────────────────────────────

test('a LOCAL registration with NO worktree.json is derived from the legacy rule, not skipped', async () => {
  // STATE REPRODUCED: `writeMeta` is a non-atomic mkdir + writeFile, so a
  // registration directory with no json exists. Skipping the row leaves the
  // LEGACY store key standing — and `registeredPlaces` re-derives the
  // transcript guard's cwd from that key through `worktreePathFor`, so the
  // guard would point into `.worktrees/` while the checkout sits at the legacy
  // path: the exact guard/reality divergence the re-derivation exists to
  // prevent. The path comes from the LEGACY RULE (`<root>/<key>` for a project
  // whose tree is in the root), the checkout moves, and the store key follows.
  // Nothing is fabricated: the row still has no json, so `listWorktrees` still
  // drops it — what is repaired is WHERE its key points.
  const root = await mkRoot();
  const repo = await makeRepo(path.join(root, 'inroot'));
  await writeJson(path.join(storeDir(root, 'inroot'), 'project.json'),
    { location: { kind: 'local', path: repo } });
  const legacyKey = 'inroot_worktree_nojson';
  const legacyDir = path.join(root, legacyKey);
  await git(repo, 'worktree', 'add', '-q', legacyDir, '-b', 'code-conductor/nojson');
  await fs.mkdir(wtStore(root, 'inroot', legacyKey), { recursive: true });

  assert.equal((await m0037.run({ root, log: logs().log })).applied, true);
  const dest = path.join(root, WORKTREES_DIR, 'inroot', 'nojson');
  assert.ok(await exists(dest), 'the checkout moved to the new layout');
  assert.equal(await exists(legacyDir), false);
  assert.ok(await exists(wtStore(root, 'inroot', 'nojson')), 'and the store key followed it');
  assert.equal(await exists(wtStore(root, 'inroot', legacyKey)), false);
  assert.equal(await exists(path.join(wtStore(root, 'inroot', 'nojson'), 'worktree.json')), false,
    'no metadata is fabricated for a row that had none');

  // THE CONSEQUENCE: the transcript guard re-derives this row's cwd from its
  // store key, and that derivation must now name where the checkout actually is.
  process.env.PROJECTS_ROOT = root;
  const { registeredPlaces } = await import('../src/systems/transcriptKey.ts');
  const place = (await registeredPlaces()).find(pl => pl.worktree === 'nojson');
  assert.ok(place, 'the registration is still a place the guard knows about');
  assert.equal(place.cwd, dest);

  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

test('a LOCAL worktree whose checkout is GONE keeps its registration, rekeyed and repaired', async () => {
  // STATE REPRODUCED: the checkout was removed out-of-band while its
  // registration survived — step 4's "nothing to move" arm. The row must still
  // be rekeyed and its json rewritten, or it holds a legacy key the transcript
  // guard re-derives a cwd from while `worktree.json` names a directory that
  // does not exist.
  const root = await mkRoot();
  const repo = await makeRepo(path.join(root, 'inroot'));
  await writeJson(path.join(storeDir(root, 'inroot'), 'project.json'),
    { location: { kind: 'local', path: repo } });
  const legacyKey = 'inroot_worktree_gone';
  await writeJson(path.join(wtStore(root, 'inroot', legacyKey), 'worktree.json'), {
    parentProject: 'inroot', parentPath: repo,
    worktreeName: legacyKey, worktreePath: path.join(root, legacyKey),
    branch: 'code-conductor/gone', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });

  await m0037.run({ root, log: logs().log });
  const meta = await readJson(path.join(wtStore(root, 'inroot', 'gone'), 'worktree.json'));
  assert.equal(meta.worktreeName, 'gone');
  assert.equal(meta.worktreePath, path.join(root, WORKTREES_DIR, 'inroot', 'gone'));
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

// ── THE PROBE, IN THE ONLY REGIME IT EVER RUNS IN ─────────────────────────
//
// `run` short-circuits on the completion marker — `if (completed && await
// converged(...))` — so every clause in the probe is consulted ONLY after a
// completed migration. A fixture that is pre-marker, or single-run, exercises
// the pipeline with the probe bypassed: it can show a clause GREEN, never that
// a clause is what noticed. These build the regime instead: migrate, break ONE
// thing, and require the next boot to read not-converged AND act on it.
//
// Both assertions are needed on every one of them. `applied` alone would pass
// for a probe that is red about something else; the repair alone would pass for
// a pipeline that runs unconditionally.

// Migrate a root to completion — the marker is what these tests are about, so
// it is asserted rather than assumed.
async function migrated(root) {
  assert.equal((await m0037.run({ root, log: logs().log })).applied, true, 'fixture must migrate');
  assert.ok(await exists(path.join(root, STORE, 'migration-0037-complete.json')),
    'fixture must be POST-marker, or the probe is bypassed and proves nothing');
}

test('post-marker: a record that lost its location makes the probe act, and is healed', async () => {
  // STATE REPRODUCED: a completed store whose record was hand-edited, or half
  // written by something else, back to a shape with no `location`. Nothing else
  // is wrong — no `.external`, no torn worktree row — so the RECORDS clause is
  // the only thing that can notice, and a boot that reads converged leaves the
  // project unregistered for ever.
  const root = await mkRoot();
  const tree = path.join(root, 'alpha');
  await fs.mkdir(tree, { recursive: true });
  await migrated(root);
  await writeJson(path.join(storeDir(root, 'alpha'), 'project.json'), { workspace: 'Keep' });

  assert.equal((await m0037.run({ root, log: logs().log })).applied, true,
    'the records clause must read not-converged');
  const rec = await recordOf(root, 'alpha');
  assert.deepEqual(rec.location, { kind: 'local', path: tree }, 'and the next boot heals it');
  assert.equal(rec.workspace, 'Keep', 'without losing what the record still carried');
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

test('post-marker: a torn worktree row makes the probe act, and is repaired', async () => {
  // STATE REPRODUCED: a completed store in which a `worktree.json` disagrees
  // with its own store key and names a VACATED directory — the crash window
  // between the store rename and the json rewrite, reached here through the
  // probe rather than past it. Every record has a location, so the records
  // clause is green and only the torn-row detector can notice.
  const root = await mkRoot();
  const repo = await makeRepo(path.join(root, 'inroot'));
  const legacyDir = path.join(root, 'inroot_worktree_a');
  await git(repo, 'worktree', 'add', '-q', legacyDir, '-b', 'code-conductor/a');
  await writeJson(path.join(wtStore(root, 'inroot', 'inroot_worktree_a'), 'worktree.json'), {
    parentProject: 'inroot', parentPath: repo,
    worktreeName: 'inroot_worktree_a', worktreePath: legacyDir,
    branch: 'code-conductor/a', baseBranch: 'main', baseSha: '0'.repeat(40),
    createdAt: new Date(2020, 0, 1).toISOString(),
  });
  await migrated(root);
  const dest = path.join(root, WORKTREES_DIR, 'inroot', 'a');
  assert.ok(await exists(dest), 'fixture: the checkout is at the new layout after the first run');

  // Tear it: the store key stays bare while the json reverts to naming the
  // vacated directory. An infix-only detector reads this as DONE.
  const metaPath = path.join(wtStore(root, 'inroot', 'a'), 'worktree.json');
  await writeJson(metaPath, { ...(await readJson(metaPath)), worktreeName: 'inroot_worktree_a', worktreePath: legacyDir });

  assert.equal((await m0037.run({ root, log: logs().log })).applied, true,
    'the torn-row detector must read not-converged');
  const healed = await readJson(metaPath);
  assert.equal(healed.worktreeName, 'a');
  assert.equal(healed.worktreePath, dest, 'and no longer names the vacated directory');
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

test('post-marker: a leftover .external symlink makes the probe act, and is unlinked', async () => {
  // STATE REPRODUCED: step 6 unlinks one symlink at a time, so a crash inside
  // it leaves symlinks behind in a store whose records were already written by
  // step 5 — the one way a symlink exists post-marker, since nothing creates
  // them any more. The `.external` clause is the only thing that can notice: a
  // dangling registration mechanism would otherwise sit there for ever, and the
  // resolver would keep disagreeing with what is on disk.
  const root = await mkRoot();
  await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
  await migrated(root);

  const ext = path.join(root, '.external');
  await fs.mkdir(ext, { recursive: true });
  await fs.symlink(path.join(root, 'alpha'), path.join(ext, 'leftover'));

  assert.equal((await m0037.run({ root, log: logs().log })).applied, true,
    'the .external clause must read not-converged');
  assert.equal(await exists(path.join(ext, 'leftover')), false, 'and the next boot unlinks it');
  assert.ok(await exists(path.join(root, 'alpha')), 'the link target is never followed');
  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
});

test('a directory created under the projects root AFTER the migration completes does not become a project', async () => {
  // INVARIANT: the completion marker's reason for existing, from the side the
  // structural clauses cannot cover. The in-root backfill is a ONE-TIME source;
  // once the migration has completed, a directory in the root is a grouping
  // directory — exactly what the new model exists to allow — and a second run
  // must not mint a record for it.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  await fs.mkdir(path.join(root, 'container', 'nested'), { recursive: true });

  const second = await m0037.run({ root, log: logs().log });
  assert.equal(second.applied, false);
  assert.equal(await exists(path.join(storeDir(root, 'container'), 'project.json')), false);
});

test('a plugin repo cloned into the projects root AFTER the migration is left alone, for ever', async () => {
  // STATE REPRODUCED: a completed migration, then a user clones a plugin repo to
  // `<root>/someplugin`. Under the new model that is an unregistered directory —
  // not a project and not a plugin until a human adopts it. A probe clause that
  // goes red over a root `conductor.plugin.json` has NO step that can clear it:
  // the only enumeration reaching a root-level manifest dir is the in-root scan,
  // which is backfill-gated, so the directory is never moved, never ledgered and
  // never excluded, and every boot re-runs the whole pipeline for ever.
  const { root } = await buildFixture();
  await m0037.run({ root, log: logs().log });

  await fs.mkdir(path.join(root, 'someplugin'), { recursive: true });
  await writeJson(path.join(root, 'someplugin', 'conductor.plugin.json'), { id: 'someplugin' });

  for (const n of [1, 2, 3]) {
    assert.equal((await m0037.run({ root, log: logs().log })).applied, false, `run ${n} must be a no-op`);
  }
  assert.equal(await exists(path.join(storeDir(root, 'someplugin'), 'project.json')), false,
    'no record is minted for a directory nobody adopted');
  assert.ok(await exists(path.join(root, 'someplugin', 'conductor.plugin.json')),
    'and the directory is left exactly where the user put it');
  assert.equal(await exists(path.join(root, '.plugins', 'someplugin')), false);
});

test("an in-root project that acquires a manifest is not relocated out from under its owner", async () => {
  // STATE REPRODUCED: a migrated project whose tree sits in the root gains a
  // `conductor.plugin.json` — a plugin repo adopted there, or a project that
  // grew a manifest. A red clause here does not merely re-run the pipeline: the
  // re-run's step 3 `fs.rename`s the user's own tree into `.plugins/<name>` and
  // repoints the record at it. Relocating a user's directory is not something a
  // migration may do on a boot after it has completed.
  const { root, inroot } = await buildFixture();
  await m0037.run({ root, log: logs().log });
  const inode = (await fs.stat(inroot)).ino;

  await writeJson(path.join(inroot, 'conductor.plugin.json'), { id: 'inroot-plug' });

  assert.equal((await m0037.run({ root, log: logs().log })).applied, false);
  assert.equal((await fs.stat(inroot)).ino, inode, 'the tree did not move');
  assert.deepEqual((await recordOf(root, 'inroot')).location, { kind: 'local', path: inroot });
  assert.equal(await exists(path.join(root, '.plugins', 'inroot')), false);
});

test('a legacy store of bare in-root directories is migrated, not read as already converged', async () => {
  // INVARIANT: the completion marker's OTHER side, and the commonest install
  // there is. Before this change a project was registered by its DIRECTORY, so
  // such a store holds no `project.json` at all — every structural clause is
  // vacuously green, and without the marker the whole chain no-ops while every
  // project disappears from a store-derived listing.
  const root = await mkRoot();
  await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
  await fs.mkdir(path.join(root, 'beta'), { recursive: true });

  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, true);
  assert.deepEqual((await recordOf(root, 'alpha')).location, { kind: 'local', path: path.join(root, 'alpha') });
  assert.deepEqual((await recordOf(root, 'beta')).location, { kind: 'local', path: path.join(root, 'beta') });
});

test('a store with no projects at all is not applied', async () => {
  // INVARIANT: a fresh install has nothing to migrate and must not report a
  // migration — nor create a backup directory it will never use.
  const root = await mkRoot();
  const r = await m0037.run({ root, log: logs().log });
  assert.equal(r.applied, false);
  assert.equal(await exists(path.join(root, STORE, BACKUP)), false);
});
