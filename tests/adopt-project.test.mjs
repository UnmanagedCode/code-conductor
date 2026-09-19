// ADOPTING A DIRECTORY AS A PROJECT. Nothing is copied or moved and no symlink
// is written: the record in `<store>/projects/<name>/project.json` is the whole
// registration, wherever the tree lives.
//
// Every assertion about the target path compares against `await
// fs.realpath(target)`, never the literal string — mkdtemp can hand back a path
// containing symlinks (it does on macOS), and a literal comparison would then
// pass or fail for reasons unrelated to the code under test.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import {
  adoptProject, getProject, listProjects, deleteProject,
  encodeCwd, findSessionLocation, validateName, projectStoreDir,
  readProjectRecord, orchStoreRoot, localWorktreesRoot, pluginsRoot, localPlace,
} from '../src/projects.ts';
import { createWorktree, listWorktrees } from '../src/worktrees.ts';
import { ensureProjectConventionsMd, regenerateAllProjectConventions } from '../src/projectClaudeMd.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SRC_DIR = path.resolve(__dirname, '..', 'src');

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  claudeProjectsRoot = r.claudeProjectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// A real git repo OUTSIDE projectsRoot (`<home>/<dirName>`) but still under
// `home`, so teardown sweeps it up.
async function makeOutsideRepo(dirName = 'outside-repo') {
  const repoPath = path.join(home, dirName);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# outside repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return { repoPath, real: await fs.realpath(repoPath) };
}

// A real repo at an arbitrary absolute path (used for the nested-container case).
async function makeRepoAt(repoPath) {
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return { repoPath, real: await fs.realpath(repoPath) };
}

async function makeInRootRepo(name) {
  const { repoPath } = await makeRepoAt(path.join(projectsRoot, name));
  await registerLocalProject(name, repoPath);
  return repoPath;
}

// ── the realpath rule ──────────────────────────────────────────────────────

// PINS: the record stores the target's REALPATH. The Claude CLI encodes its
// transcript directory from getcwd(), which is always the realpath, so a record
// holding a logical path would strand every session of the project.
test('an adopt whose target traverses a symlink records the PHYSICAL path', async () => {
  const { repoPath, real } = await makeOutsideRepo('physical-tree');
  const linkPath = path.join(home, 'link-to-tree');
  await fs.symlink(repoPath, linkPath);
  assert.notEqual(linkPath, real, 'the fixture really does traverse a symlink');

  const res = await adoptProject('vialink', linkPath);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, real);
  assert.deepEqual((await readProjectRecord('vialink')).location, { kind: 'local', path: real });
  assert.equal((await getProject('vialink')).path, real);
});

// PINS: the realpath rule reaches session location — the property the record
// exists to serve.
test('a session under encodeCwd(realpath) is located', async () => {
  const { repoPath, real } = await makeOutsideRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  const realDir = path.join(claudeProjectsRoot, encodeCwd(real));
  await fs.mkdir(realDir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  await fs.copyFile(FIXTURE_JSONL, path.join(realDir, `${sid}.jsonl`));
  assert.deepEqual(await findSessionLocation(sid),
    { project: 'ext', worktreeName: null, cwd: real, place: localPlace(real) });
});

// ── AC3: no `.external` anywhere ───────────────────────────────────────────

// PINS: AC3. Both halves — nothing is created at runtime, and no source file
// still names the old mechanism. A grep, in the style of
// tests/session-lineage-chokepoint.test.mjs, because a deleted builder leaves
// callers a typecheck catches but comments and docs it does not.
test('no .external directory is created, and no source file names EXTERNAL_DIRNAME', async () => {
  const { repoPath } = await makeOutsideRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);
  await assert.rejects(() => fs.lstat(path.join(projectsRoot, '.external')),
    'adopting creates no `.external` directory');

  const offenders = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
      const text = await fs.readFile(full, 'utf8');
      // `\.external\b`, not `\.external/`: a trailing slash misses every prose
      // mention of the mechanism, which is exactly where a stale comment lives.
      if (/EXTERNAL_DIRNAME|externalLinkPath\(|\.external\b/.test(text)) offenders.push(full);
    }
  };
  await walk(SRC_DIR);
  assert.deepEqual(offenders, []);
});

// ── AC2: nesting under the projects root is legal ──────────────────────────

// PINS: the INVERTED assertion of the deleted containment check. A directory
// under the projects root is only a project when a record says so, which is
// exactly what lets a container directory hold projects.
test('adopting a directory nested under the projects root succeeds', async () => {
  const { repoPath, real } = await makeRepoAt(path.join(projectsRoot, 'container', 'nested', 'app'));
  const res = await adoptProject('app', repoPath);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, real);
  const names = (await listProjects()).map(p => p.name);
  assert.deepEqual(names, ['app'], 'the container itself is not a project');
});

// PINS: TARGET_IS_CC_STATE, on ALL THREE roots. A two-root version passes a
// `.plugins` adopt — and a half-installed Library checkout really can sit there,
// because install's post-clone step is best-effort.
test('adopting the store root, .worktrees or .plugins is refused TARGET_IS_CC_STATE', async () => {
  for (const [label, dir] of [
    ['store', path.join(orchStoreRoot(), 'projects')],
    ['worktrees', path.join(localWorktreesRoot(), 'someproj')],
    ['plugins', path.join(pluginsRoot(), 'half-installed')],
  ]) {
    await fs.mkdir(dir, { recursive: true });
    const res = await adoptProject(`cc-${label}`, dir);
    assert.equal(res.ok, false, `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'TARGET_IS_CC_STATE', label);
  }
});

// PINS: the containment test that STAYS — a target enclosing the projects root
// would put every managed project inside one project.
test('adopting a directory that CONTAINS the projects root is still refused', async () => {
  const res = await adoptProject('everything', home);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'TARGET_ALREADY_MANAGED');
});

// PINS: the duplicate test runs for BOTH kinds now — a local record carries its
// path, so one directory can no longer hold two project identities.
test('adopting a path already held by a record is refused TARGET_ALREADY_MANAGED', async () => {
  const { repoPath, real } = await makeOutsideRepo();
  assert.equal((await adoptProject('first', repoPath)).ok, true);
  const again = await adoptProject('second', repoPath);
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(again.code, 'TARGET_ALREADY_MANAGED');
  assert.match(again.reason, /first/);
  assert.ok(again.reason.includes(real));
});

// ── the stale-record branch ────────────────────────────────────────────────

// PINS: a name held by a record whose path no longer resolves is NOT "pick
// another name" — the project moved, and the refusal carries what the caller
// needs to choose a repair.
test('a stale record refuses PROJECT_EXISTS_STALE carrying the held path', async () => {
  const { repoPath, real } = await makeOutsideRepo('moved-away');
  assert.equal((await adoptProject('app', repoPath)).ok, true);
  await rmrf(repoPath);
  const fresh = await makeOutsideRepo('new-home');

  const res = await adoptProject('app', fresh.repoPath);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PROJECT_EXISTS_STALE');
  assert.equal(res.heldPath, real);
  assert.ok(res.discards && typeof res.discards.worktrees === 'number');
});

// PINS: relocate repoints the record, KEEPS the store subtree, and invalidates
// the git-facts cache — those facts were measured at the old path, and serving
// them at the new one is a wrong answer rather than a stale one.
test("onStaleRecord:'relocate' repoints the record, keeps the store subtree, and invalidates the cache", async () => {
  const { repoPath } = await makeOutsideRepo('moved-away');
  assert.equal((await adoptProject('app', repoPath)).ok, true);
  const keepsake = path.join(projectStoreDir('app'), 'attachments', 'note.txt');
  await fs.mkdir(path.dirname(keepsake), { recursive: true });
  await fs.writeFile(keepsake, 'keep me\n');
  await rmrf(repoPath);
  const fresh = await makeOutsideRepo('new-home');

  // The suite pins the TTL at 0, which would make every read a recompute and
  // the assertion below vacuous — so give this one test a real TTL and put it
  // back afterwards.
  const cache = await import('../src/projectsCache.ts');
  cache._resetForTest(60_000);
  const key = cache.projectCacheKey('local', 'app');
  let computed = 0;
  const compute = async () => { computed++; return { marker: computed }; };
  await cache.getOrCompute(key, compute);
  await cache.getOrCompute(key, compute);
  assert.equal(computed, 1, 'a fresh entry really is served from the cache');

  try {
    const res = await adoptProject('app', fresh.repoPath, { onStaleRecord: 'relocate' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.path, fresh.real);
    assert.deepEqual((await readProjectRecord('app')).location, { kind: 'local', path: fresh.real });
    assert.equal(await fs.readFile(keepsake, 'utf8'), 'keep me\n', 'the store subtree survives');
    await cache.getOrCompute(key, compute);
    assert.equal(computed, 2, 'the facts measured at the OLD path are not served at the new one');
  } finally {
    cache._resetForTest(0);
  }
});

// PINS: AC10 ON THE RELOCATE PATH. `'relocate'` is the ONE registration that
// cannot go through `registerProject` — the name is held, by the very record
// being repointed — so the transcript-key guard it would have run has to be run
// explicitly. The duplicate-target loop above compares paths EXACTLY and passes
// here; `encodeCwd` folds `_` and `-` alike, so the two directories share one
// CLI transcript directory and their sessions interleave in it.
test("onStaleRecord:'relocate' still refuses a path that collides on the transcript key", async () => {
  const gone = await makeOutsideRepo('relocate-gone');
  assert.equal((await adoptProject('app', gone.repoPath)).ok, true);
  await rmrf(gone.repoPath);
  const holder = await makeOutsideRepo('a_b');
  assert.equal((await adoptProject('holder', holder.repoPath)).ok, true);
  const colliding = await makeOutsideRepo('a-b');
  assert.notEqual(colliding.real, holder.real, 'premise: two different directories');
  assert.equal(encodeCwd(colliding.real), encodeCwd(holder.real), 'premise: they encode alike');

  const res = await adoptProject('app', colliding.repoPath, { onStaleRecord: 'relocate' });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'TRANSCRIPT_DIR_COLLISION');
  assert.match(res.reason, /'holder'/);
  assert.equal((await readProjectRecord('app')).location.path, gone.real,
    'the refused relocation wrote nothing');
});

// PINS: the guard above does not refuse a LEGITIMATE relocation — the candidate
// skips its own identity, so the stale record being repointed cannot refuse its
// own replacement, and a relocate onto a free path still succeeds.
test("onStaleRecord:'relocate' is not refused by the record it is replacing", async () => {
  const gone = await makeOutsideRepo('self-gone');
  assert.equal((await adoptProject('app', gone.repoPath)).ok, true);
  await rmrf(gone.repoPath);
  const fresh = await makeOutsideRepo('self-fresh');

  const res = await adoptProject('app', fresh.repoPath, { onStaleRecord: 'relocate' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await readProjectRecord('app')).location.path, fresh.real);
});

// PINS: a project's tree moved and its WORKTREES did not — both directions of
// the back-reference between them are absolute paths into the old location.
// `git worktree repair` fixes the checkout's `.git` gitdir and the repo's own
// `worktrees/<id>/gitdir`; `parentPath` is the store's half, and it is what
// removal, the merge lifecycle and merge status all run git in. Without both, a
// relocated project's worktrees are broken while still listing as healthy.
test("onStaleRecord:'relocate' repairs the project's worktree back-references", async () => {
  const gone = await makeOutsideRepo('wt-gone');
  assert.equal((await adoptProject('app', gone.repoPath)).ok, true);
  const wt = await createWorktree('app', { name: 'feature' });
  assert.equal((await git(wt.worktreePath, 'status', '--porcelain')).stdout, '',
    'premise: the worktree is usable before the move');

  // The tree MOVES: same repo, new path — which is what a relocation is for.
  const moved = path.join(home, 'wt-moved');
  await fs.rename(gone.real, moved);
  const movedReal = await fs.realpath(moved);

  const res = await adoptProject('app', moved, { onStaleRecord: 'relocate' });
  assert.equal(res.ok, true, JSON.stringify(res));

  // The git half: the checkout's gitdir back-reference now resolves.
  await git(wt.worktreePath, 'status', '--porcelain');
  // The store half: every surface that runs git in `parentPath` now reaches the
  // tree rather than the path it left.
  const meta = (await listWorktrees('app')).find(w => w.worktreeName === 'feature');
  assert.ok(meta, 'the worktree still lists');
  assert.equal(meta.parentPath, movedReal);
});

// PINS: replace is the other branch — the store subtree goes.
test("onStaleRecord:'replace' discards the store subtree", async () => {
  const { repoPath } = await makeOutsideRepo('moved-away');
  assert.equal((await adoptProject('app', repoPath)).ok, true);
  const keepsake = path.join(projectStoreDir('app'), 'attachments', 'note.txt');
  await fs.mkdir(path.dirname(keepsake), { recursive: true });
  await fs.writeFile(keepsake, 'discard me\n');
  await rmrf(repoPath);
  const fresh = await makeOutsideRepo('new-home');

  const res = await adoptProject('app', fresh.repoPath, { onStaleRecord: 'replace' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual((await readProjectRecord('app')).location, { kind: 'local', path: fresh.real });
  await assert.rejects(() => fs.access(keepsake), 'the store subtree was discarded');
});

// PINS: a record whose path RESOLVES takes the ordinary refusal, verbatim — the
// stale branch must not swallow the common case.
test('a record whose path still resolves gets PROJECT_EXISTS and no stale branch', async () => {
  const { repoPath } = await makeOutsideRepo('still-here');
  assert.equal((await adoptProject('app', repoPath)).ok, true);
  const fresh = await makeOutsideRepo('other');

  const res = await adoptProject('app', fresh.repoPath);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PROJECT_EXISTS');
  assert.equal(res.heldPath, undefined);
});

// PINS: the undecidable case. On an unreachable system cc cannot tell a moved
// project from a machine that is merely down, so relocation is NOT offered —
// accepting it would repoint a perfectly good project because a box was off.
test('a held name on an unreachable system refuses PROJECT_EXISTS_UNRESOLVABLE', async () => {
  const { registerProject } = await import('../src/projects.ts');
  await registerProject('app', { kind: 'remote', system: 'no-such-system', remoteId: null, path: '/srv/app' });
  const fresh = await makeOutsideRepo('local-copy');

  const res = await adoptProject('app', fresh.repoPath);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'PROJECT_EXISTS_UNRESOLVABLE');
  // And the relocation is not silently taken either.
  const forced = await adoptProject('app', fresh.repoPath, { onStaleRecord: 'relocate' });
  assert.equal(forced.code, 'PROJECT_EXISTS_UNRESOLVABLE');
});

// ── the refusal contract ───────────────────────────────────────────────────

// PINS: every refusal is a returned code, never a 5xx, and nothing is written
// before the checks pass.
test('every adopt refusal returns a code, is not 5xx, and leaves no record behind', async () => {
  const { repoPath } = await makeOutsideRepo();
  const second = await makeOutsideRepo('second-repo');
  const plainDir = path.join(home, 'plain-dir');
  await fs.mkdir(plainDir, { recursive: true });
  const aFile = path.join(home, 'a-file.txt');
  await fs.writeFile(aFile, 'x');
  const subDir = path.join(repoPath, 'sub');
  await fs.mkdir(subDir, { recursive: true });
  const bareDir = path.join(home, 'bare.git');
  await fs.mkdir(bareDir, { recursive: true });
  await git(bareDir, 'init', '-q', '--bare');
  await makeInRootRepo('taken');

  const cases = [
    { name: 'has space', target: plainDir, code: 'INVALID_NAME' },
    { name: '.hidden', target: plainDir, code: 'INVALID_NAME' },
    { name: 'rel', target: 'relative/path', code: 'INVALID_TARGET_PATH' },
    { name: 'blank', target: '', code: 'INVALID_TARGET_PATH' },
    { name: 'gone', target: path.join(home, 'no-such-dir'), code: 'TARGET_NOT_FOUND' },
    { name: 'afile', target: aFile, code: 'TARGET_NOT_A_DIRECTORY' },
    { name: 'sub', target: subDir, code: 'TARGET_INSIDE_REPO' },
    { name: 'bare', target: bareDir, code: 'TARGET_NO_WORK_TREE' },
    // The name is held; the target itself is perfectly adoptable, so only the
    // name check can produce this.
    { name: 'taken', target: second.repoPath, code: 'PROJECT_EXISTS' },
  ];

  for (const c of cases) {
    const before = (await listProjects()).map(p => p.name).sort();
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: c.name, path: c.target });
    assert.ok(r.status < 500, `${c.code}: status ${r.status} must not be 5xx (${JSON.stringify(r.body)})`);
    assert.equal(r.status, 200, `${c.code}: a refusal is a 200 with ok:false`);
    assert.equal(r.body.ok, false, `${c.code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, c.code, `name=${c.name} path=${c.target}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0, 'a refusal carries a reason');
    assert.deepEqual((await listProjects()).map(p => p.name).sort(), before,
      `${c.code}: a refused adopt registered a project`);
  }

  const ok = await api(baseUrl, 'POST', '/api/projects/external', { name: 'fresh', path: second.repoPath });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.path, second.real);
});

// PINS: not being a repo is not a refusal — the rest of cc already models a
// non-git project, so adopt is no stricter than every surface downstream of it.
test('a plain non-git directory is adoptable and becomes an ordinary non-git project', async () => {
  const plainDir = path.join(home, 'plain-tree');
  await fs.mkdir(plainDir, { recursive: true });
  await fs.writeFile(path.join(plainDir, 'notes.txt'), 'hello\n');
  const real = await fs.realpath(plainDir);

  const r = await api(baseUrl, 'POST', '/api/projects/external', { name: 'plain', path: plainDir });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.path, real);
  assert.deepEqual((await readProjectRecord('plain')).location, { kind: 'local', path: real });

  const list = await api(baseUrl, 'GET', '/api/projects');
  const row = list.body.find(p => p.name === 'plain');
  assert.ok(row, JSON.stringify(list.body));
  // MEASURED not-a-repo, not could-not-look.
  assert.equal(row.isGitRepo, false);
  assert.equal(row.systemUnreachable, null);
  await assert.rejects(() => createWorktree('plain'), /not a git repository/);
});

// PINS: the HAZARD, not the code string — a mutant that refuses but still
// delivers the conventions passes a code-only assertion and fails these.
test("adopting a repo's own .git is refused, and writes nothing into it", async () => {
  const { repoPath } = await makeOutsideRepo();
  const gitDir = path.join(repoPath, '.git');

  const res = await adoptProject('dotgit', gitDir);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, 'TARGET_NO_WORK_TREE');
  await assert.rejects(() => fs.access(path.join(gitDir, 'CONVENTIONS.md')));
  await assert.rejects(() => fs.access(path.join(gitDir, 'CLAUDE.md')));
  await assert.rejects(() => fs.stat(projectStoreDir('dotgit')), 'and no store record');
});

// PINS: dot-ONLY names are path traversal and are refused at the function every
// name-taking entry point funnels through — `deleteProject('..')` would
// otherwise recursively delete the projects root's parent.
test('validateName refuses the dot-only names that would escape the projects root', async () => {
  for (const bad of ['.', '..']) {
    assert.throws(() => validateName(bad), /path traversal/, `validateName(${JSON.stringify(bad)})`);
    await assert.rejects(() => getProject(bad), /path traversal/);
    await assert.rejects(() => deleteProject(bad), /path traversal/);
  }
  assert.equal(validateName('.conduct'), '.conduct');

  const canary = path.join(home, 'canary.txt');
  await fs.writeFile(canary, 'still here\n');
  await assert.rejects(() => deleteProject('..'));
  assert.equal(await fs.readFile(canary, 'utf8'), 'still here\n',
    "the projects root's parent was not touched");
});

// ── conventions delivery ───────────────────────────────────────────────────

// PINS: adoption writes its two files INTO the target, in the call the user
// authorised — not silently at some later boot sweep.
test('adopt writes CONVENTIONS.md into the target and ensures the CLAUDE.md import', async () => {
  const { repoPath, real } = await makeOutsideRepo();
  await fs.writeFile(path.join(repoPath, 'CLAUDE.md'), '# existing\n');
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  assert.ok((await fs.readFile(path.join(real, 'CONVENTIONS.md'), 'utf8')).length > 0);
  const claudeMd = await fs.readFile(path.join(real, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /@CONVENTIONS\.md/);
  assert.match(claudeMd, /# existing/, 'existing content is kept');
});

// PINS: adoption touches a history that is the user's — only the path that MADE
// a repo commits into it.
test('adopt_project adds no commit to the repo it adopts', async () => {
  const { repoPath } = await makeOutsideRepo();
  assert.equal((await git(repoPath, 'rev-list', '--count', 'HEAD')).stdout.trim(), '1');
  assert.equal((await adoptProject('ext', repoPath)).ok, true);
  assert.equal((await git(repoPath, 'rev-list', '--count', 'HEAD')).stdout.trim(), '1');
  assert.match((await git(repoPath, 'status', '--porcelain')).stdout, /^\?\? CONVENTIONS\.md$/m);
});

// PINS: an unregistered name is a DECLINE, not an error — the sweep's cheapest
// path, and the one that must not be mistaken for a failure.
test('ensureProjectConventionsMd declines cleanly for an unregistered name', async () => {
  assert.deepEqual(await ensureProjectConventionsMd('never-registered'), { skipped: 'no-project' });
});

// PINS: the sweep's PER-PROJECT catch. One project that throws must be recorded
// as an error entry and the sweep must reach every project beside it — a single
// unreadable record cannot be allowed to stop CONVENTIONS.md regenerating
// everywhere else. Both halves matter: a sweep that aborted would fail the
// second assertion, and one that swallowed the failure would fail the first.
test('regenerateAllProjectConventions records a failing project and keeps going', async () => {
  const before = await makeOutsideRepo('sweep-before');
  const after = await makeOutsideRepo('sweep-after');
  assert.equal((await adoptProject('aaa-before', before.repoPath)).ok, true);
  assert.equal((await adoptProject('zzz-after', after.repoPath)).ok, true);
  // Sorted between them, so an abort cannot be mistaken for "it ran first".
  const broken = path.join(projectStoreDir('mmm-broken'), 'project.json');
  await fs.mkdir(path.dirname(broken), { recursive: true });
  await fs.writeFile(broken, '{ torn');

  const warned = [];
  const results = await regenerateAllProjectConventions({ log: { warn: (m) => warned.push(String(m)) } });
  const by = Object.fromEntries(results.map(r => [r.name, r]));

  assert.deepEqual(Object.keys(by).sort(), ['aaa-before', 'mmm-broken', 'zzz-after']);
  assert.match(String(by['mmm-broken'].error), /malformed/);
  assert.equal(by['mmm-broken'].regenerated, undefined, 'a failure must not report success');
  assert.equal(by['aaa-before'].regenerated, true);
  assert.equal(by['zzz-after'].regenerated, true, 'the sweep reached PAST the failing project');
  assert.ok(warned.some(w => w.includes('mmm-broken')), 'and said which project failed');
});
