import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkout } from '../installer/windows/setup.mjs';
import { getSelfUpdateStatus, applySelfUpdate } from '../src/selfUpdate.ts';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// seed (working repo) -> origin.git (stands in for GitHub) and bundles cut
// from the seed at chosen commits.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-checkout-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(seed);
  git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"code-conductor","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(seed, 'conductor.sh'), '#!/usr/bin/env bash\nexec true\n');
  const commit = (msg, file = 'f.txt') => {
    fs.appendFileSync(path.join(seed, file), `${msg}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', msg);
  };
  commit('c1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, 'push', '-q', origin, 'main');
  const bundle = (name) => {
    const f = path.join(root, name);
    git(seed, 'bundle', 'create', f, 'refs/heads/main');
    return f;
  };
  // Windows git installers default to a global autocrlf=true.
  const globalCfg = path.join(root, 'gitconfig');
  fs.writeFileSync(globalCfg, '[core]\n\tautocrlf = true\n[user]\n\temail = t@t\n\tname = t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
  return { root, seed, origin, bundle, commit, env, log: () => {}, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('fresh checkout: branch + upstream + origin URL + LF + clean', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    await checkout({ git: 'git', bundle: t.bundle('b1.bundle'), dir, branch: 'main', remoteUrl: t.origin, log: t.log, env: t.env });
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.equal(git(dir, 'remote', 'get-url', 'origin'), t.origin);
    assert.equal(execFileSync('git', ['-C', dir, 'config', '--local', 'core.autocrlf'], { encoding: 'utf8', env: t.env }).trim(), 'false');
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.match(execFileSync('git', ['-C', dir, 'ls-files', '--eol', 'conductor.sh'], { encoding: 'utf8', env: t.env }), /w\/lf/);
    assert.ok(!fs.readFileSync(path.join(dir, 'conductor.sh'), 'utf8').includes('\r'));
  } finally { t.cleanup(); }
});

test('self-update works unchanged on the installed checkout', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    await checkout({ git: 'git', bundle: t.bundle('b1.bundle'), dir, branch: 'main', remoteUrl: t.origin, log: t.log, env: t.env });
    let s = await getSelfUpdateStatus({ repoRoot: dir });
    assert.equal(s.canCheck, true);
    assert.equal(s.behind, 0);
    assert.equal(s.version, '1.0.0');
    t.commit('c2');
    git(t.seed, 'push', '-q', t.origin, 'main');
    s = await getSelfUpdateStatus({ repoRoot: dir });
    assert.equal(s.behind, 1);
    assert.equal(s.updateAvailable, true);
    const r = await applySelfUpdate({ repoRoot: dir, npmCmd: 'true' });
    assert.equal(r.ok, true);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(t.seed, 'rev-parse', 'HEAD'));
  } finally { t.cleanup(); }
});

test('rerun with a newer bundle fast-forwards; an older one keeps HEAD', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, log: t.log, env: t.env };
    const b1 = t.bundle('b1.bundle');
    await checkout({ ...args, bundle: b1 });
    const c1 = git(dir, 'rev-parse', 'HEAD');
    t.commit('c2');
    const b2 = t.bundle('b2.bundle');
    await checkout({ ...args, bundle: b2 });
    const c2 = git(dir, 'rev-parse', 'HEAD');
    assert.notEqual(c2, c1);
    assert.equal(c2, git(t.seed, 'rev-parse', 'HEAD'));
    await checkout({ ...args, bundle: b1 });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c2);
    await checkout({ ...args, bundle: b2 });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c2);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally { t.cleanup(); }
});

test('a non-empty directory that is not a checkout is refused', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x'), 'x');
    await assert.rejects(checkout({ git: 'git', bundle: t.bundle('b.bundle'), dir, branch: 'main', remoteUrl: t.origin, log: t.log, env: t.env }), /not a git checkout/);
  } finally { t.cleanup(); }
});

test('a dirty checkout that blocks the fast-forward is kept and the install continues', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const lines = [];
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, log: (m) => lines.push(m), env: t.env };
    await checkout({ ...args, bundle: t.bundle('b1.bundle') });
    const c1 = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'f.txt'), 'local edit\n');
    t.commit('c2'); // touches f.txt too, so the ff would overwrite the edit
    await checkout({ ...args, bundle: t.bundle('b2.bundle') });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c1);
    assert.match(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), /local edit/);
    assert.ok(lines.some((l) => /NOT fast-forwarded/.test(l) && /self-update/.test(l)));
    assert.equal(git(dir, 'remote', 'get-url', 'origin'), t.origin);
  } finally { t.cleanup(); }
});
