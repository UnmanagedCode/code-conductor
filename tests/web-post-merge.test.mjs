// src/webPostMerge.ts: cc's own post-merge step. A web-only change since the
// running server booted is swapped into web/dist at once; anything else the UI
// build reads, or a boot commit that cannot be vouched for, stages the build
// in web/dist.next for the next start; nothing relevant is a no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { decideWebPostMerge, runWebPostMerge } from '../src/webPostMerge.ts';
import { recordBootCommit } from '../src/bootCommit.ts';
import { refreshWebDist, stageWebBuild, webInputs, webSourceHash } from '../src/webBuild.ts';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'webPostMergeMain.ts');

// ── The decision table ─────────────────────────────────────────────────────

const BOOT = { sha: 'a'.repeat(40) };
const decide = (o) => decideWebPostMerge({
  isMainCheckout: true, boot: BOOT, bootIsAncestor: true, changedSinceBoot: [], changedThisMerge: [], ...o,
}).action;

test('decision: a known boot commit that is an ancestor decides on everything changed since boot', () => {
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'web/index.html'] }), 'swap', 'web-only since boot');
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'src/routes.ts'] }), 'stage', 'web + src');
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'shared/http.ts'] }), 'stage', 'web + shared');
  assert.equal(decide({ changedSinceBoot: ['shared/http.ts'] }), 'stage', 'shared alone is read by the UI build');
  assert.equal(decide({ changedSinceBoot: ['package.json'] }), 'stage', 'package.json is read by the UI build');
  assert.equal(decide({ changedSinceBoot: ['src/routes.ts', 'docs/x.md'] }), 'noop', 'nothing the UI build reads');
  assert.equal(decide({ changedSinceBoot: [] }), 'noop');
  // The range since boot, not this merge's, is what decides.
  assert.equal(decide({ changedSinceBoot: ['web/a.tsx', 'src/b.ts'], changedThisMerge: ['web/a.tsx'] }), 'stage',
    'an earlier merge since boot already changed src/');
  assert.equal(decide({ changedSinceBoot: ['web/a.tsx'], changedThisMerge: ['src/b.ts'] }), 'swap');
});

test('decision: a boot commit that cannot be vouched for stages when this merge is relevant, else no-ops', () => {
  for (const [why, o] of [
    ['unknown boot', { boot: { unknown: 'the server that wrote the boot record (pid 1) is no longer running' } }],
    ['not an ancestor', { bootIsAncestor: false, changedSinceBoot: null }],
    ['changes since boot unlisted', { changedSinceBoot: null }],
  ]) {
    assert.equal(decide({ ...o, changedThisMerge: ['web/a.tsx'] }), 'stage', why);
    assert.equal(decide({ ...o, changedThisMerge: ['src/a.ts'] }), 'noop', why);
  }
  const r = decideWebPostMerge({
    isMainCheckout: true, boot: { unknown: 'no boot record at x' }, bootIsAncestor: false, changedSinceBoot: null, changedThisMerge: ['web/a.tsx'],
  });
  assert.match(r.reason, /no boot record at x/, 'the reason names why the boot commit is unknown');
});

test('decision: a target that is not the main checkout is a no-op, whatever changed', () => {
  assert.equal(decide({ isMainCheckout: false, changedSinceBoot: ['web/a.tsx'], changedThisMerge: ['web/a.tsx'] }), 'noop');
});

// ── Against a fixture checkout ─────────────────────────────────────────────

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout.trim());
    });
  });
}

async function fixture() {
  const root = await fs.realpath(await mkdtemp('cc-webpostmerge-'));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, '.gitignore'), 'web/dist*\n');
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  for (const f of ['web/app.tsx', 'shared/http.ts', 'src/server.ts']) {
    await fs.mkdir(path.join(root, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(root, f), 'v1\n');
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

// Commit edits, returning [pre, post].
async function land(root, files) {
  const pre = await git(root, 'rev-parse', 'HEAD');
  for (const f of files) {
    await fs.mkdir(path.join(root, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(root, f), `${f} at ${Date.now()}-${Math.random()}\n`);
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', `edit ${files.join(' ')}`);
  return [pre, await git(root, 'rev-parse', 'HEAD')];
}

const quiet = () => ({ log: () => {}, error: () => {} });
const builder = (label) => {
  const calls = [];
  const build = async (outDir) => {
    calls.push(outDir);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'index.html'), `<p>${label}</p>`);
  };
  return Object.assign(build, { calls });
};
const throwing = async () => { throw new Error('must not build'); };
const stampOf = (dir) => { try { return readFileSync(path.join(dir, '.source-hash'), 'utf8').trim(); } catch { return null; } };
const stamped = (dir, label, hash) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), `<p>${label}</p>`);
  writeFileSync(path.join(dir, '.source-hash'), `${hash}\n`);
};

async function bootedAt(root) {
  const rec = await recordBootCommit({ repoRoot: root, log: { log: () => {}, warn: () => {} } });
  assert.equal(rec.sha, await git(root, 'rev-parse', 'HEAD'), 'premise: the boot commit is recorded');
}

test('swap: a web-only change since boot builds web/dist, stamped with the current sources, and leaves no dist.next', async () => {
  const root = await fixture();
  await bootedAt(root);
  const [pre, post] = await land(root, ['web/app.tsx']);
  const build = builder('swapped');
  const dist = path.join(root, 'web', 'dist');
  const r = await runWebPostMerge({ root, pre, post, build, log: quiet() });
  assert.equal(r.action, 'swap', r.reason);
  assert.equal(r.outcome, 'built');
  assert.equal(stampOf(dist), webSourceHash(webInputs(root)));
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /swapped/);
  assert.equal(existsSync(`${dist}.next`), false);
  // Nothing left to do for the next refresh, stage or boot.
  assert.equal(await refreshWebDist({ distDir: dist, inputs: webInputs(root), build: throwing, log: quiet() }), 'up-to-date');
  assert.deepEqual(await stageWebBuild({ distDir: dist, inputs: webInputs(root), build: throwing, log: quiet() }), { staged: false });
});

test('swap removes a stale dist.next and never adopts it', async () => {
  const root = await fixture();
  await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  stamped(`${dist}.next`, 'stale stage', 'an-old-hash');
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('fresh'), log: quiet() });
  assert.equal(r.outcome, 'built');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /fresh/);
  assert.equal(existsSync(`${dist}.next`), false);
});

test('swap adopts a stage of the current sources without building', async () => {
  const root = await fixture();
  await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  const [pre, post] = await land(root, ['web/app.tsx']);
  stamped(`${dist}.next`, 'staged', webSourceHash(webInputs(root)));
  const r = await runWebPostMerge({ root, pre, post, build: throwing, log: quiet() });
  assert.equal(r.outcome, 'adopted-staged');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /staged/);
  assert.equal(existsSync(`${dist}.next`), false);
});

test('stage: a change since boot outside web/ builds web/dist.next and leaves web/dist untouched; the next start adopts it', async () => {
  const root = await fixture();
  await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  stamped(dist, 'serving', 'boot-hash');
  const [pre, post] = await land(root, ['web/app.tsx', 'src/server.ts']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.equal(r.outcome, 'staged');
  assert.equal(stampOf(`${dist}.next`), webSourceHash(webInputs(root)));
  assert.equal(stampOf(dist), 'boot-hash');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /serving/);
  assert.equal(await refreshWebDist({ distDir: dist, inputs: webInputs(root), build: throwing, log: quiet() }), 'adopted-staged');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /next/);
});

test('stage: a shared/ change since boot stages even though this merge touched only web/', async () => {
  const root = await fixture();
  await bootedAt(root);
  await land(root, ['shared/http.ts']);
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
});

test('noop: nothing the UI build reads changed — the builder is never called', async () => {
  const root = await fixture();
  await bootedAt(root);
  const [pre, post] = await land(root, ['src/server.ts']);
  const build = builder('x');
  const r = await runWebPostMerge({ root, pre, post, build, log: quiet() });
  assert.equal(r.action, 'noop', r.reason);
  assert.deepEqual(build.calls, []);
  assert.equal(existsSync(path.join(root, 'web', 'dist')), false);
  assert.equal(existsSync(path.join(root, 'web', 'dist.next')), false);
});

test('no boot record: a web change stages rather than swapping', async () => {
  const root = await fixture();
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /no boot record/);
});

test('a boot record left by a server that is gone: a web change stages', async () => {
  const root = await fixture();
  const sha = await git(root, 'rev-parse', 'HEAD');
  const file = path.resolve(root, await git(root, 'rev-parse', '--git-path', 'cc-boot-commit'));
  writeFileSync(file, JSON.stringify({ sha, pid: 2 ** 30, bootedAt: new Date().toISOString() }));
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /no longer running/);
});

test('a boot commit that is not an ancestor of the merge: a web change stages', async () => {
  const root = await fixture();
  await git(root, 'checkout', '-q', '-b', 'elsewhere');
  await land(root, ['src/server.ts']);
  await bootedAt(root);
  await git(root, 'checkout', '-q', 'main');
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /not an ancestor/);
});

test('a linked worktree target is a no-op', async () => {
  const root = await fixture();
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  await git(root, 'worktree', 'add', '-q', wt, '-b', 'side');
  try {
    await bootedAt(wt);
    const [pre, post] = await land(wt, ['web/app.tsx']);
    const build = builder('x');
    const r = await runWebPostMerge({ root: wt, pre, post, build, log: quiet() });
    assert.equal(r.action, 'noop', r.reason);
    assert.deepEqual(build.calls, []);
  } finally {
    await git(root, 'worktree', 'remove', '--force', wt);
  }
});

// ── The entry the hook script execs ────────────────────────────────────────

const runEntry = (cwd, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

test('the entry decides for the checkout at its cwd, prints one line naming the action, and exits 0', async () => {
  const root = await fixture();
  await bootedAt(root);
  const [pre, post] = await land(root, ['src/server.ts']);
  const boot = (await git(root, 'rev-parse', `${pre}`)).slice(0, 12);
  const r = await runEntry(root, pre, post);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `[post-worktree-merge] web: noop — nothing the UI build reads changed since the server booted (boot commit: ${boot})\n`);
});

test('the entry exits non-zero when it cannot read the merge, so the hook reports the failure', async () => {
  const root = await fixture();
  const r = await runEntry(root, 'not-a-sha', 'HEAD');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not-a-sha/);
});
