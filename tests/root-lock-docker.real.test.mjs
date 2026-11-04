// The projects-root lock across a real pid-namespace boundary. Skipped by
// default — opt in with `RUN_DOCKER_ROOT_LOCK=1`, which needs a working docker
// daemon on this kernel.
//
//   RUN_DOCKER_ROOT_LOCK=1 node tests/run.mjs tests/root-lock-docker.real.test.mjs
//   RUN_DOCKER_ROOT_LOCK=1 CC_DOCKER='sudo -n docker' CC_DOCKER_IMAGE=code-conductor:local node tests/run.mjs …
//
// Two cases, each a holder in a container whose pid means nothing to its
// contender, so only the socket can refuse:
//   - host ↔ container: the projects root is bind-mounted from this process's
//     temp dir, at a different path. Needs a daemon that sees this temp dir;
//     one that does not fails the precondition by name.
//   - container ↔ container: two containers on one docker volume. Holder and
//     contender are BOTH pid 1, so the record names the contender's own pid.
// Each then `docker kill`s the holder: the root must be taken at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireRootLock, RootLockHeldError, ROOT_LOCK_DIRNAME, ROOT_LOCK_HELD_EXIT } from '../src/rootLock.ts';
import { hostPlatform } from '../src/platform/index.ts';

const ENABLED = process.env.RUN_DOCKER_ROOT_LOCK === '1';
const DOCKER = (process.env.CC_DOCKER ?? 'docker').split(/\s+/);
const IMAGE = process.env.CC_DOCKER_IMAGE ?? 'node:24-slim';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The holder's whole import closure: rootLock.ts and what it imports.
const FILES = [
  'tests/rootLockHolder.mjs', 'src/rootLock.ts', 'src/storeLock.ts',
  'src/platform/index.ts', 'src/platform/platform.ts', 'src/platform/posix.ts', 'src/platform/win32.ts',
  'src/platform/rootLockAddress.ts', 'src/systems/ptyHost.ts',
];
const NAME = `cc-root-lock-${process.pid}`;
const QUIET = { warn() {} };

const run = (argv) => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), (err, stdout, stderr) => {
    if (err) { Object.assign(err, { stdout, stderr }); reject(err); } else resolve(stdout);
  });
});
const docker = (...args) => run([...DOCKER, ...args]);

function stageApp(t) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-root-lock-docker-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(stage, 'app', f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(stage, 'app', f));
  }
  return stage;
}

async function waitForLog(ctr, re) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const logs = await docker('logs', ctr).catch((e) => `${e.stdout ?? ''}${e.stderr ?? ''}`);
    if (re.test(logs)) return logs;
    if (Date.now() > deadline) throw new Error(`${ctr} never printed ${re}\n${logs}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const holderArgs = (appDir, root) => ['--entrypoint', 'node', IMAGE, `${appDir}/tests/rootLockHolder.mjs`, root];

test('host ↔ container: a holder in a container refuses this process; docker kill frees the root at once', { skip: !ENABLED, timeout: 180_000 }, async (t) => {
  const stage = stageApp(t);
  const ctr = `${NAME}-host`;
  t.after(() => docker('rm', '-f', ctr).catch(() => {}));
  const root = path.join(stage, 'root');
  const lockDir = path.join(root, '.code-conductor', ROOT_LOCK_DIRNAME);
  fs.mkdirSync(lockDir, { recursive: true });
  // The container may write as another uid; both sides must create and remove here.
  for (const d of [root, path.dirname(lockDir), lockDir]) fs.chmodSync(d, 0o777);

  const seen = await docker('run', '--rm', '-v', `${stage}:/stage:ro`, '--entrypoint', 'ls', IMAGE, '/stage/app/tests')
    .catch((e) => e.stderr ?? String(e));
  assert.match(seen, /rootLockHolder\.mjs/,
    `precondition: the docker daemon cannot see ${stage} — it does not share this process's filesystem, so a host ↔ container lock cannot be exercised here`);

  await docker('run', '-d', '--name', ctr, '-v', `${path.join(stage, 'app')}:/app:ro`, '-v', `${root}:/elsewhere`,
    ...holderArgs('/app', '/elsewhere'));
  await waitForLog(ctr, /HELD 1\n/);

  const rec = JSON.parse(fs.readFileSync(path.join(lockDir, '1.json'), 'utf8'));
  assert.equal(rec.sock.kind, 'store', 'the holder listens inside the shared store');
  await assert.rejects(
    acquireRootLock({ storeDir: path.dirname(lockDir), platform: hostPlatform, log: QUIET }),
    (e) => e instanceof RootLockHeldError && e.holderPid === rec.pid,
  );

  await docker('kill', ctr);
  const lock = await acquireRootLock({ storeDir: path.dirname(lockDir), platform: hostPlatform, log: QUIET });
  t.after(() => lock.releaseSync());
  assert.equal(lock.gen, 2);
});

test('container ↔ container on one volume: a holder at pid 1 refuses a contender at pid 1; docker kill frees the root', { skip: !ENABLED, timeout: 180_000 }, async (t) => {
  const stage = stageApp(t);
  const vol = `${NAME}-vol`;
  const [loader, holder, next] = ['loader', 'holder', 'next'].map((s) => `${NAME}-${s}`);
  t.after(async () => {
    await docker('rm', '-f', loader, holder, next).catch(() => {});
    await docker('volume', 'rm', '-f', vol).catch(() => {});
  });
  await docker('volume', 'create', vol);
  // `docker cp` streams from this side, so it reaches a daemon that cannot see our filesystem.
  await docker('create', '--name', loader, '-v', `${vol}:/v`, '--entrypoint', 'true', IMAGE);
  await docker('cp', path.join(stage, 'app'), `${loader}:/v/app`);
  await docker('rm', loader);

  await docker('run', '-d', '--name', holder, '-v', `${vol}:/v`, ...holderArgs('/v/app', '/v/root'));
  await waitForLog(holder, /HELD 1\n/);

  const refused = await docker('run', '--rm', '-v', `${vol}:/v`, ...holderArgs('/v/app', '/v/root'))
    .then((stdout) => ({ code: 0, stdout }), (e) => ({ code: e.code, stdout: e.stdout }));
  assert.equal(refused.code, ROOT_LOCK_HELD_EXIT, refused.stdout);
  assert.equal(refused.stdout, 'REFUSED 1\n', 'the holder\'s recorded pid is the contender\'s own pid 1, and it is still refused');

  await docker('kill', holder);
  await docker('run', '-d', '--name', next, '-v', `${vol}:/v`, ...holderArgs('/v/app', '/v/root'));
  await waitForLog(next, /HELD 2\n/);
});
