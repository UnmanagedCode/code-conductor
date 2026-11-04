// An in-app restart inside the docker container relaunches only the server
// (docker/supervise.mjs, src/restartSupervisor.ts). Skipped by default — opt in
// with `RUN_DOCKER_RESTART=1`, which needs a working docker daemon and the
// image (`CC_DOCKER_IMAGE`, default code-conductor:local).
//
//   RUN_DOCKER_RESTART=1 CC_DOCKER='sudo -n docker' node tests/run.mjs tests/restart-container.real.test.mjs
//
// Every container is a throwaway `cc-restart-proof-<pid>-<case>` run with
// `--init` and this checkout's entrypoint (a /tmp copy of the committed tree),
// which reproduces compose's tini → entrypoint chain without an image rebuild.
// No host port is published: every HTTP call is a `docker exec … node -e fetch`.
// The helper below refuses any docker argument naming the live `code-conductor`
// container.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT_LOCK_DIRNAME, ROOT_LOCK_HELD_EXIT } from '../src/rootLock.ts';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const ENABLED = process.env.RUN_DOCKER_RESTART === '1';
const DOCKER = (process.env.CC_DOCKER ?? 'docker').split(/\s+/);
const IMAGE = process.env.CC_DOCKER_IMAGE ?? 'code-conductor:local';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = `cc-restart-proof-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guard(args) {
  for (const a of args) {
    if (a === 'code-conductor') throw new Error('refusing to address the live code-conductor container');
  }
  return args;
}
const run = (argv) => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), { maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
    if (err) { Object.assign(err, { stdout, stderr }); reject(err); } else resolve(stdout);
  });
});
const docker = (...args) => run([...DOCKER, ...guard(args)]);
// docker logs puts the container's stderr on this process's stderr.
const allLogs = (ctr) => new Promise((resolve) => {
  execFile(DOCKER[0], [...DOCKER.slice(1), ...guard(['logs', ctr])], { maxBuffer: 64 << 20 }, (_e, so, se) => resolve(`${so}${se}`));
});
const inspect = async (ctr) => JSON.parse(await docker('inspect', ctr))[0];

const containers = [];
let stageDir = null;

function stage() {
  if (stageDir) return stageDir;
  const dir = mkdtempSync('cc-restart-proof-');
  stageDir = dir;
  const repo = path.join(dir, 'repo');
  const files = execFileSyncLines('git', ['ls-files', '-z'], REPO);
  for (const f of files) {
    const src = path.join(REPO, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.cpSync(src, path.join(repo, f));
  }
  fs.cpSync(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'), { recursive: true, dereference: true });
  fs.mkdirSync(path.join(dir, 'stub-bin'));
  fs.writeFileSync(path.join(dir, 'stub-bin', 'tailscaled'),
    '#!/bin/sh\necho $$ > /workspaces/projects/.stub.pid\nexec sleep infinity\n', { mode: 0o755 });
  return dir;
}
function execFileSyncLines(cmd, args, cwd) {
  return spawnSyncStdout(cmd, args, cwd).split('\0').filter(Boolean);
}
function spawnSyncStdout(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A fresh projects root per container, with the fake plugin enabled + auto-start.
function makeRoot(name, { plugin = true } = {}) {
  const root = path.join(stage(), `root-${name}`);
  fs.mkdirSync(root, { recursive: true });
  if (plugin) {
    fs.cpSync(FAKE_PLUGIN_DIR, path.join(root, 'autoplug'), { recursive: true });
    const dir = path.join(root, '.code-conductor', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
      plugins: { 'fake-plugin': { project: 'autoplug', enabled: true, activeVersion: { type: 'main' }, autoStart: true } },
    }));
  }
  return root;
}
function chmodAll(dir) { spawnSyncStdout('chmod', ['-R', 'a+rwX', dir], REPO); }

let imagePath = null;
async function runArgs(name, root, { policy = 'no', detach = true, extra = [], tail = [] } = {}) {
  const dir = stage();
  chmodAll(dir);
  imagePath ??= (await docker('run', '--rm', '--entrypoint', 'printenv', IMAGE, 'PATH')).trim();
  const seen = await docker('run', '--rm', '-v', `${dir}:/stage`, '--entrypoint', 'ls', IMAGE, '/stage/repo/server.ts')
    .catch((e) => e.stderr ?? String(e));
  assert.match(seen, /server\.ts/, `precondition: the docker daemon cannot see ${dir} — it does not share this process's filesystem`);
  const ctr = `${PREFIX}-${name}`;
  containers.push(ctr);
  const args = [
    'run', ...(detach ? ['-d'] : ['--rm', '-i']), '--name', ctr, '--init', '--restart', policy, '--user', 'node',
    '--entrypoint', '/workspaces/code-conductor/docker/entrypoint.sh',
    '-v', `${path.join(dir, 'repo')}:/workspaces/code-conductor`,
    '-v', `${root}:/workspaces/projects`,
    '-v', `${path.join(dir, 'stub-bin')}:/stub-bin:ro`,
    '-e', 'HOST=0.0.0.0', '-e', 'PORT=8787', '-e', 'PROJECTS_ROOT=/workspaces/projects',
    '-e', 'REPO_DIR=/workspaces/code-conductor', '-e', 'CC_SKIP_WEB_BUILD=1',
    '-e', 'CC_WITH_TAILSCALE=1', '-e', `PATH=/stub-bin:${imagePath}`,
    ...extra, IMAGE, ...tail,
  ];
  return { ctr, args };
}

after(async () => {
  for (const c of containers) await docker('rm', '-f', c).catch(() => {});
});

const FETCH = (method, urlPath, body) => `
const r = await fetch('http://127.0.0.1:8787${urlPath}', { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body === undefined ? null : JSON.stringify(body))} ?? undefined });
process.stdout.write(await r.text());`;
const http = (ctr, method, urlPath, body) => docker('exec', ctr, 'node', '--input-type=module', '-e', FETCH(method, urlPath, body));
const health = async (ctr) => {
  try { return JSON.parse(await http(ctr, 'GET', '/api/health')); } catch { return null; }
};
async function waitFor(what, fn, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const waitHealthy = (ctr) => waitFor(`${ctr} health`, () => health(ctr));
const ppidOf = async (ctr, pid) => Number((await docker('exec', ctr, 'sh', '-c', `awk '/^PPid:/{print $2}' /proc/${pid}/status`)).trim());
const stubPid = async (ctr) => Number((await docker('exec', ctr, 'cat', '/workspaces/projects/.stub.pid')).trim());
const alive = (ctr, pid) => docker('exec', ctr, 'kill', '-0', String(pid)).then(() => true, () => false);
const pluginRow = async (ctr) => JSON.parse(await http(ctr, 'GET', '/api/plugins')).rows.find((r) => r.id === 'fake-plugin');

let main = null; // case 1's container, reused by case 2

test('an in-app restart keeps the container, its service and the plugin backend, and relaunches only the server', { skip: !ENABLED, timeout: 600_000 }, async () => {
  const root = makeRoot('main');
  const { ctr, args } = await runArgs('main', root, { policy: 'unless-stopped' });
  chmodAll(root);
  await docker(...args);
  main = ctr;
  await waitHealthy(ctr);
  const plugin = await waitFor('plugin ready', async () => { const r = await pluginRow(ctr); return r?.state === 'ready' ? r : null; });
  await waitFor('stub service', () => stubPid(ctr).catch(() => null));

  const before = await inspect(ctr);
  const stub = await stubPid(ctr);
  assert.ok(await alive(ctr, stub), 'the stub service runs');
  const supervisor = async (pid) => ppidOf(ctr, pid);

  let prev = await health(ctr);
  const supPid = await supervisor(prev.pid);
  const seenSupervisor = [supPid];
  for (const body of [{}, { resume: true }]) {
    const out = await http(ctr, 'POST', '/api/admin/restart', body);
    const resultLine = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(resultLine, { type: 'result', ok: true }, out);
    const next = await waitFor('a new bootId', async () => {
      const h = await health(ctr);
      return h && h.bootId !== prev.bootId ? h : null;
    });
    const after = await inspect(ctr);
    assert.equal(after.State.StartedAt, before.State.StartedAt, 'the container did not restart');
    assert.equal(after.RestartCount, before.RestartCount);
    assert.equal(stub, await stubPid(ctr), 'the service pid file is unchanged');
    assert.ok(await alive(ctr, stub), 'the service survived');
    assert.notEqual(next.pid, prev.pid, 'a new server process');
    seenSupervisor.push(await supervisor(next.pid));
    const row = await waitFor('plugin ready after restart', async () => { const r = await pluginRow(ctr); return r?.state === 'ready' ? r : null; });
    assert.equal(row.pid, plugin.pid, 'the plugin backend was adopted, not restarted');
    prev = next;
  }
  assert.deepEqual([...new Set(seenSupervisor)], [supPid], 'one supervisor throughout');

  const logs = await allLogs(ctr);
  assert.equal((logs.match(/exited 75 \(restart requested\); relaunching/g) ?? []).length, 2);
  assert.equal((logs.match(/restart: exiting pid=\d+ with 75/g) ?? []).length, 2);
  const final = await inspect(ctr);
  console.log(`measured: StartedAt before=${before.State.StartedAt} after=${final.State.StartedAt}; RestartCount before=${before.RestartCount} after=${final.RestartCount}; stub pid=${stub}; supervisor pid=${supPid}; plugin pid=${plugin.pid}`);
});

test('docker stop reaches the server at once: exit 143, inside the timeout', { skip: !ENABLED, timeout: 120_000 }, async () => {
  assert.ok(main, 'the first case did not produce a container');
  const t0 = Date.now();
  await docker('stop', '-t', '30', main);
  const elapsed = Date.now() - t0;
  const state = (await inspect(main)).State;
  assert.equal(state.ExitCode, 143, `exit ${state.ExitCode}: 137 would mean the SIGKILL fallback fired`);
  assert.ok(elapsed < 30_000, `stop took ${elapsed} ms`);
  assert.match(await allLogs(main), /ended by SIGTERM/);
  console.log(`measured: docker stop elapsed=${elapsed} ms, ExitCode=${state.ExitCode}`);
});

test('a crashed server ends the container and the restart policy brings it back', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const root = makeRoot('crash', { plugin: false });
  const { ctr, args } = await runArgs('crash', root, { policy: 'unless-stopped' });
  chmodAll(root);
  await docker(...args);
  const first = await waitHealthy(ctr);
  const before = await inspect(ctr);
  await docker('exec', ctr, 'kill', '-KILL', String(first.pid));
  await waitFor('the container to restart', async () => {
    const i = await inspect(ctr);
    return i.RestartCount >= 1 ? i : null;
  });
  const next = await waitHealthy(ctr);
  const after = await inspect(ctr);
  assert.notEqual(after.State.StartedAt, before.State.StartedAt, 'the container, not the supervisor, was restarted');
  assert.notEqual(next.bootId, first.bootId);
  assert.match(await allLogs(ctr), /ended by SIGKILL/);
});

test('a persistent boot failure ends the container once and does not spin', { skip: !ENABLED, timeout: 180_000 }, async () => {
  const root = makeRoot('fail', { plugin: false });
  const lockDir = path.join(root, '.code-conductor', ROOT_LOCK_DIRNAME);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, '1.json'), 'garbage');
  const { ctr, args } = await runArgs('fail', root, { policy: 'no' });
  chmodAll(root);
  await docker(...args);
  await waitFor('the container to exit', async () => (await inspect(ctr)).State.Running ? null : true);
  const state = (await inspect(ctr)).State;
  assert.equal(state.ExitCode, ROOT_LOCK_HELD_EXIT);
  assert.equal(((await allLogs(ctr)).match(/started server/g) ?? []).length, 1);
});

test('a headless run passes its exit code and clean stdout through the supervisor', { skip: !ENABLED, timeout: 180_000 }, async () => {
  const root = makeRoot('headless', { plugin: false });
  chmodAll(root);
  const { args } = await runArgs('headless', root, {
    detach: false, extra: ['-e', 'CC_SKIP_DEPS_SYNC=1'], tail: ['--prompt', 'x', '--mode', 'bogus'],
  });
  const child = spawn(DOCKER[0], [...DOCKER.slice(1), ...guard(args)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stdin.end();
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 2, stdout);
  assert.equal(typeof JSON.parse(stdout), 'object', 'stdout is exactly one JSON object');
});
