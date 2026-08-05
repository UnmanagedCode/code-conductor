// Integration tests for the GET /api/projects/:name/worktrees/:wt/diff route:
// the per-file summary (default) and the per-file hunks (?path=).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { FILE_DIFF_LINE_GUARD } from '../src/gitDiff.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(projectsRoot, name) {
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

let ctx, baseUrl, instances, projectsRoot, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('GET /diff returns structured data for a worktree with changes', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  // Create a worktree via the instances API (worktree:true creates + attaches).
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(created.status, 201);
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  // Configure git identity in the worktree and add a new file.
  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(wtPath, 'feature.js'), 'export function hello() {}\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add feature');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);

  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.project, 'demo');
  assert.equal(r.body.worktreeName, wtName);
  assert.ok(typeof r.body.baseRef === 'string', 'baseRef should be a string');
  assert.ok(Array.isArray(r.body.files), 'files should be an array');
  assert.equal(r.body.files.length, 1, 'one changed file expected');
  assert.equal(r.body.files[0].path, 'feature.js');
  assert.equal(r.body.files[0].status, 'added');
  assert.ok(r.body.files[0].adds > 0, 'should have additions');
  assert.equal(r.body.files[0].dels, 0, 'no deletions in a new file');
  assert.equal(r.body.files[0].hunks, undefined, 'summary rows have no hunks');
  assert.ok(r.body.totalAdds > 0, 'totalAdds should be > 0');
  assert.equal(r.body.totalDels, 0);
  assert.equal(r.body.totalFiles, 1);
  assert.equal(r.body.truncated, undefined, 'summary is never truncated — field removed');
});

test('GET /diff?path= returns hunks for one file', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(wtPath, 'feature.js'), 'export function hello() {}\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add feature');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?path=feature.js`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.path, 'feature.js');
  assert.equal(r.body.file.path, 'feature.js');
  assert.ok(r.body.file.hunks.length > 0, 'at least one hunk');
  assert.equal(r.body.file.truncated, false);
  assert.equal(r.body.file.oversized, false);
});

test('GET /diff?path=<missing> returns 404', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?path=does-not-exist.js`);
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
});

test('GET /diff lists every file in a change exceeding 200 KB raw diff', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');

  const N = 60;
  const bigLine = 'x'.repeat(3000) + '\n'; // ~3KB per file, ~180KB+ total raw diff
  for (let i = 0; i < N; i++) {
    await fs.writeFile(path.join(wtPath, `file${i}.txt`), bigLine);
  }
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add many files');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.files.length, N, `all ${N} files should be listed`);
  const expectedAdds = r.body.files.reduce((s, f) => s + f.adds, 0);
  assert.equal(r.body.totalAdds, expectedAdds, 'totalAdds should equal the true sum');
});

test('GET /diff reports a renamed file with oldPath, and ?path= on the new name works', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');
  await fs.writeFile(path.join(repoPath, 'old.js'), 'export const x = 1;\nexport const y = 2;\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'add old.js');

  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  await git(wtPath, 'mv', 'old.js', 'new.js');
  await fs.appendFile(path.join(wtPath, 'new.js'), 'export const z = 3;\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'rename old.js to new.js');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);
  assert.equal(r.status, 200);
  const row = r.body.files.find(f => f.path === 'new.js');
  assert.ok(row, 'new.js should appear in the summary');
  assert.equal(row.status, 'renamed');
  assert.equal(row.oldPath, 'old.js');

  const fr = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?path=new.js`);
  assert.equal(fr.status, 200, `expected 200, got ${fr.status}: ${JSON.stringify(fr.body)}`);
  assert.ok(fr.body.file.hunks.length > 0, 'renamed file should have hunks');
});

test('GET /diff reports a binary file, and ?path= returns binary with no hunks', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  // Bytes including a NUL so git treats it as binary.
  await fs.writeFile(path.join(wtPath, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add binary file');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);
  assert.equal(r.status, 200);
  const row = r.body.files.find(f => f.path === 'image.bin');
  assert.ok(row, 'image.bin should appear in the summary');
  assert.equal(row.binary, true);

  const fr = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?path=image.bin`);
  assert.equal(fr.status, 200);
  assert.equal(fr.body.file.binary, true);
  assert.deepEqual(fr.body.file.hunks, []);
});

test('GET /diff?path= flags an oversized file without reading its full diff', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');
  const bigContent = Array.from({ length: FILE_DIFF_LINE_GUARD + 1 }, () => 'x').join('\n') + '\n';
  await fs.writeFile(path.join(wtPath, 'huge.txt'), bigContent);
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add huge file');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?path=huge.txt`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.file.oversized, true);
  assert.deepEqual(r.body.file.hunks, []);
});

test('GET /diff returns empty files array when worktree has no changes', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(created.status, 201);
  const wtName = created.body.worktree.worktreeName;

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);

  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.files), 'files should be an array');
  assert.equal(r.body.files.length, 0, 'no changes expected');
  assert.equal(r.body.totalAdds, 0);
  assert.equal(r.body.totalDels, 0);
  assert.equal(r.body.totalFiles, 0);
});

test('GET /diff returns 404 for an unknown worktree', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const r = await api(baseUrl, 'GET',
    '/api/projects/demo/worktrees/demo_worktree_nonexistent/diff');
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
});

test('GET /diff rejects baseRef starting with - (option injection)', async () => {
  await makeRealRepo(projectsRoot, 'demo');
  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;

  // Leading-dash ref like '-Oevil' would be interpreted by git as an option.
  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?baseRef=-Oevil`);
  assert.equal(r.status, 400);

  // Double-dash option form should also be rejected.
  const r2 = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff?baseRef=--output%3D%2Ftmp%2Fpwned`);
  assert.equal(r2.status, 400);
});

test('GET /diff reflects modifications and deletions in the structured output', async () => {
  const repoPath = await makeRealRepo(projectsRoot, 'demo');

  // Add a file in the parent repo's initial commit.
  await fs.writeFile(path.join(repoPath, 'utils.js'), 'export function a() {}\nexport function b() {}\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'add utils');

  const created = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const wtName = created.body.worktree.worktreeName;
  const wtPath = path.join(projectsRoot, wtName);

  await git(wtPath, 'config', 'user.email', 'agent@example.com');
  await git(wtPath, 'config', 'user.name', 'agent');
  await git(wtPath, 'config', 'commit.gpgsign', 'false');

  // Modify utils.js (remove one function, add another).
  await fs.writeFile(path.join(wtPath, 'utils.js'), 'export function a() {}\nexport function c() {}\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'modify utils');

  const r = await api(baseUrl, 'GET',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/diff`);

  assert.equal(r.status, 200);
  const file = r.body.files.find(f => f.path === 'utils.js');
  assert.ok(file, 'utils.js should appear in the diff');
  assert.equal(file.status, 'modified');
  assert.ok(file.adds > 0, 'should have additions');
  assert.ok(file.dels > 0, 'should have deletions');
});
