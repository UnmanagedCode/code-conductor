import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSelfUpdateStatus, applySelfUpdate } from '../src/selfUpdate.js';
import { buildRoutes } from '../src/routes.js';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

// Build a bare "origin" + a seed repo pushed to it + a fresh clone that acts
// as the running conductor checkout. Returns { clone, seed, remote, cleanup }.
// `version` seeds package.json (readVersion source). extraFiles seeds more
// tracked files at v1.
async function setupRepo({ version = '0.1.0' } = {}) {
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'su-remote-'));
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'su-seed-'));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'su-clone-'));
  await git(remote, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
  await git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  await git(seed, 'config', 'user.email', 'test@test');
  await git(seed, 'config', 'user.name', 'test');
  await fs.writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: 'code-conductor', version }));
  await fs.writeFile(path.join(seed, 'server.txt'), 'v1');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-q', '-m', 'v1');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-q', 'origin', 'main');
  await git(parent, 'clone', '-q', remote, 'clone');
  const clone = path.join(parent, 'clone');
  // ff-only pulls only need config for a diverged-commit test; set it anyway.
  await git(clone, 'config', 'user.email', 'test@test');
  await git(clone, 'config', 'user.name', 'test');
  return {
    clone, seed, remote,
    // Push a new upstream commit. touch = files to (over)write then commit.
    async pushUpstream(msg, files) {
      for (const [rel, content] of Object.entries(files)) {
        await fs.writeFile(path.join(seed, rel), content);
      }
      await git(seed, 'add', '-A');
      await git(seed, 'commit', '-q', '-m', msg);
      await git(seed, 'push', '-q', 'origin', 'main');
    },
    async cleanup() {
      await fs.rm(remote, { recursive: true, force: true });
      await fs.rm(seed, { recursive: true, force: true });
      await fs.rm(parent, { recursive: true, force: true });
    },
  };
}

test('getSelfUpdateStatus: up-to-date clone -> updateAvailable false, behind 0, version from package.json', async () => {
  const r = await setupRepo({ version: '1.2.3' });
  try {
    const s = await getSelfUpdateStatus({ repoRoot: r.clone });
    assert.equal(s.version, '1.2.3');
    assert.equal(s.canCheck, true);
    assert.equal(s.behind, 0);
    assert.equal(s.updateAvailable, false);
    assert.match(s.upstream, /main$/);
  } finally { await r.cleanup(); }
});

test('getSelfUpdateStatus: behind origin -> updateAvailable true, behind 1 (fetches first)', async () => {
  const r = await setupRepo();
  try {
    await r.pushUpstream('v2', { 'server.txt': 'v2' });
    const s = await getSelfUpdateStatus({ repoRoot: r.clone });
    assert.equal(s.canCheck, true);
    assert.equal(s.behind, 1);
    assert.equal(s.updateAvailable, true);
  } finally { await r.cleanup(); }
});

test('getSelfUpdateStatus: no upstream (git repo, no remote) -> canCheck false, behind null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'su-noup-'));
  try {
    await git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'v1');
    const s = await getSelfUpdateStatus({ repoRoot: dir });
    assert.equal(s.version, '9.9.9');
    assert.equal(s.canCheck, false);
    assert.equal(s.behind, null);
    assert.equal(s.updateAvailable, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('applySelfUpdate: fast-forwards, streams pull chunks, restartRequired; no dep change -> npm skipped', async () => {
  const r = await setupRepo();
  try {
    await r.pushUpstream('v2', { 'server.txt': 'v2' }); // code-only change
    let npmRan = false;
    const events = [];
    const result = await applySelfUpdate({
      repoRoot: r.clone,
      npmCmd: `touch "${path.join(r.clone, 'npm-marker')}"`,
      onValidated: () => events.push('validated'),
      onChunk: (phase, text) => { events.push(phase); if (phase === 'npm') npmRan = true; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.restartRequired, true);
    assert.equal(result.depsChanged, false);
    assert.equal(result.npm, null);
    assert.equal(npmRan, false);
    assert.equal(events[0], 'validated', 'onValidated fires before any chunk');
    assert.ok(events.includes('pull'), 'pull output streamed');
    assert.equal(await fs.readFile(path.join(r.clone, 'server.txt'), 'utf8'), 'v2', 'ff applied');
    await assert.rejects(fs.stat(path.join(r.clone, 'npm-marker')), { code: 'ENOENT' }, 'npm command not run');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: dependency manifest change -> runs npm install (injected), depsChanged true, npm.ok', async () => {
  const r = await setupRepo();
  try {
    await r.pushUpstream('v2 deps', { 'package-lock.json': '{"lockfileVersion":3}' });
    const marker = path.join(r.clone, 'npm-marker');
    const result = await applySelfUpdate({
      repoRoot: r.clone,
      npmCmd: `echo installing && touch "${marker}"`,
    });
    assert.equal(result.depsChanged, true);
    assert.ok(result.npm);
    assert.equal(result.npm.ran, true);
    assert.equal(result.npm.ok, true);
    assert.ok((await fs.stat(marker)).isFile(), 'injected npm command ran');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: npm install failure surfaces npm.ok false with tail (pull already applied)', async () => {
  const r = await setupRepo();
  try {
    await r.pushUpstream('v2 deps', { 'package.json': JSON.stringify({ name: 'code-conductor', version: '0.2.0' }) });
    const result = await applySelfUpdate({
      repoRoot: r.clone,
      npmCmd: 'echo "npm ERR! boom" >&2; exit 1',
    });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ok, false);
    assert.equal(result.npm.code, 1);
    assert.match(result.npm.tail, /boom/);
    assert.equal(result.version, '0.2.0', 'version reflects the pulled package.json');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: diverged local commit -> ff-only refuses with 502, tree untouched', async () => {
  const r = await setupRepo();
  try {
    // Local diverging commit on the clone…
    await fs.writeFile(path.join(r.clone, 'server.txt'), 'local-change');
    await git(r.clone, 'add', '-A');
    await git(r.clone, 'commit', '-q', '-m', 'local');
    // …and a conflicting upstream commit.
    await r.pushUpstream('v2', { 'server.txt': 'remote-change' });
    let err;
    try { await applySelfUpdate({ repoRoot: r.clone }); }
    catch (e) { err = e; }
    assert.ok(err, 'apply rejected');
    assert.equal(err.statusCode, 502);
    assert.ok(err.tail, 'error carries a git tail');
    assert.equal(await fs.readFile(path.join(r.clone, 'server.txt'), 'utf8'), 'local-change', 'ff-only left the tree untouched');
  } finally { await r.cleanup(); }
});

// HTTP wire contract: GET returns status JSON; POST streams NDJSON ending in a
// {type:'result'} line. Points the route (which calls with no args) at a temp
// clone via SELF_UPDATE_REPO_ROOT.
test('routes: GET /api/settings/self-update returns status; POST streams NDJSON result', async () => {
  const r = await setupRepo({ version: '3.0.0' });
  const prevRoot = process.env.SELF_UPDATE_REPO_ROOT;
  const prevNpm = process.env.SELF_UPDATE_NPM_CMD;
  process.env.SELF_UPDATE_REPO_ROOT = r.clone;
  process.env.SELF_UPDATE_NPM_CMD = 'true';
  const app = express();
  app.use('/api', buildRoutes({}));
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await r.pushUpstream('v2', { 'server.txt': 'v2' });

    const gres = await fetch(`${base}/api/settings/self-update`, { cache: 'no-store' });
    assert.equal(gres.status, 200);
    const status = await gres.json();
    assert.equal(status.version, '3.0.0');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.behind, 1);

    const pres = await fetch(`${base}/api/settings/self-update`, { method: 'POST', cache: 'no-store' });
    assert.equal(pres.status, 200);
    assert.match(pres.headers.get('content-type') || '', /ndjson/);
    const text = await pres.text();
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const result = lines.find(l => l.type === 'result');
    assert.ok(result, 'terminal result line present');
    assert.equal(result.ok, true);
    assert.equal(result.result.restartRequired, true);
  } finally {
    await new Promise((res) => server.close(res));
    if (prevRoot === undefined) delete process.env.SELF_UPDATE_REPO_ROOT; else process.env.SELF_UPDATE_REPO_ROOT = prevRoot;
    if (prevNpm === undefined) delete process.env.SELF_UPDATE_NPM_CMD; else process.env.SELF_UPDATE_NPM_CMD = prevNpm;
    await r.cleanup();
  }
});
