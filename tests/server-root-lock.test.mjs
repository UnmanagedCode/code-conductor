// The projects-root lock at the server boundary: a second `node server.ts` on a
// held root exits 7 before it touches anything, a dead holder's root boots
// again at once, and `start()` takes the lock before every boot step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { acquireRootLock, RootLockHeldError, ROOT_LOCK_DIRNAME, ROOT_LOCK_HELD_EXIT } from '../src/rootLock.ts';
import { hostPlatform } from '../src/platform/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');
const HOLDER = path.join(__dirname, 'rootLockHolder.mjs');
const BANNER = /code-conductor listening on http:\/\/127\.0\.0\.1:(\d+)\n/;

async function freshHome(t) {
  const home = await mkdtemp('server-root-lock-');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const rootOf = (home) => path.join(home, 'project');
const lockDirOf = (home) => path.join(rootOf(home), '.code-conductor', ROOT_LOCK_DIRNAME);

function track(t, child) {
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  const waitFor = async (re, timeout = 30_000) => {
    const start = Date.now();
    for (;;) {
      const m = re.exec(out.stdout);
      if (m) return m;
      if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > timeout) {
        throw new Error(`never printed ${re}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { child, out, exited, waitFor };
}

function spawnServer(t, home) {
  return track(t, spawn(process.execPath, [SERVER_TS], {
    cwd: path.dirname(SERVER_TS),
    env: {
      ...process.env,
      // Migration 0004 moves $HOME/.code-conductor/{whisper.cpp,piper} on boot; keep it off the real HOME.
      HOME: home,
      PORT: '0',
      HOST: '127.0.0.1',
      PROJECTS_ROOT: rootOf(home),
      CLAUDE_PROJECTS_ROOT: path.join(home, '.claude', 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function spawnHolder(t, home) {
  return track(t, spawn(process.execPath, [HOLDER, rootOf(home)], { stdio: ['ignore', 'pipe', 'pipe'] }));
}

async function bootedPort(s) {
  return Number((await s.waitFor(BANNER))[1]);
}

async function health(port) {
  return (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
}

// Every path under `dir`, relative, directories with a trailing `/`.
function tree(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(`${p}/`, ...tree(dir, p));
    else out.push(p);
  }
  return out.sort();
}

test('a second server on a held root exits 7 naming the holder; the first keeps serving', async (t) => {
  const home = await freshHome(t);
  const first = spawnServer(t, home);
  const port = await bootedPort(first);
  assert.ok(fs.existsSync(path.join(rootOf(home), '.conduct')), 'positive control: a booted server provisions the root');

  const second = spawnServer(t, home);
  const { code } = await second.exited;
  assert.equal(code, 7, `the documented refusal exit code\nstderr=${second.out.stderr}`);
  assert.equal(ROOT_LOCK_HELD_EXIT, 7);
  assert.match(second.out.stderr, new RegExp(`pid ${first.child.pid}\\b`));
  assert.ok(second.out.stderr.includes(path.join(lockDirOf(home), '1.json')), second.out.stderr);
  assert.equal((await health(port)).pid, first.child.pid, 'the holder still answers');
});

for (const signal of ['SIGKILL', 'SIGTERM']) {
  test(`after the holder dies by ${signal}, the next server boots on the root`, async (t) => {
    const home = await freshHome(t);
    const first = spawnServer(t, home);
    await bootedPort(first);
    first.child.kill(signal);
    await first.exited;
    const next = spawnServer(t, home);
    const port = await bootedPort(next);
    assert.equal((await health(port)).pid, next.child.pid);
  });
}

test('start() on a held root rejects before any boot step writes to the root', async (t) => {
  const home = await freshHome(t);
  const holder = spawnHolder(t, home);
  await holder.waitFor(/HELD 1\n/);
  const { start } = await import('../server.ts');
  const prev = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = rootOf(home);
  t.after(() => { process.env.PROJECTS_ROOT = prev; });
  await assert.rejects(start({ port: 0, host: '127.0.0.1', buildWeb: false, syncDeps: false }), RootLockHeldError);
  const lockFiles = new Set(fs.readdirSync(lockDirOf(home)).map((n) => `.code-conductor/${ROOT_LOCK_DIRNAME}/${n}`));
  assert.deepEqual(tree(rootOf(home)), ['.code-conductor/', `.code-conductor/${ROOT_LOCK_DIRNAME}/`, ...[...lockFiles].sort()]);
});

test("a refused server leaves the holder's restart manifests and session-tmp dirs in place", async (t) => {
  const home = await freshHome(t);
  const holder = spawnHolder(t, home);
  await holder.waitFor(/HELD 1\n/);
  const store = path.join(rootOf(home), '.code-conductor');
  const planted = {
    resume: path.join(store, 'pending-resume.json'),
    cleanup: path.join(store, 'pending-temp-cleanup.json'),
    tmp: path.join(store, 'session-tmp', 'live-instance', 'out.txt'),
  };
  fs.writeFileSync(planted.resume, JSON.stringify({ sessions: [] }));
  fs.writeFileSync(planted.cleanup, JSON.stringify({ writtenAt: new Date().toISOString(), entries: [] }));
  fs.mkdirSync(path.dirname(planted.tmp), { recursive: true });
  fs.writeFileSync(planted.tmp, 'x');

  const refused = spawnServer(t, home);
  assert.equal((await refused.exited).code, ROOT_LOCK_HELD_EXIT, `stderr=${refused.out.stderr}`);
  for (const [name, p] of Object.entries(planted)) assert.ok(fs.existsSync(p), `${name} survives: ${p}`);
});

test('start() releases the root lock when a boot step after the acquire throws', async (t) => {
  const home = await freshHome(t);
  const { start } = await import('../server.ts');
  const prev = { PROJECTS_ROOT: process.env.PROJECTS_ROOT, CLAUDE_PROJECTS_ROOT: process.env.CLAUDE_PROJECTS_ROOT };
  process.env.PROJECTS_ROOT = rootOf(home);
  process.env.CLAUDE_PROJECTS_ROOT = path.join(home, '.claude', 'projects');
  t.after(() => Object.assign(process.env, prev));
  // An out-of-range port: the boot runs through migrations, sweeps and
  // createServer, and the listen — its last step — throws.
  await assert.rejects(start({ port: -1, host: '127.0.0.1', buildWeb: false, syncDeps: false }), { code: 'ERR_SOCKET_BAD_PORT' });
  assert.ok(fs.existsSync(path.join(rootOf(home), '.conduct')), 'the boot got past the acquire before it failed');
  assert.deepEqual(fs.readdirSync(lockDirOf(home)), [], 'no record and no socket of ours is left');
  const lock = await acquireRootLock({ storeDir: path.dirname(lockDirOf(home)), platform: hostPlatform, log: { warn() {} } });
  t.after(() => lock.releaseSync());
  assert.equal(lock.gen, 1);
});
