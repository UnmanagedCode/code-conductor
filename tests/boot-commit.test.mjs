// src/bootCommit.ts: what a checkout would run as (measureBootCommit), and the
// merge-hook vars the server derives from it (bootCommitHookVars). Nothing is
// written anywhere: the capture lives in the serving process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { measureBootCommit, bootCommitHookVars } from '../src/bootCommit.ts';

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

async function repo({ commit = true } = {}) {
  const dir = await fs.realpath(await mkdtemp('cc-bootcommit-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  for (const f of ['web/app.tsx', 'src/server.ts']) {
    await fs.mkdir(path.join(dir, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), 'v1\n');
  }
  if (commit) {
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}
const head = async (dir) => (await git(dir, 'rev-parse', 'HEAD')).trim();

// ── measureBootCommit ──────────────────────────────────────────────────────

test('a clean checkout measures as HEAD, and writes nothing into the checkout or its git dir', async () => {
  const dir = await repo();
  const gitDirBefore = (await fs.readdir(path.join(dir, '.git'))).sort();
  assert.deepEqual(await measureBootCommit(dir), { sha: await head(dir) });
  assert.deepEqual((await fs.readdir(path.join(dir, '.git'))).sort(), gitDirBefore);
  assert.equal(await git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('a tracked change only under web/ still measures as HEAD: the backend matches it', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'web', 'app.tsx'), 'v2\n');
  assert.deepEqual(await measureBootCommit(dir), { sha: await head(dir) });
});

test('an untracked file outside web/ still measures as HEAD: it is not something the server runs from', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'notes.txt'), 'scratch\n');
  assert.deepEqual(await measureBootCommit(dir), { sha: await head(dir) });
});

test('a tracked change outside web/ is unknown, naming the file', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), 'v2\n');
  const r = await measureBootCommit(dir);
  assert.equal('sha' in r, false);
  assert.match(r.unknown, /tracked changes outside web\/.*src\/server\.ts/);
  assert.equal(r.head, await head(dir), 'still carries the HEAD it read, for the boot build\'s guard');
});

test('an unborn HEAD is unknown', async () => {
  const dir = await repo({ commit: false });
  const r = await measureBootCommit(dir);
  assert.match(r.unknown, /unborn/);
  assert.equal(r.head, undefined);
});

test('outside a git checkout: unknown, and no throw', async () => {
  const dir = await fs.realpath(await mkdtemp('cc-bootcommit-nogit-'));
  assert.match((await measureBootCommit(dir)).unknown, /not a git checkout/);
  assert.deepEqual(await fs.readdir(dir), []);
});

// ── bootCommitHookVars ─────────────────────────────────────────────────────

test('hook vars: only the server\'s own checkout gets the boot commit, and only while no web build of its own runs', async () => {
  const root = await repo();
  const other = await repo();
  const link = `${root}-link`;
  await fs.symlink(root, link);
  let building = false;
  const vars = bootCommitHookVars({ checkoutRoot: root, boot: { sha: 'a'.repeat(40) }, webBuildRunning: () => building });
  try {
    assert.deepEqual(vars(root), { CC_SERVER_BOOT_SHA: 'a'.repeat(40) });
    assert.deepEqual(vars(link), { CC_SERVER_BOOT_SHA: 'a'.repeat(40) }, 'compared by realpath');
    assert.deepEqual(vars(other), {}, 'another checkout gets neither var');
    assert.deepEqual(vars(path.join(root, 'web')), {}, 'a directory inside it is not the checkout');
    building = true;
    assert.deepEqual(vars(root), { CC_SERVER_BOOT_UNKNOWN: 'the server\'s own web build is running' },
      'read when called: a build that started since the capture counts');
    assert.deepEqual(vars(other), {});
  } finally { await fs.rm(link, { force: true }); }
});

test('hook vars: an unknown boot commit reaches its own checkout as CC_SERVER_BOOT_UNKNOWN with the reason', async () => {
  const root = await repo();
  const vars = bootCommitHookVars({ checkoutRoot: root, boot: { unknown: 'HEAD is unborn or unreadable' }, webBuildRunning: () => false });
  assert.deepEqual(vars(root), { CC_SERVER_BOOT_UNKNOWN: 'HEAD is unborn or unreadable' });
});
