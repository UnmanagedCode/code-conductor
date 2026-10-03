// What the Windows installer (the separate code-conductor-windows project)
// relies on from a cc ref: docs/windows.md#installer-contract. One test per
// clause pinned here; a failure means an installer release breaks against
// this tree, so change the contract (and the installer) rather than the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultInstallDir, detectClaude, launcherEnv } from '../bin/windows-launch.mjs';
import { resolveGitBash, gitRootOfBash } from '../src/platform/win32.ts';
import { getSelfUpdateStatus, applySelfUpdate } from '../src/selfUpdate.ts';
import { bootServer } from './helpers.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = 'bin/windows-launch.mjs';
const w = path.win32;
const USER = 'C:\\Users\\Jo Bloggs';
const LOCAL = `${USER}\\AppData\\Local`;
const existsIn = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};

test('C2: root files at the ref: string version, engines.node as >=N[.N[.N]], lockfile and LICENSE', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.version, 'string');
  assert.match(pkg.engines?.node ?? '', /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  for (const f of ['package-lock.json', 'LICENSE']) assert.ok(fs.existsSync(path.join(repo, f)), f);
});

test('C3: npm ci needs only node + npm: no locked package has an install script', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const scripted = Object.entries(lock.packages).filter(([, p]) => p.hasInstallScript).map(([k]) => k);
  assert.deepEqual(scripted, []);
});

test('C4: the launcher is bin/windows-launch.mjs and its install dir is the checkout\'s parent', () => {
  assert.ok(fs.existsSync(path.join(repo, LAUNCHER)));
  assert.equal(defaultInstallDir(), path.resolve(repo, '..'));
});

// The launcher run from a throwaway <install>\app, so default mode's logs\
// lands in the temp install dir rather than beside this checkout.
function installLayout() {
  const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-contract-'));
  const app = path.join(inst, 'app');
  for (const f of [LAUNCHER, 'src/platform/win32.ts', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
    fs.copyFileSync(path.join(repo, f), path.join(app, f));
  }
  return { inst, launcher: path.join(app, LAUNCHER), cleanup: () => fs.rmSync(inst, { recursive: true, force: true }) };
}

// -> {code, lines}: the launcher's exit code and its non-empty output lines.
function runLauncher(launcher, port, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [launcher, ...args], { cwd: os.tmpdir(), env: { ...process.env, PORT: String(port) } }, (err, stdout, stderr) => {
      const lines = `${stdout}${stderr}`.split('\n').filter((l) => l.trim());
      resolve({ code: err ? err.code : 0, lines });
    });
  });
}

async function responder(body) {
  const srv = http.createServer((req, res) => res.end(typeof body === 'string' ? body : JSON.stringify(body)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

async function closedPort() {
  const s = await responder('');
  await s.close();
  return s.port;
}

test('C5: exit codes of --status, --stop and the default mode, from any cwd', async () => {
  const L = installLayout();
  const cc = await responder({ ok: true, app: 'code-conductor', pid: 4242 });
  const unidentified = await responder({ ok: true });
  const html = await responder('<html>hi</html>');
  try {
    const closed = await closedPort();
    assert.equal((await runLauncher(L.launcher, cc.port, '--status')).code, 0);
    assert.equal((await runLauncher(L.launcher, closed, '--status')).code, 1);
    assert.equal((await runLauncher(L.launcher, unidentified.port, '--status')).code, 2);
    assert.equal((await runLauncher(L.launcher, closed, '--stop')).code, 0);
    const def = await runLauncher(L.launcher, html.port);
    assert.equal(def.code, 1);
    assert.equal(def.lines.length, 1, def.lines.join('\n'));
    assert.match(def.lines[0], /in use by another program/);
  } finally { await cc.close(); await unidentified.close(); await html.close(); L.cleanup(); }
});

test('C6: --status recognises a real server by /api/health app + pid', async () => {
  const L = installLayout();
  const srv = await bootServer();
  try {
    const health = await (await fetch(`${srv.baseUrl}/api/health`)).json();
    assert.equal(health.app, 'code-conductor');
    assert.ok(Number.isInteger(health.pid));
    assert.equal((await runLauncher(L.launcher, new URL(srv.baseUrl).port, '--status')).code, 0);
  } finally { await srv.close(); L.cleanup(); }
});

test('C8: Git Bash and claude are found at the installer\'s locations with an empty PATH', () => {
  const env = { PATH: '', LOCALAPPDATA: LOCAL, USERPROFILE: USER };
  const bash = `${LOCAL}\\Programs\\Git\\bin\\bash.exe`;
  const claude = `${USER}\\.local\\bin\\claude.exe`;
  assert.equal(resolveGitBash(env, existsIn(bash)), bash);
  assert.deepEqual(detectClaude(env, existsIn(claude)), { claudeExe: claude, dir: `${USER}\\.local\\bin` });
});

test('C8: every Git layout the installer accepts (git.exe in cmd or bin, plus bin\\bash.exe) resolves to the same root', () => {
  const layouts = [
    { root: 'C:\\Git', env: { PATH: 'C:\\Git\\cmd' }, git: 'C:\\Git\\cmd\\git.exe' },
    { root: 'C:\\Git', env: { PATH: 'C:\\Git\\bin' }, git: 'C:\\Git\\bin\\git.exe' },
    { root: `${LOCAL}\\Programs\\Git`, env: { PATH: '', LOCALAPPDATA: LOCAL }, git: `${LOCAL}\\Programs\\Git\\cmd\\git.exe` },
    { root: 'C:\\Program Files\\Git', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, git: 'C:\\Program Files\\Git\\cmd\\git.exe' },
  ];
  for (const { root, env, git } of layouts) {
    const bash = resolveGitBash(env, existsIn(git, w.join(root, 'bin', 'bash.exe')));
    assert.equal(gitRootOfBash(bash), root, git);
  }
});

const git = (cwd, args, env = process.env) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();

test('C9: the installer\'s checkout recipe yields a clean LF checkout that self-update drives unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-contract-checkout-'));
  try {
    const seed = path.join(root, 'seed');
    const origin = path.join(root, 'origin.git');
    fs.mkdirSync(seed);
    git(seed, ['-c', 'init.defaultBranch=main', 'init', '-q']);
    git(seed, ['config', 'user.email', 't@t']);
    git(seed, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"code-conductor","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(seed, 'conductor.sh'), '#!/usr/bin/env bash\nexec true\n');
    const commit = (msg) => {
      fs.appendFileSync(path.join(seed, 'f.txt'), `${msg}\n`);
      git(seed, ['add', '-A']);
      git(seed, ['commit', '-q', '-m', msg]);
    };
    commit('c1');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(seed, ['push', '-q', origin, 'main']);
    const bundle = path.join(root, 'cc.bundle');
    git(seed, ['bundle', 'create', bundle, 'refs/heads/main']);

    // Git for Windows' installer defaults to a global autocrlf=true.
    const globalCfg = path.join(root, 'gitconfig');
    fs.writeFileSync(globalCfg, '[core]\n\tautocrlf = true\n[user]\n\temail = t@t\n\tname = t\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
    const app = path.join(root, 'app');
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '-q', '--branch', 'main', bundle, app], { env });
    git(app, ['config', 'core.autocrlf', 'false'], env);
    git(app, ['remote', 'set-url', 'origin', origin], env);

    assert.equal(git(app, ['status', '--porcelain'], env), '');
    assert.match(git(app, ['ls-files', '--eol', 'conductor.sh'], env), /w\/lf/);
    assert.equal(git(app, ['rev-parse', '--abbrev-ref', '@{u}'], env), 'origin/main');

    let s = await getSelfUpdateStatus({ repoRoot: app });
    assert.equal(s.canCheck, true);
    assert.equal(s.behind, 0);
    assert.equal(s.version, '1.0.0');
    commit('c2');
    git(seed, ['push', '-q', origin, 'main']);
    s = await getSelfUpdateStatus({ repoRoot: app });
    assert.equal(s.behind, 1);
    assert.equal(s.updateAvailable, true);
    const r = await applySelfUpdate({ repoRoot: app, npmCmd: 'true' });
    assert.equal(r.ok, true);
    assert.equal(git(app, ['rev-parse', 'HEAD']), git(seed, ['rev-parse', 'HEAD']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C10: projects root defaults to %USERPROFILE%\\code-conductor; an inherited PROJECTS_ROOT wins', () => {
  const base = { env: { PATH: '', USERPROFILE: USER }, installDir: `${LOCAL}\\Programs\\code-conductor`, git: null, claude: null };
  assert.equal(launcherEnv(base).PROJECTS_ROOT, `${USER}\\code-conductor`);
  assert.equal(launcherEnv({ ...base, env: { ...base.env, PROJECTS_ROOT: 'D:\\work' } }).PROJECTS_ROOT, 'D:\\work');
});
