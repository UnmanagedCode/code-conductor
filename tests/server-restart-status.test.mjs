// GET /api/settings/self-update's `restart` field, end to end through the real
// start() (start → createServer → buildRoutes → mountAdmin). Each server's
// `checkoutRoot` is a fixture repo; SELF_UPDATE_REPO_ROOT points self-update
// at it too, so its origin check never reaches the real checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { start } from '../server.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
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

async function commit(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), text);
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'c');
  return git(dir, 'rev-parse', 'HEAD');
}

async function repo(home) {
  const dir = path.join(home, 'self');
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await commit(dir, {
    '.gitignore': 'CONVENTIONS.md\nCLAUDE.md\n',
    'server.ts': "import './src/a.ts';\n",
    'src/a.ts': 'export const a = 1;\n',
    'web/w.tsx': 'export const w = 1;\n',
  });
  return dir;
}

// A real in-process start() on port 0 against a throwaway store.
async function boot(home, dir, opts) {
  const env = {
    HOME: home,
    PROJECTS_ROOT: path.join(home, 'projects'),
    CLAUDE_PROJECTS_ROOT: path.join(home, 'claude', 'projects'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CLAUDE_BIN: `${process.execPath} -e 0`,
    ANTHROPIC_API_KEY: 'restart-status-fake-key',
    SELF_UPDATE_REPO_ROOT: dir,
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
  try { booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false, checkoutRoot: dir, ...opts }); } catch (e) { restore(); throw e; }
  return {
    base: `http://127.0.0.1:${booted.port}`,
    async get() {
      const res = await fetch(`${this.base}/api/settings/self-update`);
      assert.equal(res.status, 200);
      return res.json();
    },
    async stop() {
      const { server, instances, wss, pluginHost } = booted;
      if (instances) await instances.shutdown();
      if (pluginHost) await pluginHost.stopAll();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await settleSessionWrites();
      booted.rootLock.releaseSync();
      restore();
    },
  };
}

test('GET /api/settings/self-update carries restart: current at boot, live after a web-only commit, needed after a src/ commit', async () => {
  const home = await mkdtemp('cc-restart-srv-');
  const dir = await repo(home);
  const B = await git(dir, 'rev-parse', 'HEAD');
  const s = await boot(home, dir, { recordBootCommit: true });
  try {
    const first = await s.get();
    assert.deepEqual(first.restart, { state: 'current', boot: B });
    assert.ok('version' in first && 'upstream' in first, 'the other self-update keys are still there');
    assert.equal(typeof first.canCheck, 'boolean');
    const H1 = await commit(dir, { 'web/w.tsx': 'x\n' });
    assert.notEqual(H1, B);
    assert.deepEqual((await s.get()).restart, { state: 'live', boot: B, head: H1 });
    const H2 = await commit(dir, { 'src/a.ts': 'export const a = 2;\n' });
    const needed = (await s.get()).restart;
    assert.equal(needed.state, 'needed');
    assert.equal(needed.boot, B);
    assert.equal(needed.head, H2);
    assert.ok(needed.reason.includes('src/a.ts'), needed.reason);
  } finally { await s.stop(); await rmrf(home); }
});

test('a fresh boot on the advanced HEAD clears it', async () => {
  const home = await mkdtemp('cc-restart-srv-');
  const dir = await repo(home);
  const first = await boot(home, dir, { recordBootCommit: true });
  let H;
  try {
    H = await commit(dir, { 'src/a.ts': 'export const a = 2;\n' });
    assert.equal((await first.get()).restart.state, 'needed');
  } finally { await first.stop(); }
  const second = await boot(home, dir, { recordBootCommit: true });
  try {
    assert.deepEqual((await second.get()).restart, { state: 'current', boot: H });
  } finally { await second.stop(); await rmrf(home); }
});

test('a server that recorded no boot commit reports unknown', async () => {
  const home = await mkdtemp('cc-restart-srv-');
  const dir = await repo(home);
  const s = await boot(home, dir, { recordBootCommit: false });
  try {
    const { restart } = await s.get();
    assert.equal(restart.state, 'unknown');
    assert.match(restart.reason, /did not record/);
  } finally { await s.stop(); await rmrf(home); }
});
