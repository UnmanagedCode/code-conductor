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
import { bootCommitFromEnv, decideWebPostMerge, runWebPostMerge } from '../src/webPostMerge.ts';
import { refreshWebDist, stageWebBuild, webInputs, webSourceHash } from '../src/webBuild.ts';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'webPostMergeMain.ts');

// ── The decision table ─────────────────────────────────────────────────────

const BOOT = { sha: 'a'.repeat(40) };
const decide = (o) => decideWebPostMerge({
  inputs: webInputs('/checkout'), isMainCheckout: true, boot: BOOT, bootIsAncestor: true, changedSinceBoot: [], changedThisMerge: [], ...o,
}).action;

test('decision: a known boot commit that is an ancestor decides on everything changed since boot', () => {
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'web/index.html'] }), 'swap', 'web-only since boot');
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'src/routes.ts'] }), 'stage', 'web + src');
  assert.equal(decide({ changedSinceBoot: ['web/src/App.tsx', 'shared/http.ts'] }), 'stage', 'web + shared');
  assert.equal(decide({ changedSinceBoot: ['shared/http.ts'] }), 'stage', 'shared alone is read by the UI build');
  assert.equal(decide({ changedSinceBoot: ['package.json'] }), 'stage', 'package.json is read by the UI build');
  assert.equal(decide({ changedSinceBoot: ['tsconfig.json'] }), 'stage', 'the root tsconfig.json is read by the UI build');
  assert.equal(decide({ changedSinceBoot: ['src/routes.ts', 'docs/x.md'] }), 'noop', 'nothing the UI build reads');
  assert.equal(decide({ changedSinceBoot: ['src/a.ts', 'web/e2e/a.spec.ts', 'web/dist/x.js'] }), 'noop',
    'paths under web/ the build does not read (the hash skips them) are not relevant either');
  assert.equal(decide({ changedSinceBoot: [] }), 'noop');
  // The range since boot, not this merge's, is what decides.
  assert.equal(decide({ changedSinceBoot: ['web/a.tsx', 'src/b.ts'], changedThisMerge: ['web/a.tsx'] }), 'stage',
    'an earlier merge since boot already changed src/');
  assert.equal(decide({ changedSinceBoot: ['web/a.tsx'], changedThisMerge: ['src/b.ts'] }), 'swap');
});

test('decision: a boot commit that cannot be vouched for stages when this merge is relevant, else no-ops', () => {
  for (const [why, o] of [
    ['unknown boot', { boot: { unknown: 'HEAD is unborn or unreadable' } }],
    ['not an ancestor', { bootIsAncestor: false, changedSinceBoot: null }],
    ['changes since boot unlisted', { changedSinceBoot: null }],
  ]) {
    assert.equal(decide({ ...o, changedThisMerge: ['web/a.tsx'] }), 'stage', why);
    assert.equal(decide({ ...o, changedThisMerge: ['src/a.ts'] }), 'noop', why);
  }
  const r = decideWebPostMerge({
    inputs: webInputs('/checkout'), isMainCheckout: true, boot: { unknown: 'its own web build is running' }, bootIsAncestor: false, changedSinceBoot: null, changedThisMerge: ['web/a.tsx'],
  });
  assert.match(r.reason, /its own web build is running/, 'the reason names why the boot commit is unknown');
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

// The server's boot commit as it hands it over: HEAD of `root` now.
const bootedAt = async (root) => ({ sha: await git(root, 'rev-parse', 'HEAD') });

test('swap: a web-only change since boot builds web/dist, stamped with the current sources, and leaves no dist.next', async () => {
  const root = await fixture();
  const boot = await bootedAt(root);
  const [pre, post] = await land(root, ['web/app.tsx']);
  const build = builder('swapped');
  const dist = path.join(root, 'web', 'dist');
  const r = await runWebPostMerge({ root, pre, post, boot, build, log: quiet() });
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
  const boot = await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  stamped(`${dist}.next`, 'stale stage', 'an-old-hash');
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, boot, build: builder('fresh'), log: quiet() });
  assert.equal(r.outcome, 'built');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /fresh/);
  assert.equal(existsSync(`${dist}.next`), false);
});

test('swap adopts a stage of the current sources without building', async () => {
  const root = await fixture();
  const boot = await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  const [pre, post] = await land(root, ['web/app.tsx']);
  stamped(`${dist}.next`, 'staged', webSourceHash(webInputs(root)));
  const r = await runWebPostMerge({ root, pre, post, boot, build: throwing, log: quiet() });
  assert.equal(r.outcome, 'adopted-staged');
  assert.match(readFileSync(path.join(dist, 'index.html'), 'utf8'), /staged/);
  assert.equal(existsSync(`${dist}.next`), false);
});

test('stage: a change since boot outside web/ builds web/dist.next and leaves web/dist untouched; the next start adopts it', async () => {
  const root = await fixture();
  const boot = await bootedAt(root);
  const dist = path.join(root, 'web', 'dist');
  stamped(dist, 'serving', 'boot-hash');
  const [pre, post] = await land(root, ['web/app.tsx', 'src/server.ts']);
  const r = await runWebPostMerge({ root, pre, post, boot, build: builder('next'), log: quiet() });
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
  const boot = await bootedAt(root);
  await land(root, ['shared/http.ts']);
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, boot, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
});

test('noop: nothing the UI build reads changed — the builder is never called', async () => {
  const root = await fixture();
  const boot = await bootedAt(root);
  const [pre, post] = await land(root, ['src/server.ts']);
  const build = builder('x');
  const r = await runWebPostMerge({ root, pre, post, boot, build, log: quiet() });
  assert.equal(r.action, 'noop', r.reason);
  assert.deepEqual(build.calls, []);
  assert.equal(existsSync(path.join(root, 'web', 'dist')), false);
  assert.equal(existsSync(path.join(root, 'web', 'dist.next')), false);
});

test('no CC_SERVER_BOOT_SHA (a target that is not the serving server\'s checkout): a web change stages, and says why', async () => {
  const root = await fixture();
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, boot: bootCommitFromEnv({}), build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /CC_SERVER_BOOT_SHA is unset/);
});

test('bootCommitFromEnv: the sha when the server passed one, else unknown with the server\'s reason, else unset', () => {
  assert.deepEqual(bootCommitFromEnv({ CC_SERVER_BOOT_SHA: 'a'.repeat(40) }), { sha: 'a'.repeat(40) });
  assert.deepEqual(bootCommitFromEnv({ CC_SERVER_BOOT_UNKNOWN: 'the server\'s own web build is running' }),
    { unknown: 'the server\'s own web build is running' });
  assert.match(bootCommitFromEnv({}).unknown, /CC_SERVER_BOOT_SHA is unset/);
  assert.match(bootCommitFromEnv({ CC_SERVER_BOOT_SHA: '' }).unknown, /CC_SERVER_BOOT_SHA is unset/);
});

// Rename detection would list only the destination of a move.
async function move(root, from, to) {
  const pre = await git(root, 'rev-parse', 'HEAD');
  await fs.mkdir(path.join(root, path.dirname(to)), { recursive: true });
  await git(root, 'mv', from, to);
  await git(root, 'commit', '-q', '-m', `move ${from} ${to}`);
  return [pre, await git(root, 'rev-parse', 'HEAD')];
}

test('a move from src/ into web/ since boot stages: the src/ side of the rename counts', async () => {
  const root = await fixture();
  const boot = await bootedAt(root);
  const [pre, post] = await move(root, 'src/server.ts', 'web/server.ts');
  const r = await runWebPostMerge({ root, pre, post, boot, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /src\/server\.ts/);
});

test('with no boot commit, a move out of web/ in this merge stages: the web/ side of the rename counts', async () => {
  const root = await fixture();
  const [pre, post] = await move(root, 'web/app.tsx', 'docs/app.tsx');
  const r = await runWebPostMerge({ root, pre, post, boot: bootCommitFromEnv({}), build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
});

test('a boot commit that is not an ancestor of the merge: a web change stages', async () => {
  const root = await fixture();
  await git(root, 'checkout', '-q', '-b', 'elsewhere');
  await land(root, ['src/server.ts']);
  const boot = await bootedAt(root);
  await git(root, 'checkout', '-q', 'main');
  const [pre, post] = await land(root, ['web/app.tsx']);
  const r = await runWebPostMerge({ root, pre, post, boot, build: builder('next'), log: quiet() });
  assert.equal(r.action, 'stage', r.reason);
  assert.match(r.reason, /not an ancestor/);
});

test('a linked worktree target is a no-op', async () => {
  const root = await fixture();
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  await git(root, 'worktree', 'add', '-q', wt, '-b', 'side');
  try {
    const boot = await bootedAt(wt);
    const [pre, post] = await land(wt, ['web/app.tsx']);
    const build = builder('x');
    const r = await runWebPostMerge({ root: wt, pre, post, boot, build, log: quiet() });
    assert.equal(r.action, 'noop', r.reason);
    assert.deepEqual(build.calls, []);
  } finally {
    await git(root, 'worktree', 'remove', '--force', wt);
  }
});

// ── The entry the hook script execs ────────────────────────────────────────

const runEntry = (cwd, env, ...args) => new Promise((resolve) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CC_SERVER_BOOT_')));
  execFile(process.execPath, [ENTRY, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

test('the entry reads the boot commit from CC_SERVER_BOOT_SHA, prints one line naming the action, and exits 0', async () => {
  const root = await fixture();
  const boot = await git(root, 'rev-parse', 'HEAD');
  const [pre, post] = await land(root, ['src/server.ts']);
  const r = await runEntry(root, { CC_SERVER_BOOT_SHA: boot }, pre, post);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `[post-worktree-merge] web: noop — nothing the UI build reads changed since the server booted (boot commit: ${boot.slice(0, 12)})\n`);
});

test('the entry with no boot commit in its env decides on this merge alone', async () => {
  const root = await fixture();
  const [pre, post] = await land(root, ['src/server.ts']);
  const r = await runEntry(root, { CC_SERVER_BOOT_UNKNOWN: 'the server\'s own web build is running' }, pre, post);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /web: noop — nothing the UI build reads changed in this merge \(the server's own web build is running\) \(boot commit: unknown\)/);
});

test('the entry exits non-zero when it cannot read the merge, so the hook reports the failure', async () => {
  const root = await fixture();
  const r = await runEntry(root, {}, 'not-a-sha', 'HEAD');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not-a-sha/);
});
