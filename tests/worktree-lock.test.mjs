// The user's worktree lock (WorktreeMeta.locked).
//
// One persisted flag, written by the browser route alone, that refuses two
// things: merging the locked worktree into its base (every merge surface, via
// the shared mergeWorktreeIntoParent) and an AGENT deleting it (MCP
// delete_worktree, even with force). It refuses nothing else: sync, a child
// merging INTO a locked base, and the human's REST delete all go through.
//
// Every refused fixture below is otherwise allowed — or refused for a DIFFERENT
// reason that the test shows by unlocking — so the lock is the only thing the
// refusal can be attributed to.
//
// The file-level beforeEach/afterEach run around every SUBTEST too, so each
// subtest builds its own fixture.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  api, bootServer, freshProjectsRoot, rmrf, registerLocalProject, waitFor, instForSession,
} from './helpers.mjs';
import {
  createWorktree, getWorktree, repairWorktreesAfterProjectMove,
} from '../src/worktrees.ts';
import { worktreeStoreDir, getProject } from '../src/projects.ts';
import { isDeadStatus } from '../src/instances.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SRC = path.join(__dirname, '..', 'src');

let ctx, baseUrl, wsUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, wsUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}
function gitCode(cwd, ...args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err) => {
      resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0);
    });
  });
}

async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

async function commitFile(cwd, filename, content, message) {
  await git(cwd, 'config', 'user.email', 'agent@example.com');
  await git(cwd, 'config', 'user.name', 'agent');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(cwd, filename), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '-m', message);
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();
}

const headSha = async (cwd) => (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const branchExists = async (repoPath, branch) =>
  (await gitCode(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)) === 0;
const metaFile = (wt) => path.join(worktreeStoreDir('demo', wt), 'worktree.json');
const readMetaFile = async (wt) => JSON.parse(await fs.readFile(metaFile(wt), 'utf8'));

const wtUrl = (wt, tail) => `/api/projects/demo/worktrees/${encodeURIComponent(wt)}/${tail}`;
const setLock = (wt, locked) => api(baseUrl, 'PUT', wtUrl(wt, 'lock'), { locked });
async function lock(wt) {
  const r = await setLock(wt, true);
  assert.equal(r.status, 200, `lock failed: ${JSON.stringify(r.body)}`);
}
async function unlock(wt) {
  const r = await setLock(wt, false);
  assert.equal(r.status, 200, `unlock failed: ${JSON.stringify(r.body)}`);
}

let nextRpcId = 1;
async function rpc(method, params) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);

// A worktree one commit ahead of a clean, unmoved base: merging it succeeds
// unless something refuses it.
async function mergeableWorktree(name = 'held') {
  const repoPath = await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name });
  await commitFile(wt.worktreePath, 'work.txt', 'work\n', 'agent work');
  return { repoPath, wt };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

// Invariant: the REST merge route refuses a locked worktree with
// WORKTREE_LOCKED before any git merge runs; unlocking alone makes the same
// merge succeed.
test('REST merge of a locked worktree is refused WORKTREE_LOCKED and runs no merge', async () => {
  const { repoPath, wt } = await mergeableWorktree();
  await lock(wt.worktreeName);
  const before = await headSha(repoPath);

  const r = await api(baseUrl, 'POST', wtUrl(wt.worktreeName, 'merge'));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'WORKTREE_LOCKED');
  assert.match(r.body.reason, /blocks merging/);
  assert.equal(await headSha(repoPath), before, 'the parent HEAD must not move');

  await unlock(wt.worktreeName);
  const ok = await api(baseUrl, 'POST', wtUrl(wt.worktreeName, 'merge'));
  assert.equal(ok.body.ok, true, `control merge failed: ${JSON.stringify(ok.body)}`);
});

// Invariant: MCP merge_worktree refuses a locked worktree with WORKTREE_LOCKED,
// passed through the handler unchanged, before any git merge runs.
test('MCP merge_worktree of a locked worktree is refused WORKTREE_LOCKED and runs no merge', async () => {
  const { repoPath, wt } = await mergeableWorktree();
  await lock(wt.worktreeName);
  const before = await headSha(repoPath);

  const r = unwrap(await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_LOCKED');
  assert.match(r.reason, /blocks merging/);
  assert.equal(await headSha(repoPath), before, 'the parent HEAD must not move');

  await unlock(wt.worktreeName);
  const ok = unwrap(await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName }));
  assert.equal(ok.ok, true, `control merge failed: ${JSON.stringify(ok)}`);
});

// Invariant: on merge the lock is checked BEFORE the dependents gate — a locked
// feature with a child answers WORKTREE_LOCKED, which unlocking turns into
// WORKTREE_HAS_DEPENDENTS (the control that the fixture really has dependents).
test('merging a locked feature with a child answers WORKTREE_LOCKED, not WORKTREE_HAS_DEPENDENTS', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'feature' });
  await createWorktree('demo', { baseWorktree: feature.worktreeName });
  await commitFile(feature.worktreePath, 'f.txt', 'f\n', 'feature work');
  await lock(feature.worktreeName);

  const r = unwrap(await callTool('merge_worktree', { project: 'demo', worktree: feature.worktreeName }));
  assert.equal(r.code, 'WORKTREE_LOCKED');

  await unlock(feature.worktreeName);
  const control = unwrap(await callTool('merge_worktree', { project: 'demo', worktree: feature.worktreeName }));
  assert.equal(control.code, 'WORKTREE_HAS_DEPENDENTS');
});

// Invariant: the merge gate reads the SOURCE worktree's record only — a child
// merges into a locked base, landing on the base's checkout.
test('a child merges into a locked base', async () => {
  await makeRealRepo('demo');
  const feature = await createWorktree('demo', { name: 'feature' });
  const task = await createWorktree('demo', { baseWorktree: feature.worktreeName });
  await lock(feature.worktreeName);
  await commitFile(task.worktreePath, 't.txt', 't\n', 'task work');

  const r = await api(baseUrl, 'POST', wtUrl(task.worktreeName, 'merge'));
  assert.equal(r.body.ok, true, `merge into a locked base failed: ${JSON.stringify(r.body)}`);
  assert.equal(await headSha(feature.worktreePath), r.body.newSha);
  assert.equal((await getWorktree('demo', feature.worktreeName)).locked, true);
});

// Invariant: sync neither reads nor clears the lock — both sync surfaces
// fast-forward a locked worktree, and the lock is still set afterwards.
test('sync of a locked worktree proceeds on REST and MCP and leaves the lock set', async () => {
  const repoPath = await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'held' });
  await lock(wt.worktreeName);

  await t_sync('REST', async () => (await api(baseUrl, 'POST', wtUrl(wt.worktreeName, 'sync'))).body);
  await t_sync('MCP', async () => unwrap(await callTool('sync_worktree', { project: 'demo', worktree: wt.worktreeName })));
  assert.equal((await getWorktree('demo', wt.worktreeName)).locked, true);

  async function t_sync(label, run) {
    await commitFile(repoPath, `${label}.txt`, `${label}\n`, `parent moves (${label})`);
    const r = await run();
    assert.equal(r.ok, true, `${label} sync failed: ${JSON.stringify(r)}`);
    assert.equal(r.action, 'fast-forwarded', label);
  }
});

// ---------------------------------------------------------------------------
// Agent delete
// ---------------------------------------------------------------------------

// Invariant: MCP delete_worktree refuses a locked worktree WORKTREE_LOCKED with
// and without force, ahead of WORKTREE_ATTACHED, and force reaches neither the
// kill nor the removal: record, checkout, branch and live worker all survive.
// The final step is the control: unlocked, the same force delete goes through.
// A locked worktree with a live worker attached to it.
async function lockedWithWorker() {
  const repoPath = await makeRealRepo('demo');
  const spawn = unwrap(await callTool('spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', createWorktree: true, name: 'held',
  }));
  await waitFor(() => instForSession(instances, spawn.sessionId)?.sessionId);
  const { worktreeName, worktreePath, branch } = instForSession(instances, spawn.sessionId).worktree;
  await lock(worktreeName);
  return { repoPath, spawn, worktreeName, worktreePath, branch };
}

test('MCP delete_worktree refuses a locked worktree, force or not, and touches nothing', async (t) => {
  for (const force of [false, true]) {
    await t.test(`force: ${force}`, async () => {
      const { repoPath, spawn, worktreeName, worktreePath, branch } = await lockedWithWorker();
      const r = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: worktreeName, force }));
      assert.equal(r.ok, false);
      assert.equal(r.code, 'WORKTREE_LOCKED');
      assert.match(r.reason, /force does not override/);
      assert.equal((await getWorktree('demo', worktreeName))?.locked, true, 'the record survives, still locked');
      assert.equal((await fs.stat(worktreePath)).isDirectory(), true, 'the checkout survives');
      assert.equal(await branchExists(repoPath, branch), true, 'the branch survives');
      const live = instForSession(instances, spawn.sessionId);
      assert.ok(live?.proc, 'the worker is still attached to a process');
      assert.equal(isDeadStatus(live.status), false, 'the worker was not killed');
    });
  }

  await t.test('control: unlocked, the same force delete removes it', async () => {
    const { repoPath, worktreeName, branch } = await lockedWithWorker();
    await unlock(worktreeName);
    const r = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: worktreeName, force: true }));
    assert.deepEqual(r, { project: 'demo', worktree: worktreeName });
    assert.equal(await getWorktree('demo', worktreeName), null);
    assert.equal(await branchExists(repoPath, branch), false);
  });
});

// Invariant: on delete the lock is checked BEFORE the `!force` block's dirty and
// dependents gates. Each subtest's control shows that, unlocked, the fixture is
// refused for that other reason.
test('MCP delete_worktree answers WORKTREE_LOCKED ahead of the dirty and dependents gates', async (t) => {
  await t.test('dirty', async () => {
    await makeRealRepo('demo');
    const wt = await createWorktree('demo', { name: 'dirty' });
    await fs.writeFile(path.join(wt.worktreePath, 'scratch.txt'), 'uncommitted\n');
    await lock(wt.worktreeName);
    const r = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: wt.worktreeName }));
    assert.equal(r.code, 'WORKTREE_LOCKED');
    await unlock(wt.worktreeName);
    const control = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: wt.worktreeName }));
    assert.equal(control.code, 'WORKTREE_DIRTY');
  });
  await t.test('dependents', async () => {
    await makeRealRepo('demo');
    const feature = await createWorktree('demo', { name: 'feature' });
    await createWorktree('demo', { baseWorktree: feature.worktreeName });
    await lock(feature.worktreeName);
    const r = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: feature.worktreeName }));
    assert.equal(r.code, 'WORKTREE_LOCKED');
    await unlock(feature.worktreeName);
    const control = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: feature.worktreeName }));
    assert.equal(control.code, 'WORKTREE_HAS_DEPENDENTS');
  });
});

// Invariant: the human's REST delete ignores the lock — a locked, clean
// worktree with no worker is removed.
test('REST DELETE removes a locked worktree', async () => {
  await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'held' });
  await lock(wt.worktreeName);
  const r = await api(baseUrl, 'DELETE', `/api/projects/demo/worktrees/${wt.worktreeName}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await getWorktree('demo', wt.worktreeName), null);
});

// ---------------------------------------------------------------------------
// Persistence and contract
// ---------------------------------------------------------------------------

// Invariant: worktree.json on disk is the lock's one source. Locking adds
// `locked: true` and changes no other field; unlocking removes the key rather
// than writing false; a hand-written `locked: true` (what a restarted server
// finds) is enforced by both agent gates.
test('the lock persists in worktree.json, unlocks to an absent key, and is read back from disk', async () => {
  const { wt } = await mergeableWorktree();
  const original = await readMetaFile(wt.worktreeName);
  assert.equal('locked' in original, false, 'precondition: a fresh record carries no lock');

  await lock(wt.worktreeName);
  assert.deepEqual(await readMetaFile(wt.worktreeName), { ...original, locked: true });

  await unlock(wt.worktreeName);
  const unlocked = await readMetaFile(wt.worktreeName);
  assert.equal('locked' in unlocked, false, 'unlock deletes the key');
  assert.deepEqual(unlocked, original);

  await fs.writeFile(metaFile(wt.worktreeName), JSON.stringify({ ...original, locked: true }, null, 2) + '\n');
  const merge = unwrap(await callTool('merge_worktree', { project: 'demo', worktree: wt.worktreeName }));
  assert.equal(merge.code, 'WORKTREE_LOCKED');
  const del = unwrap(await callTool('delete_worktree', { project: 'demo', worktree: wt.worktreeName }));
  assert.equal(del.code, 'WORKTREE_LOCKED');
});

// Invariant: deleting a worktree takes its lock with it — a worktree
// re-created under the same name starts unlocked and merges.
test('a worktree re-created under a deleted locked one\'s name is not locked', async () => {
  await makeRealRepo('demo');
  const first = await createWorktree('demo', { name: 'reuse' });
  await lock(first.worktreeName);
  const del = await api(baseUrl, 'DELETE', `/api/projects/demo/worktrees/${first.worktreeName}`);
  assert.equal(del.status, 200);

  const second = await createWorktree('demo', { name: 'reuse' });
  assert.equal(second.worktreeName, first.worktreeName, 'precondition: the same name');
  assert.equal('locked' in await readMetaFile(second.worktreeName), false);
  await commitFile(second.worktreePath, 'n.txt', 'n\n', 'new work');
  const r = await api(baseUrl, 'POST', wtUrl(second.worktreeName, 'merge'));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});

// Invariant: the lock route validates `locked` as a boolean (400), 404s an
// unknown worktree naming the real ones, answers {ok, worktree, locked} with
// the canonical name, invalidates the cached /api/projects listing, and
// broadcasts the {t:'projects'} hint.
test('PUT …/lock: validation, 404, response shape, cache invalidation and the projects hint', async (t) => {
  const fixture = async () => { await makeRealRepo('demo'); return createWorktree('demo', { name: 'held' }); };

  await t.test('a non-boolean `locked` is 400', async () => {
    const wt = await fixture();
    for (const body of [{}, { locked: 'true' }, { locked: 1 }, { locked: null }]) {
      const r = await api(baseUrl, 'PUT', wtUrl(wt.worktreeName, 'lock'), body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, /locked must be a boolean/);
    }
    assert.equal('locked' in await readMetaFile(wt.worktreeName), false, 'nothing was written');
  });

  await t.test('an unknown worktree is 404 naming the real ones', async () => {
    await fixture();
    const r = await setLock('nosuch', true);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /'nosuch' not found/);
    assert.match(r.body.error, /held/);
  });

  await t.test('the response carries the stored state', async () => {
    const wt = await fixture();
    assert.deepEqual((await setLock(wt.worktreeName, true)).body, { ok: true, worktree: 'held', locked: true });
    assert.deepEqual((await setLock(wt.worktreeName, false)).body, { ok: true, worktree: 'held', locked: false });
  });

  await t.test('the cached listing shows the change at once', async () => {
    await fixture();
    const cache = await import('../src/projectsCache.ts');
    cache._resetForTest(60_000);
    try {
      const lockedOf = async () => (await api(baseUrl, 'GET', '/api/projects')).body
        .find(p => p.name === 'demo').worktrees.find(w => w.worktreeName === 'held').locked;
      assert.equal(await lockedOf(), undefined);
      // Behind the server's back: the cache has not seen this write.
      await fs.writeFile(metaFile('held'), JSON.stringify({ ...await readMetaFile('held'), locked: true }, null, 2));
      assert.equal(await lockedOf(), undefined, 'control: the cache is serving');
      await fs.writeFile(metaFile('held'), JSON.stringify((({ locked, ...rest }) => rest)(await readMetaFile('held')), null, 2));
      await lock('held');
      assert.equal(await lockedOf(), true);
    } finally { cache._resetForTest(0); }
  });

  await t.test('the route broadcasts the projects hint', async () => {
    await fixture();
    const ws = new WebSocket(wsUrl);
    const seen = [];
    await new Promise(resolve => { ws.once('open', resolve); });
    ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    try {
      await unlock('held');
      await waitFor(() => seen.some(m => m.t === 'projects'));
    } finally { ws.close(); }
  });
});

// Invariant: the worktree-scoped commits route reports the lock in step with
// it, and the project-scoped one carries no `locked` key.
test('GET …/commits carries `locked` for a worktree and not for the project', async () => {
  await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'held' });
  const lockedOf = async () => (await api(baseUrl, 'GET', wtUrl(wt.worktreeName, 'commits'))).body.locked;
  assert.equal(await lockedOf(), false);
  await lock(wt.worktreeName);
  assert.equal(await lockedOf(), true);
  await unlock(wt.worktreeName);
  assert.equal(await lockedOf(), false);
  const project = await api(baseUrl, 'GET', '/api/projects/demo/commits');
  assert.equal(project.status, 200);
  assert.equal('locked' in project.body, false);
});

async function tsFiles(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await tsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Invariant: no agent can set or clear the lock. The writer is named by no MCP
// module and imported by routes.ts alone, and no MCP tool is a lock tool.
test('the lock writer is browser-only: routes.ts imports it, nothing under src/mcp names it, no lock tool exists', async () => {
  const files = await tsFiles(SRC);
  const rel = (f) => path.relative(SRC, f);
  const bodies = new Map(await Promise.all(files.map(async f => [rel(f), await fs.readFile(f, 'utf8')])));
  const mcpHits = [...bodies].filter(([f, b]) => f.startsWith('mcp' + path.sep) && /setWorktreeLock/.test(b))
    .map(([f]) => f);
  assert.deepEqual(mcpHits, [], 'no MCP module names the lock writer');
  const importers = [...bodies].filter(([, b]) => /import[^;]*\bsetWorktreeLock\b[^;]*from/.test(b)).map(([f]) => f);
  assert.deepEqual(importers, ['routes.ts'], 'routes.ts is the one importer (positive control: the sweep finds it)');

  const { body } = await rpc('tools/list', {});
  const names = body.result.tools.map(tool => tool.name);
  assert.ok(names.includes('merge_worktree'), 'control: the tool list is the real one');
  assert.deepEqual(names.filter(n => /lock/i.test(n)), []);
});

// Invariant: the project-move repair rewrites a root-based record's parentPath
// through the read-modify-write, keeping the lock (and every other field).
test('repairWorktreesAfterProjectMove keeps the lock while it rewrites parentPath', async () => {
  await makeRealRepo('demo');
  const wt = await createWorktree('demo', { name: 'held' });
  await lock(wt.worktreeName);
  const stale = { ...await readMetaFile(wt.worktreeName), parentPath: path.join(projectsRoot, 'moved-away') };
  await fs.writeFile(metaFile(wt.worktreeName), JSON.stringify(stale, null, 2) + '\n');

  await repairWorktreesAfterProjectMove('demo');

  const after = await readMetaFile(wt.worktreeName);
  assert.equal(after.parentPath, (await getProject('demo')).path, 'control: the repair rewrote the record');
  assert.deepEqual(after, { ...stale, parentPath: after.parentPath });
  assert.equal(after.locked, true);
});
