// Integration tests for the project commit-history routes:
//   GET /api/projects/:name/commits
//   GET /api/projects/:name/commits/:sha/diff

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api } from './helpers.mjs';

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

async function commitFile(repoPath, file, content, message) {
  await fs.writeFile(path.join(repoPath, file), content);
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', message);
}

test('GET /commits returns the current branch history newest-first', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await commitFile(repoPath, 'feature.js', 'export function hello() {}\n', 'add feature');

    const r = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits');
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
  } finally { await ctx.close(); }
});

test('GET /commits respects ?limit and flags truncation', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await commitFile(repoPath, 'a.js', 'a\n', 'commit a');
    await commitFile(repoPath, 'b.js', 'b\n', 'commit b');

    const r = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits?limit=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.commits.length, 1, 'limit=1 returns one commit');
    assert.equal(r.body.limit, 1);
    assert.equal(r.body.truncated, true, 'truncated when more commits exist');
    assert.equal(r.body.commits[0].subject, 'commit b', 'newest commit returned');
  } finally { await ctx.close(); }
});

test('GET /commits/:sha/diff returns only that commit\'s change', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repoPath = await makeRealRepo(ctx.projectsRoot, 'demo');
    await commitFile(repoPath, 'feature.js', 'export function hello() {}\n', 'add feature');

    const list = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits');
    const sha = list.body.commits[0].sha; // the "add feature" commit

    const r = await api(ctx.baseUrl, 'GET', `/api/projects/demo/commits/${sha}/diff`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.project, 'demo');
    assert.equal(r.body.sha, sha);
    assert.ok(Array.isArray(r.body.files), 'files should be an array');
    assert.equal(r.body.files.length, 1, 'one changed file in this commit');
    assert.equal(r.body.files[0].path, 'feature.js');
    assert.equal(r.body.files[0].status, 'added');
    assert.ok(r.body.files[0].adds > 0, 'should have additions');
    assert.ok(r.body.totalAdds > 0, 'totalAdds should be > 0');
    assert.equal(r.body.totalDels, 0);
    assert.equal(r.body.truncated, false);
  } finally { await ctx.close(); }
});

test('GET /commits/:sha/diff works for the root commit', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const list = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits');
    const rootSha = list.body.commits[list.body.commits.length - 1].sha;

    const r = await api(ctx.baseUrl, 'GET', `/api/projects/demo/commits/${rootSha}/diff`);
    assert.equal(r.status, 200);
    const file = r.body.files.find(f => f.path === 'README.md');
    assert.ok(file, 'README.md should appear in the root commit diff');
    assert.equal(file.status, 'added');
  } finally { await ctx.close(); }
});

test('GET /commits/:sha/diff rejects a non-hex sha with 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const r = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits/zzz/diff');
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  } finally { await ctx.close(); }
});

test('GET /commits/:sha/diff returns 404 for an unknown commit', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const r = await api(ctx.baseUrl, 'GET', '/api/projects/demo/commits/deadbeef/diff');
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  } finally { await ctx.close(); }
});

test('GET /commits returns empty history for a non-git project', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await fs.mkdir(path.join(ctx.projectsRoot, 'plain'), { recursive: true });
    const r = await api(ctx.baseUrl, 'GET', '/api/projects/plain/commits');
    assert.equal(r.status, 200);
    assert.equal(r.body.branch, null);
    assert.deepEqual(r.body.commits, []);
    assert.equal(r.body.truncated, false);
  } finally { await ctx.close(); }
});

test('GET /commits returns 404 for an unknown project', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const r = await api(ctx.baseUrl, 'GET', '/api/projects/nope/commits');
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  } finally { await ctx.close(); }
});
