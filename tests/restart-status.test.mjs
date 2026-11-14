// restartStatusFor: whether the running server is behind its own checkout's
// HEAD, over a real git repo per test. B is the boot commit (from the real
// measureBootCommit), H* later HEADs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { measureBootCommit } from '../src/bootCommit.ts';
import { restartStatusFor } from '../src/restartStatus.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout.trim());
    });
  });
}

const FILES = {
  'server.ts': "import './src/a.ts';\n",
  'src/a.ts': "import '../shared/p.ts';\n",
  'shared/p.ts': 'export const p = 1;\n',
  'shared/q.ts': 'export const q = 1;\n',
  'web/w.tsx': 'export const w = 1;\n',
  'docs/d.md': 'd\n',
  'README.md': 'r\n',
  'tests/t.mjs': 't\n',
  'package.json': '{}\n',
};

async function write(root, files) {
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
}

// Commit `files` (path → text), returning the new HEAD.
async function commit(root, files, msg = 'c') {
  await write(root, files);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', msg);
  return git(root, 'rev-parse', 'HEAD');
}

// A committed repo; `prep` may add a further commit before the boot is measured.
async function fixture(prep) {
  const root = await mkdtemp('cc-restart-status-');
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await commit(root, FILES, 'initial');
  if (prep) await commit(root, prep, 'prep');
  const boot = await measureBootCommit(root);
  assert.ok('sha' in boot, 'fixture check: the boot commit is known');
  return { root, boot, B: boot.sha, status: restartStatusFor({ checkoutRoot: root, boot }) };
}

const cleanup = (root) => rmrf(root);

test('an unknown boot commit is unknown with its own reason, in both shapes', async () => {
  const f = await fixture();
  try {
    const H = await commit(f.root, { 'src/a.ts': 'changed\n' });
    assert.notEqual(H, f.B);
    for (const boot of [{ unknown: 'no sha here' }, { unknown: 'no sha here', head: f.B }]) {
      assert.deepEqual(await restartStatusFor({ checkoutRoot: f.root, boot })(), { state: 'unknown', reason: 'no sha here' });
    }
  } finally { await cleanup(f.root); }
});

test('HEAD at the boot commit is current', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.status(), { state: 'current', boot: f.B });
  } finally { await cleanup(f.root); }
});

const ROWS = [
  ['web/ only is live', null, { 'web/w.tsx': 'x\n' }, null],
  ['docs/, README.md and tests/ are live', null, { 'docs/d.md': 'x\n', 'README.md': 'x\n', 'tests/t.mjs': 'x\n' }, null],
  ['an unreached shared/ module is live', null, { 'shared/q.ts': 'x\n' }, null],
  ['a reached shared/ module needs a restart', null, { 'shared/p.ts': 'x\n' }, 'src/a.ts → shared/p.ts'],
  ['src/ needs a restart', null, { 'src/a.ts': "import '../shared/p.ts';\n// x\n" }, 'src/a.ts'],
  ['server.ts needs a restart', null, { 'server.ts': "import './src/a.ts';\n// x\n" }, 'server.ts'],
  ['package.json needs a restart', null, { 'package.json': '{"x":1}\n' }, 'package.json'],
  ['a web/ file the boot graph reaches needs a restart',
    { 'web/x.ts': 'export const x = 1;\n', 'src/a.ts': "import '../shared/p.ts';\nimport '../web/x.ts';\n" },
    { 'web/x.ts': 'x\n' }, 'src/a.ts → web/x.ts'],
];
for (const [name, prep, change, chain] of ROWS) {
  test(`what changed since boot decides needed or live: ${name}`, async () => {
    const f = await fixture(prep);
    try {
      const H = await commit(f.root, change);
      assert.notEqual(H, f.B, 'fixture check: HEAD moved');
      const got = await f.status();
      if (chain === null) {
        assert.deepEqual(got, { state: 'live', boot: f.B, head: H });
      } else {
        assert.equal(got.state, 'needed');
        assert.deepEqual({ ...got, reason: undefined }, { state: 'needed', boot: f.B, head: H, reason: undefined });
        assert.ok(got.reason.includes(chain), got.reason);
      }
    } finally { await cleanup(f.root); }
  });
}

// Invariant: a move out of server code into web/ is listed by its src/ side too (--no-renames), so it needs a restart; with rename detection only the web/ destination would be listed and the state would read live.
test('what changed since boot decides needed or live: a rename out of src/ into web/ still needs a restart', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'web'), { recursive: true });
    await fs.rename(path.join(f.root, 'src/a.ts'), path.join(f.root, 'web/a.ts'));
    await git(f.root, 'add', '-A');
    await git(f.root, 'commit', '-q', '-m', 'move src/a.ts to web/');
    const H = await git(f.root, 'rev-parse', 'HEAD');
    assert.notEqual(H, f.B, 'fixture check: HEAD moved');
    assert.match(await git(f.root, 'diff', '--name-status', f.B, H), /^R\d+\s+src\/a\.ts\s+web\/a\.ts$/m, 'fixture check: git sees a rename');
    const got = await f.status();
    assert.deepEqual({ ...got, reason: undefined }, { state: 'needed', boot: f.B, head: H, reason: undefined });
    assert.ok(got.reason.includes('src/a.ts'), got.reason);
  } finally { await cleanup(f.root); }
});

test('an unknown import walk needs a restart for a gated path but not for web/', async () => {
  const f = await fixture({ 'src/a.ts': "import '../shared/p.ts';\nconst x = require('y');\n" });
  try {
    const live = await commit(f.root, { 'web/w.tsx': 'x\n' });
    assert.deepEqual(await f.status(), { state: 'live', boot: f.B, head: live });
    const H = await commit(f.root, { 'shared/q.ts': 'x\n' });
    const got = await f.status();
    assert.equal(got.state, 'needed');
    assert.equal(got.head, H);
    assert.ok(got.reason.includes('require'), got.reason);
  } finally { await cleanup(f.root); }
});

test('the classification follows HEAD', async () => {
  const f = await fixture();
  try {
    const H1 = await commit(f.root, { 'src/a.ts': "import '../shared/p.ts';\n// 1\n" });
    const first = await f.status();
    assert.equal(first.state, 'needed');
    assert.equal(first.head, H1);
    const H2 = await commit(f.root, { 'src/a.ts': "import '../shared/p.ts';\n// 2\n" });
    const second = await f.status();
    assert.equal(second.state, 'needed');
    assert.equal(second.head, H2);
    await git(f.root, 'reset', '-q', '--hard', f.B);
    const H3 = await commit(f.root, { 'web/w.tsx': 'x\n' });
    assert.deepEqual(await f.status(), { state: 'live', boot: f.B, head: H3 });
    await git(f.root, 'reset', '-q', '--hard', f.B);
    assert.deepEqual(await f.status(), { state: 'current', boot: f.B });
  } finally { await cleanup(f.root); }
});

test('a HEAD behind the boot commit still needs a restart when server code differs', async () => {
  const f = await fixture();
  try {
    const C1 = f.B;
    await commit(f.root, { 'src/a.ts': "import '../shared/p.ts';\n// c2\n" });
    const boot = await measureBootCommit(f.root);
    assert.ok('sha' in boot && boot.sha !== C1, 'fixture check: boot at C2');
    const status = restartStatusFor({ checkoutRoot: f.root, boot });
    await git(f.root, 'reset', '-q', '--hard', C1);
    const got = await status();
    assert.equal(got.state, 'needed');
    assert.equal(got.boot, boot.sha);
    assert.equal(got.head, C1);
  } finally { await cleanup(f.root); }
});

test('changes since boot that cannot be listed need a restart', async () => {
  const f = await fixture();
  try {
    await git(f.root, 'checkout', '-q', '--orphan', 'other');
    const H = await commit(f.root, { 'web/w.tsx': 'orphan\n' }, 'orphan');
    await git(f.root, 'branch', '-q', '-D', 'main');
    await git(f.root, 'reflog', 'expire', '--expire=now', '--all');
    await git(f.root, 'gc', '-q', '--prune=now');
    await assert.rejects(git(f.root, 'cat-file', '-e', f.B), 'fixture check: the boot commit is gone');
    const got = await f.status();
    assert.equal(got.state, 'needed');
    assert.equal(got.boot, f.B);
    assert.equal(got.head, H);
    assert.match(got.reason, /could not be listed/);
  } finally { await cleanup(f.root); }
});

test('an unreadable HEAD is unknown', async () => {
  const f = await fixture();
  try {
    await rmrf(path.join(f.root, '.git'));
    assert.equal((await f.status()).state, 'unknown');
  } finally { await cleanup(f.root); }
});
