// src/bootCommit.ts: what the running server booted from, recorded in the
// checkout's own git dir, and read back as a commit only when it can be
// vouched for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { recordBootCommit, readBootCommit, bootCommitPath } from '../src/bootCommit.ts';

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

const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(m), warn: (m) => lines.push(m) } };
};
const head = async (dir) => (await git(dir, 'rev-parse', 'HEAD')).trim();
const recordFile = async (dir) => (await git(dir, 'rev-parse', '--git-path', 'cc-boot-commit')).trim();

test('a clean checkout records HEAD, with this pid, and reads back as that commit', async () => {
  const dir = await repo();
  const rec = await recordBootCommit({ repoRoot: dir, log: quiet().log });
  assert.equal(rec.sha, await head(dir));
  assert.equal(rec.pid, process.pid);
  assert.deepEqual(await readBootCommit(dir), { sha: await head(dir) });
});

test('the record lands at `git rev-parse --git-path cc-boot-commit` and leaves `git status` clean', async () => {
  const dir = await repo();
  await recordBootCommit({ repoRoot: dir, log: quiet().log });
  const expected = path.resolve(dir, await recordFile(dir));
  assert.equal(await bootCommitPath(dir), expected);
  assert.equal(JSON.parse(await fs.readFile(expected, 'utf8')).sha, await head(dir));
  assert.equal(await git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('in a linked worktree the record is that worktree\'s own, not the main checkout\'s', async () => {
  const dir = await repo();
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  await git(dir, 'worktree', 'add', '-q', wt, '-b', 'side');
  try {
    await recordBootCommit({ repoRoot: wt, log: quiet().log });
    assert.notEqual(await bootCommitPath(wt), await bootCommitPath(dir));
    assert.deepEqual(await readBootCommit(wt), { sha: await head(wt) });
    assert.match((await readBootCommit(dir)).unknown, /no boot record/);
  } finally {
    await git(dir, 'worktree', 'remove', '--force', wt);
  }
});

test('a tracked change only under web/ still records HEAD: the backend matches it', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'web', 'app.tsx'), 'v2\n');
  const rec = await recordBootCommit({ repoRoot: dir, log: quiet().log });
  assert.equal(rec.sha, await head(dir));
});

test('an untracked file outside web/ still records HEAD: it is not something the server runs from', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'notes.txt'), 'scratch\n');
  assert.equal((await recordBootCommit({ repoRoot: dir, log: quiet().log })).sha, await head(dir));
});

test('a tracked change outside web/ records sha:null with a reason naming it, and reads as unknown', async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), 'v2\n');
  const rec = await recordBootCommit({ repoRoot: dir, log: quiet().log });
  assert.equal(rec.sha, null);
  assert.match(rec.reason, /src\/server\.ts/);
  const read = await readBootCommit(dir);
  assert.equal('sha' in read, false);
  assert.match(read.unknown, /src\/server\.ts/);
});

test('an unborn HEAD records sha:null with a reason', async () => {
  const dir = await repo({ commit: false });
  const rec = await recordBootCommit({ repoRoot: dir, log: quiet().log });
  assert.equal(rec.sha, null);
  assert.match(rec.reason, /unborn/);
  assert.match((await readBootCommit(dir)).unknown, /unborn/);
});

test('outside a git checkout: writes nothing, says so, and does not throw', async () => {
  const dir = await fs.realpath(await mkdtemp('cc-bootcommit-nogit-'));
  const { lines, log } = quiet();
  assert.equal(await recordBootCommit({ repoRoot: dir, log }), null);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.match(lines.join('\n'), /not a git checkout/);
  assert.match((await readBootCommit(dir)).unknown, /not a git checkout/);
});

test('readBootCommit: a missing, unparseable, dead-pid or null-sha record each reads as unknown, naming its case', async (t) => {
  const dir = await repo();
  const file = path.resolve(dir, await recordFile(dir));
  const sha = await head(dir);
  await t.test('missing', async () => {
    await fs.rm(file, { force: true });
    assert.match((await readBootCommit(dir)).unknown, /no boot record/);
  });
  await t.test('unparseable', async () => {
    writeFileSync(file, '{not json');
    assert.match((await readBootCommit(dir)).unknown, /unparseable/);
  });
  await t.test('a pid that is no longer running', async () => {
    // A pid far above any default pid_max is never a live process.
    writeFileSync(file, JSON.stringify({ sha, pid: 2 ** 30, bootedAt: new Date().toISOString() }));
    assert.match((await readBootCommit(dir)).unknown, /no longer running/);
  });
  await t.test('sha null', async () => {
    writeFileSync(file, JSON.stringify({ sha: null, reason: 'because', pid: process.pid, bootedAt: new Date().toISOString() }));
    assert.match((await readBootCommit(dir)).unknown, /because/);
  });
  await t.test('control: a live pid with a sha reads as that commit', async () => {
    writeFileSync(file, JSON.stringify({ sha, pid: process.pid, bootedAt: new Date().toISOString() }));
    assert.deepEqual(await readBootCommit(dir), { sha });
  });
});
