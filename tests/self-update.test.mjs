import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSelfUpdateStatus, applySelfUpdate } from '../src/selfUpdate.ts';
import { buildRoutes } from '../src/routes.ts';
import { ensureProjectConventionsMd } from '../src/projectClaudeMd.ts';
import { makePluginRoot } from './plugin-helpers.mjs';
import { registerLocalProject } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { adoptProject, findSelfProject } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { withMaintenanceLock } from '../src/relaunchPrep.ts';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

// Build a bare "origin" + a seed repo pushed to it + a fresh clone that acts
// as the running conductor checkout. Returns { clone, seed, remote, cleanup }.
// `version` and `deps` (name → range) seed package.json (readVersion source,
// and what dependencyDrift reads). `lock` seeds a tracked package-lock.json.
async function setupRepo({ version = '0.1.0', deps = null, lock = null } = {}) {
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'su-remote-'));
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'su-seed-'));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'su-clone-'));
  await git(remote, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
  await git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  await git(seed, 'config', 'user.email', 'test@test');
  await git(seed, 'config', 'user.name', 'test');
  await fs.writeFile(path.join(seed, 'package.json'), packageJson(version, deps));
  await fs.writeFile(path.join(seed, 'server.txt'), 'v1');
  if (lock) await fs.writeFile(path.join(seed, 'package-lock.json'), lockFile(lock));
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
    // Push a new upstream commit: each file (over)written, or removed when its
    // content is null.
    async pushUpstream(msg, files) {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) await fs.rm(path.join(seed, rel));
        else await fs.writeFile(path.join(seed, rel), content);
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

// cc's package.json at `version`, declaring `deps` (name → range) when given.
function packageJson(version, deps = null) {
  return JSON.stringify({ name: 'code-conductor', version, ...(deps ? { dependencies: deps } : {}) });
}
// A package-lock.json locking each name at its version.
function lockFile(versions) {
  const packages = { '': { name: 'code-conductor' } };
  for (const [name, version] of Object.entries(versions)) packages[`node_modules/${name}`] = { version };
  return JSON.stringify({ name: 'code-conductor', lockfileVersion: 3, packages });
}
// Puts each name at its version into the clone's (untracked) node_modules.
async function install(clone, versions) {
  for (const [name, version] of Object.entries(versions)) {
    await fs.mkdir(path.join(clone, 'node_modules', name), { recursive: true });
    await fs.writeFile(path.join(clone, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
}
// An injected install command that writes `name` at `version` and leaves a marker.
const installA = (clone, version, name = 'a') =>
  `echo installing && mkdir -p node_modules/${name} && printf '{"version":"${version}"}' > node_modules/${name}/package.json && touch "${path.join(clone, 'npm-marker')}"`;

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

test('getSelfUpdateStatus: diverged (local + remote ahead) -> diverged true, updateAvailable false, no Update offered', async () => {
  const r = await setupRepo();
  try {
    // Local diverging commit on the clone…
    await fs.writeFile(path.join(r.clone, 'server.txt'), 'local-change');
    await git(r.clone, 'add', '-A');
    await git(r.clone, 'commit', '-q', '-m', 'local');
    // …and a conflicting upstream commit.
    await r.pushUpstream('v2', { 'server.txt': 'remote-change' });
    const s = await getSelfUpdateStatus({ repoRoot: r.clone });
    assert.equal(s.canCheck, true);
    assert.equal(s.ahead, 1);
    assert.equal(s.behind, 1);
    assert.equal(s.diverged, true);
    assert.equal(s.updateAvailable, false, 'a diverged checkout must not advertise an applicable update');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: fast-forwards, streams pull chunks, restartRequired; a package.json edit node_modules still satisfies -> npm skipped', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0' });
    // The range changes but the installed version still satisfies it: no drift, so no install.
    await r.pushUpstream('v2', { 'server.txt': 'v2', 'package.json': packageJson('0.1.0', { a: '~1.0.0' }) });
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

test('applySelfUpdate: the pull bumps a range past the installed version -> runs npm install (injected), streams it, depsChanged true, npm.ok', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0' });
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.1.0', { a: '^2.0.0' }) });
    const phases = [];
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: installA(r.clone, '2.0.0'), onChunk: (phase) => phases.push(phase) });
    assert.equal(result.depsChanged, true);
    assert.deepEqual({ ran: result.npm.ran, ok: result.npm.ok, code: result.npm.code }, { ran: true, ok: true, code: 0 });
    assert.match(result.npm.tail, /installing/);
    assert.ok(phases.includes('npm'), 'npm output streamed');
    assert.equal(result.restartRequired, true);
    assert.ok((await fs.stat(path.join(r.clone, 'npm-marker'))).isFile(), 'injected npm command ran');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: the pull adds a dependency -> runs npm install', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0' });
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.1.0', { a: '^1.0.0', b: '^3.0.0' }) });
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: installA(r.clone, '3.0.0', 'b') });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ok, true);
    assert.ok((await fs.stat(path.join(r.clone, 'npm-marker'))).isFile(), 'injected npm command ran');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: the pull removes a dependency -> runs npm install, which prunes it', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0', b: '^3.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0', b: '3.0.0' });
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.1.0', { a: '^1.0.0' }) });
    const result = await applySelfUpdate({
      repoRoot: r.clone, npmCmd: `echo pruning && rm -rf node_modules/b && touch "${path.join(r.clone, 'npm-marker')}"`,
    });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ok, true);
    assert.ok((await fs.stat(path.join(r.clone, 'npm-marker'))).isFile(), 'injected npm command ran');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: drift that predates the pull -> npm install runs after a code-only pull', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await r.pushUpstream('v2', { 'server.txt': 'v2' });
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: installA(r.clone, '1.0.0') });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ok, true);
    assert.ok((await fs.stat(path.join(r.clone, 'npm-marker'))).isFile(), 'injected npm command ran');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: npm install failure surfaces npm.ok false with code and tail (pull already applied)', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0' });
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.2.0', { a: '^2.0.0' }) });
    const result = await applySelfUpdate({
      repoRoot: r.clone,
      npmCmd: 'echo "npm ERR! boom" >&2; exit 1',
    });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ran, true);
    assert.equal(result.npm.ok, false);
    assert.equal(result.npm.code, 1);
    assert.match(result.npm.tail, /boom/);
    assert.equal(result.npm.error, 'npm install failed (exit 1)');
    assert.equal(result.restartRequired, false, 'a failed npm install must not advertise a ready-to-restart tree');
    assert.equal(result.version, '0.2.0', 'version reflects the pulled package.json');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: an install that leaves node_modules out of sync is a failed npm step naming the drift', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  try {
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.1.0', { a: '^2.0.0' }) });
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: installA(r.clone, '1.5.0') });
    assert.equal(result.npm.ok, false);
    assert.match(result.npm.tail, /still differs: node_modules\/a 1\.5\.0 does not satisfy \^2\.0\.0/);
    assert.equal(result.restartRequired, false);
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: a linked node_modules out of sync is a failed npm step that never ran, naming DEPS_LINKED\'s reason', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' } });
  const shared = await fs.mkdtemp(path.join(os.tmpdir(), 'su-shared-modules-'));
  try {
    await fs.symlink(shared, path.join(r.clone, 'node_modules'), 'dir');
    await r.pushUpstream('v2 deps', { 'package.json': packageJson('0.1.0', { a: '^2.0.0' }) });
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: installA(r.clone, '2.0.0') });
    assert.equal(result.depsChanged, true);
    assert.equal(result.npm.ran, false);
    assert.equal(result.npm.ok, false);
    assert.match(result.npm.tail, /is a link to .*run npm install there/);
    assert.match(result.npm.error, /^node_modules does not satisfy package\.json \(node_modules\/a missing\) and is a link to /);
    assert.equal(result.restartRequired, false);
    await assert.rejects(fs.stat(path.join(r.clone, 'npm-marker')), { code: 'ENOENT' }, 'npm command not run');
    assert.deepEqual(await fs.readdir(shared), [], 'the linked tree is untouched');
  } finally { await r.cleanup(); await fs.rm(shared, { recursive: true, force: true }); }
});

test('applySelfUpdate: a pull that untracks package-lock.json with package.json unchanged -> the lock leaves the disk, npm skipped', async () => {
  const r = await setupRepo({ deps: { a: '^1.0.0' }, lock: { a: '1.0.0' } });
  try {
    await install(r.clone, { a: '1.0.0' });
    await r.pushUpstream('untrack the lock', { 'package-lock.json': null });
    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: `touch "${path.join(r.clone, 'npm-marker')}"` });
    await assert.rejects(fs.stat(path.join(r.clone, 'package-lock.json')), { code: 'ENOENT' }, 'the pull removed the lock');
    assert.equal(result.depsChanged, false);
    assert.equal(result.npm, null);
    assert.equal(result.restartRequired, true);
    await assert.rejects(fs.stat(path.join(r.clone, 'npm-marker')), { code: 'ENOENT' }, 'npm command not run');
  } finally { await r.cleanup(); }
});

test('applySelfUpdate: refused 409 MAINTENANCE_IN_PROGRESS while a restart holds the lock, before anything streams or pulls', async () => {
  const r = await setupRepo();
  try {
    await r.pushUpstream('v2', { 'server.txt': 'v2' });
    let release;
    const restart = withMaintenanceLock('restart', () => new Promise((res) => { release = res; }));
    let validated = false;
    await assert.rejects(applySelfUpdate({ repoRoot: r.clone, onValidated: () => { validated = true; } }), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'MAINTENANCE_IN_PROGRESS');
      return true;
    });
    assert.equal(validated, false);
    assert.equal(await fs.readFile(path.join(r.clone, 'server.txt'), 'utf8'), 'v1', 'nothing pulled');
    release();
    await restart;
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
  const prevNpm = process.env.CC_NPM_INSTALL_CMD;
  process.env.SELF_UPDATE_REPO_ROOT = r.clone;
  process.env.CC_NPM_INSTALL_CMD = 'true';
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
    if (prevNpm === undefined) delete process.env.CC_NPM_INSTALL_CMD; else process.env.CC_NPM_INSTALL_CMD = prevNpm;
    await r.cleanup();
  }
});

// ── Pulling past cc's own regenerated convention files ───────────────────────
//
// When cc's checkout is itself a registered project, cc regenerates its tracked
// CONVENTIONS.md and prepends the import to its CLAUDE.md — the dirt below is
// made by the real generator. The seed carries both files so both go ` M`.
async function setupRegisterableRepo() {
  const r = await setupRepo();
  await r.pushUpstream('conventions', {
    'CLAUDE.md': '# cc\n',
    'CONVENTIONS.md': '<!-- cc:conventions -->\n\nAn upstream copy.\n',
  });
  await git(r.clone, 'pull', '-q', '--ff-only');
  return r;
}

const snapshot = async (dir) => ({
  conv: await fs.readFile(path.join(dir, 'CONVENTIONS.md'), 'utf8'),
  claude: await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8'),
});

test('applySelfUpdate: a registered checkout with cc-generated dirt pulls an upstream CONVENTIONS.md change', async () => {
  const env = await makePluginRoot();
  const r = await setupRegisterableRepo();
  try {
    await registerLocalProject('cc-self', r.clone);
    assert.equal((await ensureProjectConventionsMd('cc-self')).regenerated, true, 'precondition: the generator wrote the file');
    await r.pushUpstream('v2', { 'CONVENTIONS.md': '<!-- cc:conventions -->\n\nA newer copy.\n', 'server.txt': 'v2' });

    const result = await applySelfUpdate({ repoRoot: r.clone, npmCmd: 'true' });
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(r.clone, 'server.txt'), 'utf8'), 'v2');
    const after = await snapshot(r.clone);
    await ensureProjectConventionsMd('cc-self');
    assert.deepEqual(await snapshot(r.clone), after, 'the checkout holds a fresh regeneration');
    assert.equal(after.claude, '@CONVENTIONS.md\n# cc\n');
  } finally {
    await r.cleanup();
    await env.restore();
  }
});

test('applySelfUpdate: an unregistered checkout is never touched — the same dirt refuses with 502 as before', async () => {
  const env = await makePluginRoot();
  const r = await setupRegisterableRepo();
  try {
    // The generator's bytes, carried over from a registered twin, so the dirt is
    // exactly what cc would write — but no project names this checkout.
    const twin = path.join(env.root, 'twin');
    await git(env.root, 'clone', '-q', r.remote, 'twin');
    await registerLocalProject('twin', twin);
    await ensureProjectConventionsMd('twin');
    for (const f of ['CONVENTIONS.md', 'CLAUDE.md']) await fs.copyFile(path.join(twin, f), path.join(r.clone, f));
    const before = await snapshot(r.clone);
    await r.pushUpstream('v2', { 'CONVENTIONS.md': '<!-- cc:conventions -->\n\nA newer copy.\n' });

    let err;
    try { await applySelfUpdate({ repoRoot: r.clone, npmCmd: 'true' }); } catch (e) { err = e; }
    assert.equal(err?.statusCode, 502);
    assert.deepEqual(await snapshot(r.clone), before);
  } finally {
    await r.cleanup();
    await env.restore();
  }
});

test('applySelfUpdate: a checkout matched only by a project on a remote system is treated as unregistered', async () => {
  const env = await makePluginRoot();
  const r = await setupRegisterableRepo();
  try {
    // The reference provider IS this machine, so a remote project at the
    // checkout's own absolute path resolves to the same tree by realpath.
    const remote = await bindRemoteSystem();
    const adopted = await adoptProject('cc-remote', await fs.realpath(r.clone), { system: remote.id });
    assert.equal(adopted.ok, true, JSON.stringify(adopted));
    assert.equal((await findSelfProject(r.clone))?.name, 'cc-remote', 'precondition: findSelfProject pairs them');
    await ensureProjectConventionsMd('cc-remote');
    const before = await snapshot(r.clone);
    assert.notEqual(before.claude, '# cc\n', 'precondition: the generator wrote the import');
    await r.pushUpstream('v2', { 'CONVENTIONS.md': '<!-- cc:conventions -->\n\nA newer copy.\n' });

    let err;
    try { await applySelfUpdate({ repoRoot: r.clone, npmCmd: 'true' }); } catch (e) { err = e; }
    assert.equal(err?.statusCode, 502);
    assert.deepEqual(await snapshot(r.clone), before);
  } finally {
    disposeSystemHandles();
    await r.cleanup();
    await env.restore();
  }
});
