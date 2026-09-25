// harness/pluginDir.mjs — the one resolver both harnesses (mutation, playwright)
// use to find an installed plugin at `<projectsRoot>/.plugins/<name>`.
//
// Every call passes `env` explicitly: the ambient CC_PROJECTS_ROOT is set in any
// cc worker, so reading it would make the fallback tests pass or fail by where
// they run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginDir } from '../harness/pluginDir.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// <root>/proj is a main checkout (its `.git` a directory), and
// <root>/.worktrees/proj/wt a worktree of it (its `.git` a pointer file).
// <root>/.plugins/foo exists; <other>/.plugins/foo is the env-precedence target.
let base, root, other, proj, wt;
before(async () => {
  base = realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-plugin-dir-')));
  root = path.join(base, 'root');
  other = path.join(base, 'other');
  proj = path.join(root, 'proj');
  wt = path.join(root, '.worktrees', 'proj', 'wt');
  await fsp.mkdir(path.join(root, '.plugins', 'foo'), { recursive: true });
  await fsp.mkdir(path.join(other, '.plugins', 'foo'), { recursive: true });
  await fsp.mkdir(proj, { recursive: true });
  git(proj, 'init', '-q');
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'init');
  await fsp.mkdir(path.dirname(wt), { recursive: true });
  git(proj, 'worktree', 'add', '-q', wt);
});
after(async () => { await fsp.rm(base, { recursive: true, force: true }); });

test('CC_PROJECTS_ROOT wins over the git-derived root', () => {
  // Both roots hold `.plugins/foo`, so only precedence decides the answer.
  assert.equal(resolvePluginDir('foo', { env: { CC_PROJECTS_ROOT: other }, cwd: wt }),
    path.join(other, '.plugins', 'foo'));
});

test('without CC_PROJECTS_ROOT, a worktree resolves to the main checkout\'s projects root', () => {
  assert.equal(resolvePluginDir('foo', { env: {}, cwd: wt }), path.join(root, '.plugins', 'foo'));
});

test('without CC_PROJECTS_ROOT, the main checkout resolves to its parent', () => {
  assert.equal(resolvePluginDir('foo', { env: {}, cwd: proj }), path.join(root, '.plugins', 'foo'));
});

test('a missing plugin directory throws naming the path tried and CC_PROJECTS_ROOT', () => {
  const tried = new RegExp(`${escapeRe(path.join(root, '.plugins', 'absent'))}[\\s\\S]*CC_PROJECTS_ROOT`);
  assert.throws(() => resolvePluginDir('absent', { env: { CC_PROJECTS_ROOT: root }, cwd: wt }), tried);
  assert.throws(() => resolvePluginDir('absent', { env: {}, cwd: wt }), tried);
});
