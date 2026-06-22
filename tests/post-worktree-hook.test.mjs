// Integration tests for the per-project post-worktree-create hook.
// Each test creates a fresh tmp git repo, optionally installs a hook
// script at .code-conductor/post-worktree-create.sh, then drives the
// worktree creation surface and asserts the postWorktreeCreate result.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createWorktree } from '../src/worktrees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

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

async function makeRealRepo(name) {
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

// Install a hook script at .code-conductor/post-worktree-create.sh inside
// the repo, commit it so it's available in the worktree off HEAD.
async function installHook(repoPath, scriptBody) {
  const hookDir = path.join(repoPath, '.code-conductor');
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'post-worktree-create.sh');
  await fs.writeFile(hookPath, scriptBody, { mode: 0o755 });
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'add hook');
  return hookPath;
}

// ── Direct createWorktree() unit-style tests ──────────────────────────────

test('hook absent: postWorktreeCreate.ran is false', async () => {
  await makeRealRepo('demo');
  const meta = await createWorktree('demo');
  assert.ok(meta.postWorktreeCreate, 'postWorktreeCreate field present');
  assert.equal(meta.postWorktreeCreate.ran, false);
  assert.equal(meta.postWorktreeCreate.skipped, undefined);
});

test('kill-switch: ORCH_DISABLE_POST_WORKTREE_HOOK=1 skips hook', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "should not run"\n');
  const prev = process.env.ORCH_DISABLE_POST_WORKTREE_HOOK;
  process.env.ORCH_DISABLE_POST_WORKTREE_HOOK = '1';
  try {
    const meta = await createWorktree('demo');
    assert.equal(meta.postWorktreeCreate.ran, false);
    assert.equal(meta.postWorktreeCreate.skipped, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.ORCH_DISABLE_POST_WORKTREE_HOOK;
    else process.env.ORCH_DISABLE_POST_WORKTREE_HOOK = prev;
  }
});

test('hook exits 0: ran=true, exitCode=0, worktree still created', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "setup ok"\nexit 0\n');
  const meta = await createWorktree('demo');
  assert.equal(meta.postWorktreeCreate.ran, true);
  assert.equal(meta.postWorktreeCreate.exitCode, 0);
  assert.ok(meta.postWorktreeCreate.durationMs >= 0);
  assert.ok(meta.postWorktreeCreate.output.includes('setup ok'));
  // Worktree was fully created despite the hook run.
  const stat = await fs.stat(meta.worktreePath);
  assert.ok(stat.isDirectory());
});

test('hook exits 1: non-fatal — ran=true, exitCode=1, worktree still created', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "fail msg" >&2\nexit 1\n');
  const meta = await createWorktree('demo');
  const h = meta.postWorktreeCreate;
  assert.equal(h.ran, true);
  assert.equal(h.exitCode, 1);
  // Worktree is still valid.
  const stat = await fs.stat(meta.worktreePath);
  assert.ok(stat.isDirectory());
});

test('hook receives expected env vars (cwd sentinel file check)', async () => {
  const repoPath = await makeRealRepo('demo');
  // Write a sentinel file into CC_WORKTREE_PATH to prove hook ran there.
  await installHook(repoPath, [
    '#!/bin/sh',
    'touch "$CC_WORKTREE_PATH/hook-ran.sentinel"',
    'echo "branch=$CC_BRANCH project=$CC_PROJECT_NAME"',
  ].join('\n') + '\n');
  const meta = await createWorktree('demo');
  const h = meta.postWorktreeCreate;
  assert.equal(h.ran, true);
  assert.equal(h.exitCode, 0);
  // Sentinel file exists in the worktree.
  const sentinel = path.join(meta.worktreePath, 'hook-ran.sentinel');
  await assert.doesNotReject(fs.access(sentinel), 'sentinel file missing — hook did not run in worktree');
  // Env vars were set correctly.
  assert.ok(h.output.includes(`project=demo`), `expected project=demo in output: ${h.output}`);
  assert.match(h.output, /branch=code-conductor\//);
});

test('hook ran inside worktree cwd (sentinel in cwd)', async () => {
  const repoPath = await makeRealRepo('demo');
  // touch a file via relative path — only works if cwd=worktreePath.
  await installHook(repoPath, '#!/bin/sh\ntouch cwd-check.txt\n');
  const meta = await createWorktree('demo');
  const h = meta.postWorktreeCreate;
  assert.equal(h.ran, true);
  const created = path.join(meta.worktreePath, 'cwd-check.txt');
  await assert.doesNotReject(fs.access(created), 'cwd-check.txt missing — hook did not run in worktree cwd');
});

test('hook timeout: timedOut=true, non-fatal, worktree exists', async () => {
  const repoPath = await makeRealRepo('demo');
  // sleep 1 is the worst-case bound; the 100ms timeout+SIGKILL kills it
  // at ~200ms so the test returns in well under 1 second.
  await installHook(repoPath, '#!/bin/sh\nsleep 1\n');
  const prev = process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
  process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = '100'; // 100ms — much shorter than 1s sleep
  try {
    const meta = await createWorktree('demo');
    const h = meta.postWorktreeCreate;
    assert.equal(h.ran, true);
    assert.equal(h.timedOut, true);
    assert.equal(h.exitCode, null);
    // Worktree was not rolled back.
    const stat = await fs.stat(meta.worktreePath);
    assert.ok(stat.isDirectory());
  } finally {
    if (prev === undefined) delete process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
    else process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = prev;
  }
});

test('output capped at 16 KB tail — truncated:true, output starts with truncation marker', async () => {
  const repoPath = await makeRealRepo('demo');
  // Emit a little over 16 KB: 200 lines × ~100 chars = ~20 KB.
  const bigOutput = Array.from({ length: 200 }, (_, i) =>
    `line-${String(i).padStart(4, '0')}-${'x'.repeat(85)}`,
  ).join('\n');
  await installHook(repoPath, `#!/bin/sh\nprintf '${bigOutput.replace(/'/g, "'\\''")}\\n'\n`);
  const meta = await createWorktree('demo');
  const h = meta.postWorktreeCreate;
  assert.equal(h.ran, true);
  assert.equal(h.truncated, true);
  assert.ok(h.output.startsWith('… [truncated]'), `output should start with truncation marker, got: ${h.output.slice(0, 60)}`);
  assert.ok(h.output.length <= 16 * 1024 + 200, 'output exceeds 16 KB cap by too much');
});

test('hook not executable: chmod +x applied and hook still runs', async () => {
  const repoPath = await makeRealRepo('demo');
  const hookDir = path.join(repoPath, '.code-conductor');
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'post-worktree-create.sh');
  // Write without execute bit.
  await fs.writeFile(hookPath, '#!/bin/sh\necho "chmod-test"\n', { mode: 0o644 });
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'add hook no-exec');
  const meta = await createWorktree('demo');
  const h = meta.postWorktreeCreate;
  assert.equal(h.ran, true);
  assert.equal(h.exitCode, 0);
  assert.ok(h.output.includes('chmod-test'));
});

// ── REST spawn integration: result in instance summary ────────────────────

test('REST POST /api/instances with worktree:true — postWorktreeCreate in response', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "rest-hook"\n');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(r.status, 201);
  const hook = r.body.worktree?.postWorktreeCreate;
  assert.ok(hook, 'postWorktreeCreate field missing from instance summary');
  assert.equal(hook.ran, true);
  assert.equal(hook.exitCode, 0);
  assert.ok(hook.output.includes('rest-hook'));
  void repoPath;
});

test('REST spawn with worktree + hook exit 1: spawn still succeeds (201), exitCode=1', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "failing hook"\nexit 1\n');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(r.status, 201, 'spawn must succeed even when hook exits non-zero');
  const hook = r.body.worktree?.postWorktreeCreate;
  assert.equal(hook.ran, true);
  assert.equal(hook.exitCode, 1);
  void repoPath;
});

test('REST spawn with worktree, no hook — postWorktreeCreate.ran is false', async () => {
  await makeRealRepo('demo');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  assert.equal(r.status, 201);
  const hook = r.body.worktree?.postWorktreeCreate;
  assert.ok(hook, 'postWorktreeCreate field missing from instance summary');
  assert.equal(hook.ran, false);
});

// ── MCP create_worktree: result in response ───────────────────────────────

async function mcpCall(baseUrl, toolName, args) {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const body = await r.json();
  // MCP returns content[0].text as the JSON result.
  const text = body.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body;
}

test('MCP create_worktree — postWorktreeCreate in result', async () => {
  const repoPath = await makeRealRepo('demo');
  await installHook(repoPath, '#!/bin/sh\necho "mcp-hook"\n');
  const result = await mcpCall(baseUrl, 'create_worktree', { project: 'demo' });
  const hook = result.postWorktreeCreate;
  assert.ok(hook, 'postWorktreeCreate missing from MCP create_worktree result');
  assert.equal(hook.ran, true);
  assert.equal(hook.exitCode, 0);
  assert.ok(hook.output.includes('mcp-hook'));
  void repoPath;
});

test('MCP create_worktree, no hook — postWorktreeCreate.ran is false', async () => {
  await makeRealRepo('demo');
  const result = await mcpCall(baseUrl, 'create_worktree', { project: 'demo' });
  const hook = result.postWorktreeCreate;
  assert.ok(hook, 'postWorktreeCreate missing from MCP create_worktree result');
  assert.equal(hook.ran, false);
});

// ── Spawn-timing: hook runs before subprocess — no 5 s timeout trip ──────

test('slow hook (200ms) does not interfere: subprocess spawns after hook completes', async () => {
  const repoPath = await makeRealRepo('demo');
  // 200ms delay — measurable but well within the 5s control-request window.
  await installHook(repoPath, '#!/bin/sh\nsleep 0.2\necho "slow-hook-done"\n');
  const before = Date.now();
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions', worktree: true,
  });
  const elapsed = Date.now() - before;
  assert.equal(r.status, 201);
  const hook = r.body.worktree?.postWorktreeCreate;
  assert.equal(hook.ran, true);
  assert.equal(hook.exitCode, 0);
  // Hook ran before the instance was created — total time ≥ hook duration.
  assert.ok(elapsed >= 150, `elapsed ${elapsed}ms < expected hook delay`);
  void repoPath;
});
