// Integration + unit tests for the per-project git-facts cache
// (src/projectsCache.js).
//
// Unit tests exercise TTL caching, coalescing, and invalidation directly on the
// module with _resetForTest(). Integration tests drive the full REST surface via
// bootServer(), which calls _resetForTest() with TTL=0 (pure coalescing) so
// integration tests always see exact, live data — the same correctness guarantee
// as the uncached baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api } from './helpers.mjs';
import { getOrCompute, invalidate, invalidateAll, _resetForTest } from '../src/projectsCache.js';

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
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// ── Unit-level cache tests ─────────────────────────────────────────────────────
// These call _resetForTest(ttlMs) directly to control TTL per-test.

test('getOrCompute caches result within TTL and serves it without recomputing', async () => {
  _resetForTest(2000); // explicit non-zero TTL for this test
  let calls = 0;
  const fn = async () => { calls++; return { value: 42 }; };

  const first = await getOrCompute('k', fn);
  const second = await getOrCompute('k', fn); // within TTL → cache hit

  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(calls, 1, 'computeFn called only once within TTL');
});

test('getOrCompute coalesces concurrent callers onto one in-flight Promise', async () => {
  _resetForTest(0); // TTL=0: each completed result expires immediately
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 30));
    return { calls };
  };

  // All three start before any completes → they share the first in-flight.
  const [a, b, c] = await Promise.all([
    getOrCompute('k', fn),
    getOrCompute('k', fn),
    getOrCompute('k', fn),
  ]);

  assert.equal(calls, 1, 'only one computation ran despite three concurrent callers');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('invalidate clears TTL-cached entry so next call recomputes', async () => {
  _resetForTest(2000);
  let n = 0;
  const fn = async () => ({ n: ++n });

  await getOrCompute('k', fn); // n=1, cached
  assert.equal(n, 1);

  invalidate('k'); // clear cache
  const result = await getOrCompute('k', fn); // n=2, fresh computation
  assert.equal(result.n, 2, 'recomputed after invalidate');
  assert.equal(n, 2);
});

test('invalidate discards in-flight result if it completes after invalidation', async () => {
  _resetForTest(2000);
  let n = 0;
  let resolveInflight;

  const slowFn = () => new Promise((resolve) => {
    n++;
    resolveInflight = () => resolve({ n });
  });

  // Start an in-flight computation, then immediately invalidate.
  const inflightPromise = getOrCompute('k', slowFn);
  invalidate('k');

  // Let the original (now-invalidated) computation finish.
  resolveInflight();
  const inflightResult = await inflightPromise;
  assert.equal(inflightResult.n, 1);

  // The cache must NOT have stored the invalidated result; the next
  // getOrCompute should call the fn again.
  let n2 = 0;
  const freshResult = await getOrCompute('k', async () => ({ n: ++n2 + 10 }));
  assert.equal(freshResult.n, 11, 'cache was not polluted by the invalidated in-flight');
});

test('invalidateAll clears all TTL-cached entries', async () => {
  _resetForTest(2000);
  let calls = { a: 0, b: 0 };

  await getOrCompute('a', async () => { calls.a++; return 'aaa'; }); // cached
  await getOrCompute('b', async () => { calls.b++; return 'bbb'; }); // cached
  assert.equal(calls.a, 1);
  assert.equal(calls.b, 1);

  invalidateAll();

  await getOrCompute('a', async () => { calls.a++; return 'aaa'; }); // recomputed
  await getOrCompute('b', async () => { calls.b++; return 'bbb'; }); // recomputed
  assert.equal(calls.a, 2, 'key a recomputed after invalidateAll');
  assert.equal(calls.b, 2, 'key b recomputed after invalidateAll');
});

// ── Integration tests via the REST API ────────────────────────────────────────
// bootServer() calls _resetForTest() which sets TTL=0 — integration tests always
// receive exact, live data (pure-coalescing mode).

test('concurrent GET /api/projects requests return consistent data (coalescing)', async () => {
  const ctx = await bootServer();
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Fire several requests in parallel — they should all receive the same
    // result; the in-flight coalescing ensures only one git fan-out runs.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api(ctx.baseUrl, 'GET', '/api/projects')),
    );

    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.equal(r.body[0].name, 'demo');
      assert.equal(r.body[0].isGitRepo, true);
    }

    // All responses should be structurally identical.
    const first = JSON.stringify(results[0].body);
    for (const r of results.slice(1)) {
      assert.equal(JSON.stringify(r.body), first, 'all concurrent responses are identical');
    }
  } finally { await ctx.close(); }
});

test('GET /api/projects returns correct shape with cached git facts', async () => {
  const ctx = await bootServer();
  try {
    await makeRealRepo(ctx.projectsRoot, 'alpha');
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'alpha' });

    const first = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(first.status, 200);
    assert.equal(first.body[0].isGitRepo, true);
    assert.ok(Array.isArray(first.body[0].worktrees));
    assert.ok('mergeStatus' in first.body[0]);

    // Second sequential call — exercises the code path, verifies shape.
    const second = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(second.status, 200);
    assert.equal(second.body[0].isGitRepo, true);
  } finally { await ctx.close(); }
});

test('cache invalidated after DELETE worktree — subsequent fetch returns fresh state', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Create an instance with worktree:true so the orchestrator creates a git
    // worktree and registers it.
    const spawn = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', worktree: true,
    });
    assert.equal(spawn.status, 201);
    const worktreeName = spawn.body.worktree.worktreeName;

    // Warm the path — verify the worktree is present.
    const before = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(before.status, 200);
    assert.equal(before.body[0].worktrees.length, 1, 'worktree present before delete');

    // Kill the live instance so DELETE doesn't refuse due to an attached proc.
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${spawn.body.id}`);

    // DELETE must invalidate the cache synchronously (before sending 200) so
    // the immediately following GET cannot race a stale entry.
    const del = await api(ctx.baseUrl, 'DELETE', `/api/projects/demo/worktrees/${worktreeName}`);
    assert.equal(del.status, 200);

    const after = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(after.status, 200);
    assert.equal(after.body[0].worktrees.length, 0, 'worktree absent after delete + cache invalidation');
  } finally { await ctx.close(); }
});

test('cache invalidated after DELETE project — subsequent fetch returns empty list', async () => {
  const ctx = await bootServer();
  try {
    await makeRealRepo(ctx.projectsRoot, 'beta');
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'beta' });

    const before = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(before.body.length, 1);

    await api(ctx.baseUrl, 'DELETE', '/api/projects/beta');

    const after = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(after.status, 200);
    assert.equal(after.body.length, 0, 'project absent after delete + cache invalidation');
  } finally { await ctx.close(); }
});
