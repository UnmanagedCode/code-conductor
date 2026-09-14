// Integration tests for the project commit-history routes:
//   GET /api/projects/:name/commits
//   GET /api/projects/:name/commits/:sha/diff

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// One implementation; `git` is the env-free spelling of `gitEnv`. The fixture
// below needs GIT_AUTHOR_DATE/GIT_COMMITTER_DATE per commit.
function gitEnv(cwd, env, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
        else resolve({ stdout, stderr });
      });
  });
}

function git(cwd, ...args) { return gitEnv(cwd, {}, ...args); }

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

async function commitFile(repoPath, file, content, message) {
  await fs.writeFile(path.join(repoPath, file), content);
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', message);
}

test('GET /commits returns the current branch history newest-first', async () => {
  const repoPath = await makeRealRepo('demo');
  await commitFile(repoPath, 'feature.js', 'export function hello() {}\n', 'add feature');

  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.project, 'demo');
  assert.equal(r.body.branch, 'main');
  assert.equal(r.body.truncated, false);
  assert.ok(Array.isArray(r.body.commits), 'commits should be an array');
  assert.equal(r.body.commits.length, 2, 'two commits expected');
  // Newest first.
  assert.equal(r.body.commits[0].subject, 'add feature');
  assert.equal(r.body.commits[1].subject, 'initial');
  const c = r.body.commits[0];
  assert.ok(/^[0-9a-f]{40}$/.test(c.sha), 'sha should be a full hex object name');
  assert.ok(c.shortSha && c.sha.startsWith(c.shortSha), 'shortSha is a prefix of sha');
  assert.equal(c.author, 'test');
  assert.ok(typeof c.relativeDate === 'string' && c.relativeDate.length > 0);
  assert.ok(typeof c.isoDate === 'string' && c.isoDate.length > 0);
  // parents: the newest commit points at the root; the root has none.
  assert.ok(Array.isArray(c.parents), 'parents should be an array');
  assert.deepEqual(c.parents, [r.body.commits[1].sha], 'child parents = [root sha]');
  assert.deepEqual(r.body.commits[1].parents, [], 'root commit has no parents');
});

test('GET /commits exposes both parents of a merge commit', async () => {
  const repoPath = await makeRealRepo('demo');
  // Branch off, commit on the branch, then no-ff merge back into main so the
  // merge commit has two parents (main tip + feature tip).
  await git(repoPath, 'checkout', '-q', '-b', 'feature');
  await commitFile(repoPath, 'feature.js', 'export const x = 1;\n', 'feature commit');
  await git(repoPath, 'checkout', '-q', 'main');
  await git(repoPath, 'merge', '--no-ff', '-q', '-m', 'merge feature', 'feature');

  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const merge = r.body.commits[0];
  assert.equal(merge.subject, 'merge feature', 'newest commit is the merge');
  assert.equal(merge.parents.length, 2, 'merge commit has two parents');
  const allShas = new Set(r.body.commits.map(c => c.sha));
  for (const p of merge.parents) {
    assert.ok(allShas.has(p), `merge parent ${p} should be among the returned commits`);
  }
});

test('GET /commits respects ?limit and flags truncation', async () => {
  const repoPath = await makeRealRepo('demo');
  await commitFile(repoPath, 'a.js', 'a\n', 'commit a');
  await commitFile(repoPath, 'b.js', 'b\n', 'commit b');

  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits?limit=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.commits.length, 1, 'limit=1 returns one commit');
  assert.equal(r.body.limit, 1);
  assert.equal(r.body.truncated, true, 'truncated when more commits exist');
  assert.equal(r.body.commits[0].subject, 'commit b', 'newest commit returned');
});

test('GET /commits/:sha/diff returns only that commit\'s change', async () => {
  const repoPath = await makeRealRepo('demo');
  await commitFile(repoPath, 'feature.js', 'export function hello() {}\n', 'add feature');

  const list = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  const sha = list.body.commits[0].sha; // the "add feature" commit

  const r = await api(baseUrl, 'GET', `/api/projects/demo/commits/${sha}/diff`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.project, 'demo');
  assert.equal(r.body.sha, sha);
  assert.ok(Array.isArray(r.body.files), 'files should be an array');
  assert.equal(r.body.files.length, 1, 'one changed file in this commit');
  assert.equal(r.body.files[0].path, 'feature.js');
  assert.equal(r.body.files[0].status, 'added');
  assert.ok(r.body.files[0].adds > 0, 'should have additions');
  assert.equal(r.body.files[0].hunks, undefined, 'summary rows have no hunks');
  assert.ok(r.body.totalAdds > 0, 'totalAdds should be > 0');
  assert.equal(r.body.totalDels, 0);
  assert.equal(r.body.totalFiles, 1);
  assert.equal(r.body.truncated, undefined, 'summary is never truncated — field removed');
  assert.equal(r.body.commitMessage, 'add feature', 'commitMessage should be the trimmed commit message');

  const fr = await api(baseUrl, 'GET', `/api/projects/demo/commits/${sha}/diff?path=feature.js`);
  assert.equal(fr.status, 200, `expected 200, got ${fr.status}: ${JSON.stringify(fr.body)}`);
  assert.equal(fr.body.path, 'feature.js');
  assert.ok(fr.body.file.hunks.length > 0, 'at least one hunk');
});

test('GET /commits/:sha/diff works for the root commit', async () => {
  await makeRealRepo('demo');
  const list = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  const rootSha = list.body.commits[list.body.commits.length - 1].sha;

  const r = await api(baseUrl, 'GET', `/api/projects/demo/commits/${rootSha}/diff`);
  assert.equal(r.status, 200);
  const file = r.body.files.find(f => f.path === 'README.md');
  assert.ok(file, 'README.md should appear in the root commit diff');
  assert.equal(file.status, 'added');
  assert.equal(r.body.commitMessage, 'initial', 'commitMessage should be present for the root commit');
});

test('GET /commits/:sha/diff for a merge commit returns the first-parent aggregate diff', async () => {
  const repoPath = await makeRealRepo('demo');
  // Branch off, commit a change on the branch, then no-ff merge back into
  // main. A bare `git show` on the resulting merge commit would emit git's
  // combined diff (conflict hunks only), which is empty for a clean merge
  // like this one — the fix routes merges through `--first-parent` instead.
  await git(repoPath, 'checkout', '-q', '-b', 'feature');
  await commitFile(repoPath, 'feature.js', 'export const x = 1;\n', 'feature commit');
  await git(repoPath, 'checkout', '-q', 'main');
  await git(repoPath, 'merge', '--no-ff', '-q', '-m', 'merge feature', 'feature');

  const list = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  const merge = list.body.commits[0];
  assert.equal(merge.subject, 'merge feature');
  assert.equal(merge.parents.length, 2, 'sanity: this is a merge commit');

  const r = await api(baseUrl, 'GET', `/api/projects/demo/commits/${merge.sha}/diff`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.files) && r.body.files.length > 0, 'merge diff should not be empty');
  const file = r.body.files.find(f => f.path === 'feature.js');
  assert.ok(file, 'feature.js should appear in the merge diff');
  assert.equal(file.status, 'added');
  assert.ok(r.body.totalAdds > 0, 'totalAdds should be > 0');
  assert.equal(r.body.commitMessage, 'merge feature');

  const fr = await api(baseUrl, 'GET', `/api/projects/demo/commits/${merge.sha}/diff?path=feature.js`);
  assert.equal(fr.status, 200, `expected 200, got ${fr.status}: ${JSON.stringify(fr.body)}`);
  assert.ok(fr.body.file.hunks.length > 0, 'at least one hunk');
});

test('GET /commits/:sha/diff for a --no-ff merge touching many files lists every file', async () => {
  const repoPath = await makeRealRepo('demo');
  await git(repoPath, 'checkout', '-q', '-b', 'feature');
  const N = 30;
  for (let i = 0; i < N; i++) {
    await fs.writeFile(path.join(repoPath, `f${i}.js`), `export const v${i} = ${i};\n`);
  }
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'feature: many files');
  await git(repoPath, 'checkout', '-q', 'main');
  await git(repoPath, 'merge', '--no-ff', '-q', '-m', 'merge feature', 'feature');

  const list = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  const merge = list.body.commits[0];

  const r = await api(baseUrl, 'GET', `/api/projects/demo/commits/${merge.sha}/diff`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.files.length, N, `every file in the merge should be listed`);

  const one = r.body.files[0].path;
  const fr = await api(baseUrl, 'GET', `/api/projects/demo/commits/${merge.sha}/diff?path=${encodeURIComponent(one)}`);
  assert.equal(fr.status, 200);
  assert.ok(fr.body.file.hunks.length > 0);
});

test('GET /commits/:sha/diff rejects a non-hex sha with 400 (summary and ?path=)', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits/zzz/diff');
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  const rp = await api(baseUrl, 'GET', '/api/projects/demo/commits/zzz/diff?path=a.js');
  assert.equal(rp.status, 400, `expected 400, got ${rp.status}`);
});

test('GET /commits/:sha/diff returns 404 for an unknown commit (summary and ?path=)', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits/deadbeef/diff');
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  const rp = await api(baseUrl, 'GET', '/api/projects/demo/commits/deadbeef/diff?path=a.js');
  assert.equal(rp.status, 404, `expected 404, got ${rp.status}`);
});

test('GET /commits returns empty history for a non-git project', async () => {
  await fs.mkdir(path.join(projectsRoot, 'plain'), { recursive: true });
  const r = await api(baseUrl, 'GET', '/api/projects/plain/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.branch, null);
  assert.deepEqual(r.body.commits, []);
  assert.equal(r.body.truncated, false);
});

test('GET /commits returns 404 for an unknown project', async () => {
  const r = await api(baseUrl, 'GET', '/api/projects/nope/commits');
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
});

// ── Uncommitted-changes detection ──────────────────────────────────────────

test('GET /commits returns hasUncommitted:false on a clean tree', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.hasUncommitted, false);
});

test('GET /commits returns hasUncommitted:true when working tree is dirty', async () => {
  const repoPath = await makeRealRepo('demo');
  // Modify a tracked file without committing.
  await fs.writeFile(path.join(repoPath, 'README.md'), '# modified\n');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.hasUncommitted, true);
});

test('GET /commits/uncommitted/diff returns structured diff for dirty tree', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# modified\nextra line\n');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits/uncommitted/diff');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.project, 'demo');
  assert.ok(Array.isArray(r.body.files), 'files should be an array');
  assert.ok(r.body.files.length > 0, 'should have at least one changed file');
  const readme = r.body.files.find(f => f.path === 'README.md');
  assert.ok(readme, 'README.md should appear in the diff');
  assert.equal(readme.hunks, undefined, 'summary rows have no hunks');
  assert.ok(r.body.totalAdds > 0 || r.body.totalDels > 0, 'should have changes');
  assert.equal(r.body.totalFiles, r.body.files.length);

  const fr = await api(baseUrl, 'GET', '/api/projects/demo/commits/uncommitted/diff?path=README.md');
  assert.equal(fr.status, 200, `expected 200, got ${fr.status}: ${JSON.stringify(fr.body)}`);
  assert.ok(fr.body.file.hunks.length > 0, 'at least one hunk');
});

test('GET /commits/uncommitted/diff returns empty files on a clean tree', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits/uncommitted/diff');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, []);
  assert.equal(r.body.totalAdds, 0);
  assert.equal(r.body.totalDels, 0);
  assert.equal(r.body.totalFiles, 0);
});

test('GET /commits/uncommitted/diff?path= returns 404 on a repo with no HEAD (no commits yet)', async () => {
  const repoPath = path.join(projectsRoot, 'fresh');
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'hello\n');

  const r = await api(baseUrl, 'GET', '/api/projects/fresh/commits/uncommitted/diff?path=a.txt');
  assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
});

// ── Ahead-of-base detection ────────────────────────────────────────────────

test('GET /commits returns aheadCount:null when there is no upstream', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.aheadCount, null);
  assert.equal(r.body.aheadOf, null);
});

test('GET /commits returns aheadCount when project has upstream tracking', async () => {
  // Create a bare "remote" and clone it so we have an upstream.
  const bareDir = path.join(projectsRoot, 'demo.git');
  await fs.mkdir(bareDir, { recursive: true });
  await git(bareDir, 'init', '-q', '--bare', '-b', 'main');

  const repoPath = path.join(projectsRoot, 'demo');
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# base\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  await git(repoPath, 'remote', 'add', 'origin', bareDir);
  await git(repoPath, 'push', '-q', 'origin', 'main');
  await git(repoPath, 'branch', '--set-upstream-to=origin/main', 'main');

  // Add a local commit that hasn't been pushed.
  await commitFile(repoPath, 'feature.js', 'export const x = 1;\n', 'add feature');

  const r = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.aheadCount, 1, 'one commit ahead of origin/main');
  assert.ok(typeof r.body.aheadOf === 'string' && r.body.aheadOf.length > 0, 'aheadOf should be a non-empty string');
});

test('GET /commits for a worktree returns aheadCount vs base branch', async () => {
  // Create parent repo.
  const parentPath = await makeRealRepo('myapp');

  // Create a worktree directly via git (simulating what createWorktree does).
  const wtId = 'abc123';
  const wtName = `myapp_worktree_${wtId}`;
  const wtPath = path.join(projectsRoot, wtName);
  const wtBranch = `code-conductor/${wtId}`;
  const { stdout: headShaOut } = await git(parentPath, 'rev-parse', 'HEAD');
  const headSha = headShaOut.trim();
  await git(parentPath, 'worktree', 'add', wtPath, '-b', wtBranch, headSha);

  // Write the orchestrator metadata the worktree is registered by.
  const metaDir = path.join(
    projectsRoot, '.code-conductor', 'projects', 'myapp', 'worktrees', wtName,
  );
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(path.join(metaDir, 'worktree.json'), JSON.stringify({
    parentProject: 'myapp',
    parentPath,
    worktreeName: wtName,
    worktreePath: wtPath,
    branch: wtBranch,
    baseBranch: 'main',
    baseSha: headSha,
    createdAt: new Date().toISOString(),
  }));

  // Configure git identity in the worktree.
  await git(wtPath, 'config', 'user.email', 'test@example.com');
  await git(wtPath, 'config', 'user.name', 'test');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');

  // Add a commit on the worktree branch — now it's 1 ahead of 'main'.
  await commitFile(wtPath, 'wt-feature.js', 'export const y = 2;\n', 'worktree commit');

  const r = await api(baseUrl, 'GET',
    `/api/projects/myapp/worktrees/${encodeURIComponent(wtName)}/commits`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.project, 'myapp', 'the parent project names the response');
  assert.equal(r.body.worktreeName, wtName, 'echoes the canonical worktree name');
  assert.equal(r.body.aheadCount, 1, 'one commit ahead of base branch');
  assert.equal(r.body.aheadOf, 'main', 'ahead of the parent branch (main)');
  assert.equal(r.body.hasUncommitted, false, 'clean worktree → hasUncommitted:false');
});

test('GET /commits for a worktree returns hasUncommitted:true when worktree is dirty', async () => {
  const parentPath = await makeRealRepo('myapp');

  const wtId = 'def456';
  const wtName = `myapp_worktree_${wtId}`;
  const wtPath = path.join(projectsRoot, wtName);
  const wtBranch = `code-conductor/${wtId}`;
  const { stdout: headShaOut } = await git(parentPath, 'rev-parse', 'HEAD');
  const headSha = headShaOut.trim();
  await git(parentPath, 'worktree', 'add', wtPath, '-b', wtBranch, headSha);

  const metaDir = path.join(
    projectsRoot, '.code-conductor', 'projects', 'myapp', 'worktrees', wtName,
  );
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(path.join(metaDir, 'worktree.json'), JSON.stringify({
    parentProject: 'myapp',
    parentPath,
    worktreeName: wtName,
    worktreePath: wtPath,
    branch: wtBranch,
    baseBranch: 'main',
    baseSha: headSha,
    createdAt: new Date().toISOString(),
  }));

  await git(wtPath, 'config', 'user.email', 'test@example.com');
  await git(wtPath, 'config', 'user.name', 'test');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');

  // Make an unstaged change in the worktree — no commit.
  await fs.writeFile(path.join(wtPath, 'README.md'), '# modified in worktree\n');

  const r = await api(baseUrl, 'GET',
    `/api/projects/myapp/worktrees/${encodeURIComponent(wtName)}/commits`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.hasUncommitted, true, 'dirty worktree → hasUncommitted:true');
});

// PINS: the two worktree-scoped diff routes exist locally and resolve the named
// worktree. The uncommitted half carries the per-checkout control: the dirty
// file exists only in the worktree, so the parent-scoped route answers empty.
// (The single-commit half cannot have that control — a worktree shares its
// parent's object database, so `git show <sha>` answers from either tree. What
// it pins instead is that the worktree name is RESOLVED, not ignored: an
// unknown one is refused rather than silently falling back to the parent.)
test('the worktree-scoped commit and uncommitted diff routes read that checkout', async () => {
  const parentPath = await makeRealRepo('myapp');

  const wtId = 'aa77bb';
  const wtName = `myapp_worktree_${wtId}`;
  const wtPath = path.join(projectsRoot, wtName);
  const wtBranch = `code-conductor/${wtId}`;
  const { stdout: headShaOut } = await git(parentPath, 'rev-parse', 'HEAD');
  const headSha = headShaOut.trim();
  await git(parentPath, 'worktree', 'add', wtPath, '-b', wtBranch, headSha);

  const metaDir = path.join(
    projectsRoot, '.code-conductor', 'projects', 'myapp', 'worktrees', wtName,
  );
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(path.join(metaDir, 'worktree.json'), JSON.stringify({
    parentProject: 'myapp', parentPath, worktreeName: wtName, worktreePath: wtPath,
    branch: wtBranch, baseBranch: 'main', baseSha: headSha,
    createdAt: new Date().toISOString(),
  }));

  await git(wtPath, 'config', 'user.email', 'test@example.com');
  await git(wtPath, 'config', 'user.name', 'test');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  await commitFile(wtPath, 'only-here.js', 'export const y = 2;\n', 'worktree commit');
  const { stdout: wtShaOut } = await git(wtPath, 'rev-parse', 'HEAD');
  const wtSha = wtShaOut.trim();
  await fs.writeFile(path.join(wtPath, 'README.md'), '# modified in worktree\n');

  const base = `/api/projects/myapp/worktrees/${encodeURIComponent(wtName)}`;

  const commitDiff = await api(baseUrl, 'GET', `${base}/commits/${wtSha}/diff`);
  assert.equal(commitDiff.status, 200, JSON.stringify(commitDiff.body));
  assert.equal(commitDiff.body.commitMessage, 'worktree commit');
  assert.deepEqual(commitDiff.body.files.map(f => f.path), ['only-here.js']);

  const dirty = await api(baseUrl, 'GET', `${base}/commits/uncommitted/diff`);
  assert.equal(dirty.status, 200, JSON.stringify(dirty.body));
  assert.deepEqual(dirty.body.files.map(f => f.path), ['README.md']);

  const parentDirty = await api(baseUrl, 'GET', '/api/projects/myapp/commits/uncommitted/diff');
  assert.deepEqual(parentDirty.body.files, [],
    'control: the change exists only in the worktree checkout');

  const unknown = await api(baseUrl, 'GET',
    `/api/projects/myapp/worktrees/myapp_worktree_nope/commits/${wtSha}/diff`);
  assert.equal(unknown.status, 404, 'control: the worktree name is resolved, not ignored');
});

// ── Topological ordering ────────────────────────────────────────────────────
// The frontend's lane assignment (computeGraph, public/commits.js) requires
// that a parent never precede its child in commits[]. git's DEFAULT ordering is
// a committer-date priority queue and does not guarantee that; --topo-order
// does. The fixture below is built so the default ordering demonstrably breaks
// it — a LINEAR history cannot, because git's walk queue never holds two
// candidates at once and the invariant would hold vacuously on broken code.

function d(author, committer) {
  return { GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer };
}

// Topology: A ← B ← M(merge), A ← S1 ← S2 ← M. Committer dates are chosen so
// the default walk pops M, B, then A (01-05, newer than S2's 01-03) — emitting
// the root A ABOVE its own child S1. Author dates (what the view displays) are
// pinned too, so the fixture never depends on the wall clock.
async function makeTopoRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');

  const commit = async (file, message, dates) => {
    await fs.writeFile(path.join(repoPath, file), `${message}\n`);
    await git(repoPath, 'add', '.');
    await gitEnv(repoPath, dates, 'commit', '-q', '-m', message);
  };

  await commit('a.txt', 'A', d('2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'));
  const { stdout: aShaOut } = await git(repoPath, 'rev-parse', 'HEAD');
  await commit('b.txt', 'B', d('2026-01-02T00:00:00Z', '2026-01-04T00:00:00Z'));
  await git(repoPath, 'checkout', '-q', '-b', 'side', aShaOut.trim());
  await commit('s1.txt', 'S1', d('2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z'));
  await commit('s2.txt', 'S2', d('2026-01-04T00:00:00Z', '2026-01-03T00:00:00Z'));
  await git(repoPath, 'checkout', '-q', 'main');
  await gitEnv(repoPath, d('2026-01-06T00:00:00Z', '2026-01-06T00:00:00Z'),
    'merge', '--no-ff', '--no-edit', '-m', 'M', 'side');
  return repoPath;
}

// Count (child index, parent index) pairs where the parent is at a LOWER index,
// over a [{sha, parents}] list. Returns the offending pairs, formatted.
function topologyViolations(commits) {
  const idx = new Map(commits.map((c, i) => [c.sha, i]));
  const bad = [];
  for (let i = 0; i < commits.length; i++) {
    for (const p of commits[i].parents) {
      if (!idx.has(p)) continue; // outside the window — nothing to check
      if (idx.get(p) <= i) {
        bad.push(`parent ${p.slice(0, 7)} of ${commits[i].sha.slice(0, 7)} is at index `
          + `${idx.get(p)}, must be > ${i}`);
      }
    }
  }
  return bad;
}

test('GET /commits orders commits topologically, not by date', async () => {
  await makeTopoRepo('topo');

  const r = await api(baseUrl, 'GET', '/api/projects/topo/commits');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const commits = r.body.commits;
  assert.equal(commits.length, 5);
  assert.equal(commits[0].subject, 'M', 'tip first');
  // Non-vacuity: drop %P from the pretty format and every parents[] comes back
  // empty, leaving the sweep below nothing to check.
  assert.ok(commits.some(c => c.parents.length > 0), 'commits must carry their parents');
  const bad = topologyViolations(commits);
  assert.deepEqual(bad, [], `commits[] must be topologically ordered:\n  ${bad.join('\n  ')}`);
});

test("the fixture's default git ordering really does violate topology", async () => {
  // Non-vacuity control for the test above: if a future git changes its default
  // ordering, or this fixture is edited into a shape that no longer diverges,
  // this goes red and names the reason instead of letting the ordering test
  // pass for free.
  const repoPath = await makeTopoRepo('topo-control');
  const raw = (await git(repoPath, 'log', '--max-count=10', '--pretty=%H %P')).stdout;
  const commits = raw.trim().split('\n').map((line) => {
    const [sha, ...parents] = line.trim().split(/\s+/);
    return { sha, parents };
  });
  assert.equal(commits.length, 5);
  assert.ok(topologyViolations(commits).length > 0,
    'fixture no longer diverges under git\'s default ordering — the ordering test '
    + 'above would now pass vacuously');
});

// ── Per-commit ahead flag ───────────────────────────────────────────────────
// The ahead set is NOT a prefix of the window. --topo-order guarantees only
// that a parent follows its children; among commits that are neither ancestor
// nor descendant of one another git falls back to committer date, and ahead vs
// already-merged commits across a merge boundary are exactly that. Merging a
// moved-on base branch back into your own branch produces it.
//
//   m1 ← m2 (main)          M merges main into the worktree branch, so the
//    ↑         ↖            emitted order is M, m2, w2, w1, m1 and the ahead
//   w1 ← w2 ← M (branch)    set {M, w2, w1} lands at indices 0, 2, 3.
async function makeNonPrefixWorktree() {
  const parentPath = path.join(projectsRoot, 'nonprefix');
  await fs.mkdir(parentPath, { recursive: true });
  await git(parentPath, 'init', '-q', '-b', 'main');
  await git(parentPath, 'config', 'user.email', 'test@example.com');
  await git(parentPath, 'config', 'user.name', 'test');
  await git(parentPath, 'config', 'commit.gpgsign', 'false');
  const commit = async (cwd, msg, day) => {
    await fs.writeFile(path.join(cwd, `${msg}.txt`), `${msg}\n`);
    await git(cwd, 'add', '.');
    await gitEnv(cwd, d(`2026-01-0${day}T00:00:00Z`, `2026-01-0${day}T00:00:00Z`),
      'commit', '-q', '-m', msg);
  };

  await commit(parentPath, 'm1', 1);
  const wtName = 'nonprefix_worktree_np';
  const wtPath = path.join(projectsRoot, wtName);
  const wtBranch = 'code-conductor/np';
  const { stdout: baseShaOut } = await git(parentPath, 'rev-parse', 'HEAD');
  await git(parentPath, 'worktree', 'add', '-q', wtPath, '-b', wtBranch, baseShaOut.trim());

  await commit(wtPath, 'w1', 2);
  await commit(wtPath, 'w2', 3);
  // m2 is committed AFTER w2, so git's date tie-break inside --topo-order pops
  // it before the branch's own line — which is what breaks contiguity.
  await commit(parentPath, 'm2', 4);
  await gitEnv(wtPath, d('2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
    'merge', '--no-ff', '--no-edit', '-m', 'M', 'main');

  const metaDir = path.join(
    projectsRoot, '.code-conductor', 'projects', 'nonprefix', 'worktrees', wtName,
  );
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(path.join(metaDir, 'worktree.json'), JSON.stringify({
    parentProject: 'nonprefix', parentPath, worktreeName: wtName, worktreePath: wtPath,
    branch: wtBranch, baseBranch: 'main', baseSha: baseShaOut.trim(),
    createdAt: new Date().toISOString(),
  }));
  return wtName;
}

test('each commit carries its own ahead flag, even when the ahead set is not a prefix', async () => {
  const wtName = await makeNonPrefixWorktree();

  const r = await api(baseUrl, 'GET',
    `/api/projects/nonprefix/worktrees/${encodeURIComponent(wtName)}/commits`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const commits = r.body.commits;
  assert.equal(r.body.aheadOf, 'main');
  assert.equal(r.body.aheadCount, 3, 'M, w2, w1 are ahead of main');

  // The invariant, stated per commit and independent of emission order.
  const flagOf = new Map(commits.map(c => [c.subject, c.ahead]));
  assert.deepEqual(
    ['M', 'w2', 'w1', 'm2', 'm1'].map(s => `${s}:${flagOf.get(s)}`),
    ['M:true', 'w2:true', 'w1:true', 'm2:false', 'm1:false'],
  );
  // aheadCount counts the whole ahead set, which can exceed the window — this
  // equality is an untruncated-window claim, which is what this fixture is.
  assert.equal(r.body.truncated, false);
  assert.equal(commits.filter(c => c.ahead).length, r.body.aheadCount);

  // Non-vacuity control: this fixture must actually emit a non-ahead commit
  // ABOVE an ahead one, or it would prove nothing an index-based partition
  // wouldn't also satisfy.
  const flags = commits.map(c => c.ahead);
  assert.ok(flags.indexOf(false) < flags.lastIndexOf(true),
    `fixture is no longer non-prefix: ${JSON.stringify(commits.map(c => `${c.subject}:${c.ahead}`))}`);
});

test('commits carry ahead:false throughout when there is no base to compare against', async () => {
  // A plain project with no upstream and no worktree metadata: aheadOf is null,
  // so nothing is claimed to be ahead of anything.
  await makeRealRepo('nobase');
  const r = await api(baseUrl, 'GET', '/api/projects/nobase/commits');
  assert.equal(r.status, 200);
  assert.equal(r.body.aheadOf, null);
  assert.equal(r.body.aheadCount, null);
  assert.deepEqual(r.body.commits.map(c => c.ahead), [false]);
});
