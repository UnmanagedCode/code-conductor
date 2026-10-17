// The serving server's boot commit, end to end through the real start(): it is
// measured in memory at boot (never a stub, never a file), and a merge hook
// sees it only when the merge lands in the server's OWN checkout and none of
// the server's own web builds is running. Every server here is a real
// in-process start() whose `checkoutRoot` is a fixture repo registered as a
// project, so a REST merge into it is a merge into "the server's checkout".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { start } from '../server.ts';
import { ensureWebBuild } from '../src/webBuild.ts';
import { createWorktree, mergeWorktreeIntoParent } from '../src/worktrees.ts';
import { projectStoreDir } from '../src/projects.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { registerLocalProject } from './helpers.mjs';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const SAFE = ensureSafeStoreEnv();

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout.trim());
    });
  });
}

// A committed repo registered as project `name`, with a store merge hook that
// prints what it was handed. The boot regenerates CONVENTIONS.md / CLAUDE.md
// in every project, so the fixture ignores both and stays clean to merge into.
async function project(projectsRoot, name, { commit = true } = {}) {
  const dir = path.join(projectsRoot, name);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, '.gitignore'), 'CONVENTIONS.md\nCLAUDE.md\n');
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), 'v1\n');
  if (commit) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'initial');
  }
  await registerLocalProject(name, dir);
  await fs.mkdir(projectStoreDir(name), { recursive: true });
  await fs.writeFile(path.join(projectStoreDir(name), 'post-worktree-merge.sh'), [
    '#!/bin/sh',
    'echo "SHA=${CC_SERVER_BOOT_SHA-unset}"',
    'echo "UNKNOWN=${CC_SERVER_BOOT_UNKNOWN-unset}"',
    'echo "NODE=${CC_SERVER_NODE-unset}"',
  ].join('\n') + '\n', { mode: 0o755 });
  return dir;
}

// One worktree commit merged into `name`, over REST when a server is up; the
// hook's printed vars come back as an object.
let seq = 0;
async function mergeOnce(name, base) {
  const wt = await createWorktree(name, { name: `wt${++seq}` });
  await fs.writeFile(path.join(wt.worktreePath, `f${seq}.txt`), 'x\n');
  await git(wt.worktreePath, 'add', '-A');
  await git(wt.worktreePath, 'commit', '-q', '-m', `f${seq}`);
  const body = base
    ? await (await fetch(`${base}/api/projects/${name}/worktrees/${wt.worktreeName}/merge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json()
    : await mergeWorktreeIntoParent(name, wt.worktreeName);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.postWorktreeMerge.exitCode, 0, JSON.stringify(body.postWorktreeMerge));
  return Object.fromEntries(body.postWorktreeMerge.output.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

// A real in-process start() on port 0 against a throwaway store; `setup`
// builds the fixtures once the store env is in place and returns start()'s
// extra options. CLAUDE_BIN is a node that exits at once.
async function boot(setup) {
  const home = await mkdtemp('cc-bootcommit-srv-');
  const env = {
    PROJECTS_ROOT: path.join(home, 'projects'),
    CLAUDE_PROJECTS_ROOT: path.join(home, 'claude', 'projects'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CLAUDE_BIN: `${process.execPath} -e 0`,
    ANTHROPIC_API_KEY: 'boot-commit-fake-key',
  };
  await fs.mkdir(env.PROJECTS_ROOT, { recursive: true });
  await fs.mkdir(env.CLAUDE_PROJECTS_ROOT, { recursive: true });
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) process.env[k] = v;
      else if (k === 'PROJECTS_ROOT') process.env[k] = SAFE.projectsRoot;
      else if (k === 'CLAUDE_PROJECTS_ROOT') process.env[k] = SAFE.claudeProjectsRoot;
      else delete process.env[k];
    }
  };
  let booted;
  try {
    const { opts, ...fixture } = await setup(env.PROJECTS_ROOT, home);
    booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false, ...opts });
    let closed = false;
    return {
      ...fixture,
      bootCommit: booted.bootCommit,
      base: `http://127.0.0.1:${booted.port}`,
      async stop() {
        if (closed) return;
        closed = true;
        const { server, instances, wss, pluginHost } = booted;
        if (instances) await instances.shutdown();
        if (pluginHost) await pluginHost.stopAll();
        wss.close();
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        await settleSessionWrites();
      },
      async close() { await this.stop(); restore(); await rmrf(home); },
    };
  } catch (e) { restore(); await rmrf(home); throw e; }
}

test('the real boot path captures HEAD; a merge into its own checkout gets that commit, another project gets neither var', async () => {
  const s = await boot(async (root) => {
    const self = await project(root, 'self');
    await project(root, 'other');
    return { self, head: await git(self, 'rev-parse', 'HEAD'), opts: { recordBootCommit: true, checkoutRoot: self } };
  });
  try {
    assert.deepEqual(s.bootCommit, { sha: s.head });
    const first = await mergeOnce('self', s.base);
    assert.equal(first.SHA, s.head);
    assert.equal(first.UNKNOWN, 'unset');
    assert.equal(first.NODE, process.execPath);
    const second = await mergeOnce('self', s.base);
    assert.equal(second.SHA, s.head, 'still the BOOT commit after HEAD moved, not the new HEAD');
    const other = await mergeOnce('other', s.base);
    assert.equal(other.SHA, 'unset');
    assert.equal(other.UNKNOWN, 'unset');
    assert.equal(other.NODE, process.execPath, 'the node path reaches every local target');
  } finally { await s.close(); }
});

test('the real boot path: tracked changes outside web/ at boot are unknown, and the hook is told why instead of a sha', async () => {
  const s = await boot(async (root) => {
    const self = await project(root, 'self');
    await fs.writeFile(path.join(self, 'src', 'server.ts'), 'edited before boot\n');
    return { self, opts: { recordBootCommit: true, checkoutRoot: self } };
  });
  try {
    assert.match(s.bootCommit.unknown, /tracked changes outside web\/.*src\/server\.ts/);
    // Committed after boot, so the merge is allowed; the server still runs the edit.
    await git(s.self, 'commit', '-q', '-am', 'commit the edit');
    const vars = await mergeOnce('self', s.base);
    assert.equal(vars.SHA, 'unset');
    assert.match(vars.UNKNOWN, /tracked changes outside web\/.*src\/server\.ts/);
  } finally { await s.close(); }
});

test('the real boot path: an unborn HEAD, or no git checkout, is unknown', async () => {
  for (const [name, setup] of [
    ['unborn', async (root) => ({ opts: { recordBootCommit: true, checkoutRoot: await project(root, 'self', { commit: false }) } })],
    ['not git', async (_root, home) => {
      const dir = path.join(home, 'plain');
      await fs.mkdir(dir);
      return { opts: { recordBootCommit: true, checkoutRoot: dir } };
    }],
  ]) {
    const s = await boot(setup);
    try {
      assert.equal('sha' in s.bootCommit, false, name);
      assert.match(s.bootCommit.unknown, name === 'unborn' ? /unborn/ : /not a git checkout/);
    } finally { await s.close(); }
  }
});

test('while the server\'s own web build runs, its own checkout gets CC_SERVER_BOOT_UNKNOWN, and the sha once the build ends', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let building;
  const s = await boot(async (root, home) => {
    const self = await project(root, 'self');
    const quiet = { log: () => {}, error: () => {} };
    const build = async (outDir) => {
      await gate;
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'index.html'), '<p>built</p>');
    };
    // The real ensureWebBuild — the running-build count is its own — into a scratch dist.
    const webBuild = () => (building = ensureWebBuild({ log: quiet, distDir: path.join(home, 'dist'), build }));
    return { self, head: await git(self, 'rev-parse', 'HEAD'), opts: { recordBootCommit: true, checkoutRoot: self, buildWeb: true, webBuild } };
  });
  try {
    const during = await mergeOnce('self', s.base);
    assert.equal(during.SHA, 'unset');
    assert.equal(during.UNKNOWN, 'the server\'s own web build is running');
    release();
    assert.equal((await building).phase, 'ready');
    const after = await mergeOnce('self', s.base);
    assert.equal(after.SHA, s.head);
    assert.equal(after.UNKNOWN, 'unset');
  } finally { release(); await s.close(); }
});

test('without recordBootCommit nothing is captured, and once a capturing server closes its vars are withdrawn', async () => {
  const quiet = await boot(async (root) => ({ opts: { checkoutRoot: await project(root, 'self') } }));
  try {
    assert.equal(quiet.bootCommit, undefined);
    const vars = await mergeOnce('self', quiet.base);
    assert.equal(vars.SHA, 'unset');
    assert.equal(vars.UNKNOWN, 'unset');
  } finally { await quiet.close(); }

  const s = await boot(async (root) => ({ opts: { recordBootCommit: true, checkoutRoot: await project(root, 'self') } }));
  try {
    assert.notEqual((await mergeOnce('self', s.base)).SHA, 'unset', 'premise: the running server hands it over');
    await s.stop();
    const after = await mergeOnce('self', null);
    assert.equal(after.SHA, 'unset');
    assert.equal(after.UNKNOWN, 'unset');
  } finally { await s.close(); }
});
