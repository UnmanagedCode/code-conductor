// Integration tests for the GET /api/projects/:name/worktrees/:wt/diff route.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';

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
  assert.ok(Array.isArray(r.body.files[0].hunks), 'hunks should be an array');
  assert.ok(r.body.files[0].hunks.length > 0, 'at least one hunk');
  assert.ok(r.body.totalAdds > 0, 'totalAdds should be > 0');
  assert.equal(r.body.totalDels, 0);
  assert.equal(r.body.truncated, false);
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
  assert.equal(r.body.truncated, false);
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
