// Out-of-root ("external") projects: a repo living anywhere on disk, adopted as
// `<projectsRoot>/.external/<name>` → the target. Every assertion about the
// target path compares against `await fs.realpath(target)`, never the literal
// string — mkdtemp can hand back a path containing symlinks (it does on macOS),
// and a literal comparison would then pass or fail for reasons unrelated to the
// code under test.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  adoptProject, getProject, listProjects, deleteProject,
  encodeCwd, findSessionLocation,
  externalLinkPath, externalDir, EXTERNAL_DIRNAME,
} from '../src/projects.ts';
import { createWorktree, syncWorktree, mergeWorktreeIntoParent, removeWorktree } from '../src/worktrees.ts';
import { ensureProjectConventionsMd, regenerateAllProjectConventions } from '../src/projectClaudeMd.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

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

// A real git repo OUTSIDE projectsRoot (`<home>/project`) but still under
// `home`, so teardown sweeps it up.
async function makeExternalRepo(dirName = 'external-repo') {
  const repoPath = path.join(home, dirName);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# external repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return { repoPath, real: await fs.realpath(repoPath) };
}

// An in-root project with a real repo, for the "still works / still differs"
// halves of the listing + placement tests.
async function makeInRootRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# in-root\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// ---------- 7.1 the realpath resolution itself ----------

test('adopt resolves the project to the target REALPATH, not the symlink path', async () => {
  const { repoPath, real } = await makeExternalRepo();
  const res = await adoptProject('ext', repoPath);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, real);
  assert.equal(res.external, true);

  const proj = await getProject('ext');
  assert.equal(proj.path, real, 'getProject hands back the realpath');
  assert.equal(proj.external, true);
  assert.notEqual(proj.path, externalLinkPath('ext'),
    'NOT the symlink path — encodeCwd would then disagree with the CLI and resume would break');

  const st = await fs.lstat(externalLinkPath('ext'));
  assert.ok(st.isSymbolicLink(), 'the record IS a symlink');
});

// ---------- 7.2 the same property from the resume angle ----------

test('a session under encodeCwd(realpath) is located; one under encodeCwd(linkPath) is not', async () => {
  const { repoPath, real } = await makeExternalRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  const realDir = path.join(claudeProjectsRoot, encodeCwd(real));
  await fs.mkdir(realDir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  await fs.copyFile(FIXTURE_JSONL, path.join(realDir, `${sid}.jsonl`));
  assert.deepEqual(await findSessionLocation(sid), { project: 'ext', worktreeName: null });

  // The logical (symlink) path encodes to a different dir. The CLI never writes
  // there — it encodes from getcwd(), which is always the realpath — so a
  // logical-path resolution would strand every session of an external project.
  const linkDir = path.join(claudeProjectsRoot, encodeCwd(externalLinkPath('ext')));
  assert.notEqual(linkDir, realDir, 'the two encodings genuinely differ');
  await fs.mkdir(linkDir, { recursive: true });
  const sid2 = '22222222-3333-4444-5555-666666666666';
  await fs.copyFile(FIXTURE_JSONL, path.join(linkDir, `${sid2}.jsonl`));
  assert.equal(await findSessionLocation(sid2), null,
    'a transcript filed under the symlink path belongs to no project');
});

// ---------- 7.3 discovery + the discriminator ----------

test('GET /api/projects lists the external project with the real path and external:true', async () => {
  const { repoPath, real } = await makeExternalRepo();
  await makeInRootRepo('inroot');
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  const r = await api(baseUrl, 'GET', '/api/projects');
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.body.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['ext', 'inroot']);
  assert.equal(byName.ext.path, real);
  assert.equal(byName.ext.external, true);
  assert.equal(byName.inroot.external, false);
  assert.equal(byName.inroot.path, path.join(projectsRoot, 'inroot'));
});

// ---------- 7.4 broken links are skipped, not fatal ----------

test('a broken .external symlink is skipped, and the rest of the list still renders', async () => {
  const { repoPath } = await makeExternalRepo();
  await makeInRootRepo('inroot');
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  // Target unmounted / deleted under us.
  await rmrf(repoPath);

  const names = (await listProjects()).map(p => p.name);
  assert.deepEqual(names, ['inroot'], 'the broken entry is dropped, the good one survives');
  for (const p of await listProjects()) {
    assert.equal(typeof p.path, 'string');
    assert.ok(p.path.length > 0, 'no entry carries a null/empty path');
  }
  const r = await api(baseUrl, 'GET', '/api/projects');
  assert.equal(r.status, 200, 'and the REST surface does not 500');
});

// ---------- 7.5 the soft-refusal contract + check ordering ----------

test('every adopt refusal returns a code, is not 5xx, and leaves no symlink behind', async () => {
  const { repoPath } = await makeExternalRepo();
  const inRoot = await makeInRootRepo('taken');
  const second = await makeExternalRepo('second');
  // A non-repo directory, a subdirectory of a repo, and a plain file — all
  // outside the projects root.
  const plainDir = path.join(home, 'not-a-repo');
  await fs.mkdir(plainDir, { recursive: true });
  const subDir = path.join(repoPath, 'src');
  await fs.mkdir(subDir, { recursive: true });
  const aFile = path.join(home, 'a-file');
  await fs.writeFile(aFile, 'x');
  // An already-adopted target, for the second TARGET_ALREADY_MANAGED shape.
  assert.equal((await adoptProject('already', repoPath)).ok, true);

  const cases = [
    // `.conduct` specifically: an adopted repo must never be able to shadow the
    // orchestrator's own project.
    { name: '.conduct', target: plainDir, code: 'INVALID_NAME' },
    { name: 'has/slash', target: plainDir, code: 'INVALID_NAME' },
    { name: 'rel', target: 'relative/path', code: 'INVALID_TARGET_PATH' },
    { name: 'blank', target: '', code: 'INVALID_TARGET_PATH' },
    { name: 'gone', target: path.join(home, 'no-such-dir'), code: 'TARGET_NOT_FOUND' },
    { name: 'afile', target: aFile, code: 'TARGET_NOT_A_DIRECTORY' },
    { name: 'managed', target: inRoot, code: 'TARGET_ALREADY_MANAGED' },
    { name: 'dupe', target: repoPath, code: 'TARGET_ALREADY_MANAGED' },
    { name: 'plain', target: plainDir, code: 'TARGET_NOT_A_REPO' },
    { name: 'sub', target: subDir, code: 'TARGET_NOT_A_REPO' },
    // The name is held by an in-root project; the target itself is perfectly
    // adoptable, so only the name check can produce this.
    { name: 'taken', target: second.repoPath, code: 'PROJECT_EXISTS' },
  ];

  for (const c of cases) {
    const before = (await fs.readdir(externalDir())).sort();
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: c.name, path: c.target });
    assert.ok(r.status < 500, `${c.code}: status ${r.status} must not be 5xx (${JSON.stringify(r.body)})`);
    assert.equal(r.status, 200, `${c.code}: a refusal is a 200 with ok:false`);
    assert.equal(r.body.ok, false, `${c.code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, c.code, `name=${c.name} path=${c.target}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0, 'a refusal carries a reason');
    // Validate-before-mutate: nothing new appeared under `.external/`.
    assert.deepEqual((await fs.readdir(externalDir())).sort(), before,
      `${c.code}: a refused adopt created a symlink`);
  }

  // Sanity: the same route still 201s on the happy path, with the realpath.
  const ok = await api(baseUrl, 'POST', '/api/projects/external', { name: 'fresh', path: second.repoPath });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.path, second.real);
});

// ---------- 7.6 the irreversible failure mode, full route cascade ----------

test('DELETE an external project unregisters it and never touches the repo', async () => {
  const { repoPath, real } = await makeExternalRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  // A tracked file with known bytes plus a commit, so "the repo survived" is a
  // claim about contents and history, not just about the directory existing.
  const payloadPath = path.join(real, 'payload.txt');
  const payload = 'do not delete me\n';
  await fs.writeFile(payloadPath, payload);
  await git(real, 'add', '.');
  await git(real, 'commit', '-q', '-m', 'payload');
  const headBefore = (await git(real, 'rev-parse', 'HEAD')).stdout.trim();

  const wt = await createWorktree('ext');
  assert.equal(path.dirname(wt.worktreePath), path.join(projectsRoot, EXTERNAL_DIRNAME));
  await fs.stat(wt.worktreePath);

  const del = await api(baseUrl, 'DELETE', '/api/projects/ext');
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // The user's repo: still there, byte-identical, with its history.
  assert.ok((await fs.stat(real)).isDirectory(), 'the target repo still exists');
  assert.equal(await fs.readFile(payloadPath, 'utf8'), payload, 'the committed file is byte-identical');
  const log = (await git(real, 'log', '--oneline')).stdout;
  assert.match(log, /payload/, 'history survives');
  assert.equal((await git(real, 'rev-parse', 'HEAD')).stdout.trim(), headBefore, 'HEAD unmoved');

  // The record is gone, and so is the store entry.
  await assert.rejects(() => fs.lstat(externalLinkPath('ext')), 'the symlink is unlinked');
  assert.deepEqual((await listProjects()).map(p => p.name), []);

  // The worktree dir was removed BEFORE the symlink — otherwise the cascade
  // resolves to a 404, swallows it, and leaves both an orphan dir under
  // `.external/` and a stale registration inside the user's repo.
  await assert.rejects(() => fs.stat(wt.worktreePath), 'the worktree dir is gone');
  const wtList = (await git(real, 'worktree', 'list')).stdout;
  assert.ok(!wtList.includes(wt.worktreeName), `stale git registration: ${wtList}`);
});

// ---------- 7.6b the same safety property, isolated from the route ----------

test('deleteProject on an external project unlinks the record and keeps the target', async () => {
  const { repoPath, real } = await makeExternalRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);
  const keeper = path.join(real, 'keeper.txt');
  await fs.writeFile(keeper, 'kept\n');

  const res = await deleteProject('ext');
  assert.equal(res.path, real, 'it reports the target it did NOT delete');
  assert.equal(await fs.readFile(keeper, 'utf8'), 'kept\n', 'the target file survives deleteProject itself');
  assert.ok((await fs.stat(real)).isDirectory());
  await assert.rejects(() => fs.lstat(externalLinkPath('ext')));
});

test('deleteProject on an in-root project still removes the directory', async () => {
  // The other half of the branch: the external case must not have turned
  // in-root deletion into a no-op.
  const dir = await makeInRootRepo('inroot');
  await deleteProject('inroot');
  await assert.rejects(() => fs.stat(dir));
});

// ---------- 7.7 worktree placement ----------

test('an external project\'s worktrees live under .external/, never beside the target', async () => {
  const { repoPath, real } = await makeExternalRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);
  // Adoption dirties the target with CONVENTIONS.md + the CLAUDE.md import line;
  // commit them so the merge gate's clean-parent check is about this test's own
  // work, not about the adopt write.
  await git(real, 'add', '-A');
  await git(real, 'commit', '-q', '-m', 'cc conventions');
  const parentOfTarget = path.dirname(real);

  const wt = await createWorktree('ext');
  const expected = path.join(projectsRoot, EXTERNAL_DIRNAME, wt.worktreeName);
  assert.equal(wt.worktreePath, expected, 'the returned path');
  assert.ok((await fs.stat(expected)).isDirectory(), 'the on-disk dir');
  // Not at the in-root location — kills "no branch at all".
  await assert.rejects(() => fs.stat(path.join(projectsRoot, wt.worktreeName)));
  // Not a literal sibling of the realpath — the mutation a reviewer will try.
  const siblings = await fs.readdir(parentOfTarget);
  assert.ok(!siblings.some(e => e.includes('_worktree_')),
    `a worktree dir was created in the user's parent directory: ${siblings.join(', ')}`);
  // The branch exists in the TARGET repo.
  const branches = (await git(real, 'branch', '--list', wt.branch)).stdout;
  assert.match(branches, new RegExp(wt.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Full round-trip: commit in the worktree, sync, merge, delete.
  await fs.writeFile(path.join(wt.worktreePath, 'work.txt'), 'work\n');
  await git(wt.worktreePath, 'add', '.');
  await git(wt.worktreePath, 'commit', '-q', '-m', 'work in worktree');
  const sync = await syncWorktree('ext', wt.worktreeName);
  assert.equal(sync.ok, true, JSON.stringify(sync));
  const merge = await mergeWorktreeIntoParent('ext', wt.worktreeName);
  assert.equal(merge.ok, true, JSON.stringify(merge));
  assert.match((await git(real, 'log', '--oneline', 'main')).stdout, /work in worktree/);
  await removeWorktree('ext', wt.worktreeName, { force: true });
  await assert.rejects(() => fs.stat(wt.worktreePath));
});

// ---------- 7.8 what cc writes into the adopted repo, and its idempotency ----------

test('adopt writes CONVENTIONS.md into the target and ensures the CLAUDE.md import', async () => {
  const { repoPath, real } = await makeExternalRepo();
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  const convPath = path.join(real, 'CONVENTIONS.md');
  const conv = await fs.readFile(convPath, 'utf8');
  assert.match(conv.split('\n', 1)[0], /^<!-- cc:conventions ?.*-->$/, 'line 1 is the marker');
  assert.match(conv, /^# Workspace conventions$/m, 'the workspace block is present');
  const claudeMd = await fs.readFile(path.join(real, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.split('\n').some(l => l.trim() === '@CONVENTIONS.md'), 'the import line is present');

  // A target that already HAS a CLAUDE.md keeps every existing byte, below the
  // prepended import line.
  const second = await makeExternalRepo('with-claude-md');
  const original = '# My own instructions\n\nDo the thing.\n';
  await fs.writeFile(path.join(second.real, 'CLAUDE.md'), original);
  assert.equal((await adoptProject('ext2', second.repoPath)).ok, true);
  const after = await fs.readFile(path.join(second.real, 'CLAUDE.md'), 'utf8');
  assert.equal(after, `@CONVENTIONS.md\n${original}`, 'prepended, nothing clobbered');

  // Idempotency: a second sweep produces byte-identical CONVENTIONS.md and does
  // not touch CLAUDE.md at all. So the adopted repo is dirtied ONCE, at adopt.
  const convBefore = await fs.readFile(convPath, 'utf8');
  const mtimeBefore = (await fs.stat(path.join(real, 'CLAUDE.md'))).mtimeMs;
  const results = await regenerateAllProjectConventions();
  const names = results.map(r => r.name).sort();
  assert.deepEqual(names, ['ext', 'ext2'], 'the sweep covers external projects');
  for (const r of results) assert.equal(r.regenerated, true, JSON.stringify(r));
  assert.equal(await fs.readFile(convPath, 'utf8'), convBefore, 'CONVENTIONS.md is byte-identical');
  assert.equal((await fs.stat(path.join(real, 'CLAUDE.md'))).mtimeMs, mtimeBefore, 'CLAUDE.md was not rewritten');
});

// ---------- 7.9 the sweep cannot crash on an external project ----------

test('regenerateAllProjectConventions survives an unwritable external project', async () => {
  const { repoPath, real } = await makeExternalRepo();
  await makeInRootRepo('inroot');
  assert.equal((await adoptProject('ext', repoPath)).ok, true);

  // EISDIR, not chmod: a test running as root bypasses permission bits, so a
  // chmod-based failure would be silently non-deterministic.
  await fs.rm(path.join(real, 'CONVENTIONS.md'), { force: true });
  await fs.mkdir(path.join(real, 'CONVENTIONS.md'));

  const results = await regenerateAllProjectConventions();
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.ok(typeof byName.ext.error === 'string' && byName.ext.error.length > 0,
    `the failing project records an error: ${JSON.stringify(byName.ext)}`);
  assert.equal(byName.inroot.regenerated, true, 'and the sweep continued past it');
});

// ---------- 7.10 cc cannot write outside the adopted repo ----------

test('nothing is written outside the adopted repo, at adopt or on a sweep', async () => {
  const { repoPath, real } = await makeExternalRepo();
  const parent = path.dirname(real);
  const before = (await fs.readdir(parent)).sort();

  assert.equal((await adoptProject('ext', repoPath)).ok, true);
  await ensureProjectConventionsMd('ext');
  await regenerateAllProjectConventions();

  assert.deepEqual((await fs.readdir(parent)).sort(), before,
    'the target\'s parent directory is untouched');
});
