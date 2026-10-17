// Integration tests for the per-project post-worktree-merge hook: resolved like
// the create hook, run in the merge target after the merge lands, serialised per
// project, reported as `postWorktreeMerge`, and never able to change `ok`.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { createWorktree, mergeWorktreeIntoParent, runWorktreeHook } from '../src/worktrees.ts';
import { projectStoreDir } from '../src/projects.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { posixPlatform } from '../src/platform/posix.ts';
import { createWin32Platform } from '../src/platform/win32.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const HOOK = 'post-worktree-merge.sh';

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
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
const headOf = async (dir) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();

async function makeRealRepo(name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// An in-tree merge hook, COMMITTED: an untracked one would leave the parent
// dirty and the merge would be refused PARENT_DIRTY before any hook ran.
async function installHook(repoPath, body, { mode = 0o755 } = {}) {
  const hookDir = path.join(repoPath, '.code-conductor');
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, HOOK);
  await fs.writeFile(hookPath, body, { mode });
  await fs.chmod(hookPath, mode);
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'add merge hook');
  return hookPath;
}

async function installStoreHook(project, body) {
  const storeDir = projectStoreDir(project);
  await fs.mkdir(storeDir, { recursive: true });
  const hookPath = path.join(storeDir, HOOK);
  await fs.writeFile(hookPath, body, { mode: 0o755 });
  return hookPath;
}

// A worktree with one commit on its branch, so a merge has something to land.
async function worktreeWithCommit(project, opts = {}, file = 'feature.txt') {
  const wt = await createWorktree(project, opts);
  await fs.writeFile(path.join(wt.worktreePath, file), `${file}\n`);
  await git(wt.worktreePath, 'add', '-A');
  await git(wt.worktreePath, 'commit', '-q', '-m', `add ${file}`);
  return wt;
}

async function withEnv(vars, body) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await body(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── Resolution ─────────────────────────────────────────────────────────────

test('no hook: the merge succeeds and postWorktreeMerge.ran is false', async () => {
  await makeRealRepo('demo');
  const wt = await worktreeWithCommit('demo');
  const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.postWorktreeMerge, { ran: false });
});

test('in-tree only: runs, source="in-tree"', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho in-tree-merge-hook\n');
  const wt = await worktreeWithCommit('demo');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.equal(h.ran, true, JSON.stringify(h));
  assert.equal(h.source, 'in-tree');
  assert.equal(h.exitCode, 0);
  assert.match(h.output, /in-tree-merge-hook/);
});

test('store only: runs, source="store"', async () => {
  await makeRealRepo('demo');
  await installStoreHook('demo', '#!/bin/sh\necho store-merge-hook\n');
  const wt = await worktreeWithCommit('demo');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.equal(h.ran, true, JSON.stringify(h));
  assert.equal(h.source, 'store');
  assert.match(h.output, /store-merge-hook/);
});

test('both present: the in-tree hook wins and the store one does not run', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho in-tree-merge-hook\n');
  await installStoreHook('demo', '#!/bin/sh\necho store-merge-hook\n');
  const wt = await worktreeWithCommit('demo');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.equal(h.source, 'in-tree');
  assert.match(h.output, /in-tree-merge-hook/);
  assert.doesNotMatch(h.output, /store-merge-hook/);
});

test('the create hook is not the merge hook: a post-worktree-create.sh alone does not run on merge', async () => {
  await makeRealRepo('demo');
  const storeDir = projectStoreDir('demo');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, 'post-worktree-create.sh'), '#!/bin/sh\necho create-hook\n', { mode: 0o755 });
  const wt = await worktreeWithCommit('demo');
  assert.equal(wt.postWorktreeCreate.ran, true, 'premise: the create hook ran at create');
  const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
  assert.deepEqual(r.postWorktreeMerge, { ran: false });
});

test('the in-tree hook is read from the target AFTER the merge: a branch that edits it runs its own version', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho hook-v1\n');
  const wt = await createWorktree('demo');
  await fs.writeFile(path.join(wt.worktreePath, '.code-conductor', HOOK), '#!/bin/sh\necho hook-v2\n', { mode: 0o755 });
  await git(wt.worktreePath, 'commit', '-q', '-am', 'hook v2');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.match(h.output, /hook-v2/);
  assert.doesNotMatch(h.output, /hook-v1/);
});

// ── Environment and cwd ────────────────────────────────────────────────────

test('env: the base CC_* vars, CC_PRE_MERGE_SHA = the target HEAD before the merge, CC_POST_MERGE_SHA = newSha, CC_SERVER_NODE = this node; no boot vars without a server', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, [
    '#!/bin/sh',
    'echo "PRE=$CC_PRE_MERGE_SHA"',
    'echo "POST=$CC_POST_MERGE_SHA"',
    'echo "WT=$CC_WORKTREE_PATH"',
    'echo "PROJECT=$CC_PROJECT_NAME"',
    'echo "BRANCH=$CC_BRANCH"',
    'echo "BASE=$CC_BASE_BRANCH"',
    'echo "PARENT=$CC_PARENT_PATH"',
    'echo "NODE=$CC_SERVER_NODE"',
    'echo "BOOT=${CC_SERVER_BOOT_SHA-unset}/${CC_SERVER_BOOT_UNKNOWN-unset}"',
    'echo "CHANGED=$(git diff --name-only "$CC_PRE_MERGE_SHA" "$CC_POST_MERGE_SHA" | tr "\\n" " ")"',
  ].join('\n') + '\n');
  const wt = await worktreeWithCommit('demo', {}, 'merged-file.txt');
  const before = await headOf(repo);
  const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = r.postWorktreeMerge.output;
  const val = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1];
  assert.equal(val('PRE'), before);
  assert.notEqual(val('PRE'), r.newSha);
  assert.equal(val('POST'), r.newSha);
  assert.equal(val('POST'), await headOf(repo));
  assert.equal(val('WT'), wt.worktreePath);
  assert.equal(val('PROJECT'), 'demo');
  assert.equal(val('BRANCH'), wt.branch);
  assert.equal(val('BASE'), 'main');
  assert.equal(val('PARENT'), wt.parentPath);
  assert.equal(val('NODE'), process.execPath);
  assert.equal(val('BOOT'), 'unset/unset', 'only a running server hands over a boot commit (tests/server-boot-commit.test.mjs)');
  assert.equal(val('CHANGED').trim(), 'merged-file.txt', 'the PRE..POST diff lists exactly what the merge brought in');
});

test('cwd is the merge target (the parent checkout), and the parent is left clean', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\npwd -P\n');
  const wt = await worktreeWithCommit('demo');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.equal(h.output.trim(), await fs.realpath(repo));
  assert.equal((await git(repo, 'status', '--porcelain')).stdout, '');
});

test('chained base: merging a task into its feature runs the hook in the feature checkout', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\npwd -P\necho "PARENT=$CC_PARENT_PATH"\n');
  const feature = await createWorktree('demo', { name: 'feat' });
  const task = await worktreeWithCommit('demo', { baseWorktree: feature.worktreeName, name: 'task' });
  const r = await mergeWorktreeIntoParent('demo', task.worktreeName);
  assert.equal(r.ok, true, JSON.stringify(r));
  const [cwd] = r.postWorktreeMerge.output.split('\n');
  assert.equal(cwd, await fs.realpath(feature.worktreePath));
  assert.match(r.postWorktreeMerge.output, new RegExp(`^PARENT=${feature.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(r.newSha, await headOf(feature.worktreePath), 'premise: the merge landed in the feature');
});

// ── A hook never changes `ok` ──────────────────────────────────────────────

test('hook exits 1: ok stays true, the merge has landed, exitCode=1', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho "build failed" >&2\nexit 1\n');
  const wt = await worktreeWithCommit('demo');
  const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.newSha, await headOf(repo));
  assert.equal(r.postWorktreeMerge.ran, true);
  assert.equal(r.postWorktreeMerge.exitCode, 1);
  assert.match(r.postWorktreeMerge.output, /build failed/);
});

test('hook timeout (ORCH_POST_WORKTREE_MERGE_TIMEOUT_MS): ok stays true, timedOut, exitCode null', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\nsleep 1\n');
  const wt = await worktreeWithCommit('demo');
  await withEnv({ ORCH_POST_WORKTREE_MERGE_TIMEOUT_MS: '100' }, async () => {
    const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.postWorktreeMerge.timedOut, true);
    assert.equal(r.postWorktreeMerge.exitCode, null);
  });
});

test('the create timeout variable does not bound the merge hook', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\nsleep 0.3\necho done\n');
  const wt = await worktreeWithCommit('demo');
  await withEnv({ ORCH_POST_WORKTREE_TIMEOUT_MS: '50' }, async () => {
    const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
    assert.equal(h.timedOut, undefined, JSON.stringify(h));
    assert.equal(h.exitCode, 0);
  });
});

test('output over the cap is kept as a truncated tail', async () => {
  const repo = await makeRealRepo('demo');
  const big = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(85)}`).join('\n');
  await installHook(repo, `#!/bin/sh\nprintf '${big}\\n'\n`);
  const wt = await worktreeWithCommit('demo');
  const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
  assert.equal(h.truncated, true);
  assert.ok(h.output.startsWith('… [truncated]'), h.output.slice(0, 60));
  assert.match(h.output, /line-0199/, 'the tail is what is kept');
  assert.ok(h.output.length <= 16 * 1024 + 200);
});

test('a non-executable in-tree hook still runs, and is left as committed, so the target stays mergeable', async () => {
  const repo = await makeRealRepo('demo');
  const hookPath = await installHook(repo, '#!/bin/sh\necho not-executable\n', { mode: 0o644 });
  const first = await worktreeWithCommit('demo', { name: 'one' }, 'one.txt');
  const h = (await mergeWorktreeIntoParent('demo', first.worktreeName)).postWorktreeMerge;
  assert.equal(h.exitCode, 0, JSON.stringify(h));
  assert.match(h.output, /not-executable/);
  assert.equal((await fs.stat(hookPath)).mode & 0o111, 0, 'no exec bit was added');
  // A mode change would read as dirty and refuse this next merge PARENT_DIRTY.
  const second = await worktreeWithCommit('demo', { name: 'two' }, 'two.txt');
  const r = await mergeWorktreeIntoParent('demo', second.worktreeName);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ── Kill switches are per hook ─────────────────────────────────────────────

test('ORCH_DISABLE_POST_WORKTREE_MERGE_HOOK=1 skips the merge hook: skipped="disabled"', async () => {
  const repo = await makeRealRepo('demo');
  const marker = path.join(home, 'merge-hook-ran');
  await installHook(repo, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  const wt = await worktreeWithCommit('demo');
  await withEnv({ ORCH_DISABLE_POST_WORKTREE_MERGE_HOOK: '1' }, async () => {
    const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
    assert.equal(r.ok, true);
    assert.deepEqual(r.postWorktreeMerge, { ran: false, skipped: 'disabled' });
  });
  assert.equal(await exists(marker), false);
});

test('the create kill switch does not disable the merge hook', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho merge-ran\n');
  await withEnv({ ORCH_DISABLE_POST_WORKTREE_HOOK: '1' }, async () => {
    const wt = await worktreeWithCommit('demo');
    const h = (await mergeWorktreeIntoParent('demo', wt.worktreeName)).postWorktreeMerge;
    assert.equal(h.ran, true, JSON.stringify(h));
    assert.match(h.output, /merge-ran/);
  });
});

test('the merge kill switch does not disable the create hook', async () => {
  await makeRealRepo('demo');
  const storeDir = projectStoreDir('demo');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, 'post-worktree-create.sh'), '#!/bin/sh\necho create-ran\n', { mode: 0o755 });
  await withEnv({ ORCH_DISABLE_POST_WORKTREE_MERGE_HOOK: '1' }, async () => {
    const wt = await createWorktree('demo');
    assert.equal(wt.postWorktreeCreate.ran, true, JSON.stringify(wt.postWorktreeCreate));
    assert.match(wt.postWorktreeCreate.output, /create-ran/);
  });
});

// ── Only a landed merge runs it ────────────────────────────────────────────

test('a refused merge (NOTHING_TO_MERGE) runs no hook', async () => {
  await makeRealRepo('demo');
  const marker = path.join(home, 'merge-hook-ran');
  await installStoreHook('demo', `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  const wt = await createWorktree('demo');
  const r = await mergeWorktreeIntoParent('demo', wt.worktreeName);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOTHING_TO_MERGE');
  assert.equal('postWorktreeMerge' in r, false);
  assert.equal(await exists(marker), false);
});

// ── Serialised per project ─────────────────────────────────────────────────

test('two merges into one project at once run their hooks one at a time', async () => {
  await makeRealRepo('demo');
  // Different git targets (the root and a feature checkout), so git itself
  // never makes them collide; only the queue can keep the hooks apart. The
  // hook exits 3 when it finds the other one still running.
  const lock = path.join(home, 'merge-hook-lock');
  await installStoreHook('demo', [
    '#!/bin/sh',
    `mkdir ${JSON.stringify(lock)} 2>/dev/null || { echo overlap; exit 3; }`,
    'sleep 0.3',
    `rmdir ${JSON.stringify(lock)}`,
  ].join('\n') + '\n');
  const onRoot = await worktreeWithCommit('demo', { name: 'onroot' }, 'u.txt');
  const feature = await createWorktree('demo', { name: 'feat' });
  const task = await worktreeWithCommit('demo', { baseWorktree: feature.worktreeName, name: 'task' }, 't.txt');
  const [a, b] = await Promise.all([
    mergeWorktreeIntoParent('demo', onRoot.worktreeName),
    mergeWorktreeIntoParent('demo', task.worktreeName),
  ]);
  for (const r of [a, b]) {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.postWorktreeMerge.exitCode, 0, JSON.stringify(r.postWorktreeMerge));
  }
});

// ── Surfaces ───────────────────────────────────────────────────────────────

async function mcp(method, params) {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
}

test('REST POST /api/projects/:name/worktrees/:wt/merge carries postWorktreeMerge', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho rest-merge-hook\n');
  const wt = await worktreeWithCommit('demo');
  const r = await api(baseUrl, 'POST', `/api/projects/demo/worktrees/${wt.worktreeName}/merge`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.postWorktreeMerge.exitCode, 0);
  assert.match(r.body.postWorktreeMerge.output, /rest-merge-hook/);
});

test('MCP merge_worktree carries postWorktreeMerge', async () => {
  const repo = await makeRealRepo('demo');
  await installHook(repo, '#!/bin/sh\necho mcp-merge-hook\n');
  const wt = await worktreeWithCommit('demo');
  const result = await mcp('tools/call', { name: 'merge_worktree', arguments: { project: 'demo', worktree: wt.worktreeName } });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.postWorktreeMerge.exitCode, 0);
  assert.match(body.postWorktreeMerge.output, /mcp-merge-hook/);
});

test('the merge_worktree description names postWorktreeMerge', async () => {
  const { tools } = await mcp('tools/list', {});
  const tool = tools.find((t) => t.name === 'merge_worktree');
  assert.match(tool.description, /postWorktreeMerge/);
});

// ── Platform parity: the hook's argv, recorded and mapped for win32 ─────────

function recordingPlatform(commandFor = (spec) => posixPlatform.commandFor(spec)) {
  const specs = [];
  return {
    specs,
    platform: {
      ...posixPlatform,
      commandFor: (spec) => { specs.push(structuredClone(spec)); return commandFor(spec); },
    },
  };
}

async function hookFixture() {
  const parent = path.join(home, 'parent');
  await fs.mkdir(path.join(parent, '.code-conductor'), { recursive: true });
  for (const name of ['post-worktree-create.sh', HOOK]) {
    await fs.writeFile(path.join(parent, '.code-conductor', name), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  }
  const meta = {
    parentProject: 'demo', parentPath: parent, worktreeName: 'wt', worktreePath: parent,
    branch: 'code-conductor/wt', baseBranch: 'main', baseSha: 'a'.repeat(40), createdAt: new Date().toISOString(),
  };
  return { parent, meta };
}

const MERGE_VARS = { CC_PRE_MERGE_SHA: 'b'.repeat(40), CC_POST_MERGE_SHA: 'c'.repeat(40) };

for (const event of ['create', 'merge']) {
  test(`${event} hook: one argv spec, env CC_*=… bash <script>, no shell; win32 maps env and bash into Git and keeps every CC_* arg`, async () => {
    const { parent, meta } = await hookFixture();
    const rec = recordingPlatform();
    const vars = event === 'merge' ? MERGE_VARS : {};
    const h = await runWorktreeHook(new LocalSystem(rec.platform), event, meta, { cwd: parent, vars });
    assert.equal(h.exitCode, 0, JSON.stringify(h));
    const script = path.join(parent, '.code-conductor', event === 'merge' ? HOOK : 'post-worktree-create.sh');
    const hookSpecs = rec.specs.filter((s) => s.argv?.includes(script));
    assert.equal(hookSpecs.length, 1, JSON.stringify(rec.specs));
    const [spec] = hookSpecs;
    assert.equal('shell' in spec, false);
    const ccArgs = [
      `CC_WORKTREE_PATH=${meta.worktreePath}`, `CC_PROJECT_NAME=demo`, `CC_BRANCH=${meta.branch}`,
      `CC_BASE_BRANCH=main`, `CC_PARENT_PATH=${parent}`,
      ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    ];
    assert.deepEqual(spec.argv, ['env', ...ccArgs, 'bash', script]);

    const GIT = 'C:\\Program Files\\Git';
    const BASH = `${GIT}\\bin\\bash.exe`;
    const win = createWin32Platform({
      env: { CLAUDE_CODE_GIT_BASH_PATH: BASH }, exists: (p) => p === BASH, execFileSync: () => {},
      realpathNative: (p) => p, realpathJs: (p) => p,
    });
    assert.deepEqual(win.commandFor(spec), { command: `${GIT}\\usr\\bin\\env.exe`, args: [...ccArgs, BASH, script] });
  });
}

test('a hook whose platform command cannot be spawned reports ran:true, error:true', async () => {
  const { parent, meta } = await hookFixture();
  const rec = recordingPlatform(() => ({ command: path.join(home, 'no-such-binary'), args: [] }));
  const h = await runWorktreeHook(new LocalSystem(rec.platform), 'merge', meta, { cwd: parent, vars: MERGE_VARS });
  assert.equal(h.ran, true, JSON.stringify(h));
  assert.equal(h.error, true);
  assert.equal(h.exitCode, null);
});
