// NODE_COMPILE_CACHE resolution and its size bound (card 2026-0344).
//
// The cache itself is Node's; what is testable — and what a wrong edit would
// break silently — is the three-way decision about WHERE it points and WHEN a
// directory is deleted. The dangerous direction is deletion: an always-wipe
// mutant costs every run a cold compile, and a wipe of a directory the operator
// chose destroys something that was not ours to destroy.
//
// Pure over an injected env object and tmpdirs. tests/run.mjs is a top-level-await
// script that cannot be imported without running the suite, which is why the
// resolution lives in tests/compileCache.mjs and not inline there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enableCompileCache, COMPILE_CACHE_DIR_NAME, COMPILE_CACHE_MAX_BYTES } from './compileCache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cache-'));
const fill = (dir, bytes) => {
  fs.mkdirSync(path.join(dir, 'v24-x64-abc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'v24-x64-abc', 'entry'), Buffer.alloc(bytes, 1));
};

test('CC_TEST_COMPILE_CACHE=0 is the opt-out: NODE_COMPILE_CACHE is never set', () => {
  const env = { CC_TEST_COMPILE_CACHE: '0' };
  const res = enableCompileCache({ repoRoot, env });
  assert.equal(res.enabled, false);
  assert.equal(res.dir, null);
  assert.equal('NODE_COMPILE_CACHE' in env, false, 'the variable must not even appear');
});

test('a pre-set NODE_COMPILE_CACHE wins verbatim, and is never walked or wiped', () => {
  // NEVER DELETE A DIRECTORY WE DID NOT CHOOSE. The operator's value is honoured
  // whatever its size — here it is 40x over a cap that would empty our own dir.
  const dir = tmp();
  fill(dir, 40_000);
  const env = { NODE_COMPILE_CACHE: dir };
  const res = enableCompileCache({ repoRoot, env, max: 1000 });
  assert.equal(res.enabled, true);
  assert.equal(res.dir, dir);
  assert.equal(env.NODE_COMPILE_CACHE, dir, 'the operator\'s value is not rewritten');
  assert.equal(res.reset, false);
  assert.equal(res.bytes, 0, 'a directory we did not choose is not even measured');
  assert.equal(fs.existsSync(path.join(dir, 'v24-x64-abc', 'entry')), true, 'still there');
});

test('the default dir is wiped over the cap and kept under it', () => {
  // Both directions, because an always-wipe mutant and a never-wipe mutant are
  // each survivable against one of them alone.
  const over = tmp();
  fill(path.join(over, COMPILE_CACHE_DIR_NAME), 5000);
  // A sibling INSIDE repoRoot but OUTSIDE the cache dir, planted before the wipe
  // fires. Asserted below — see the note there for why it is what makes this case
  // about the wipe's TARGET and not merely its occurrence.
  const bystander = path.join(over, 'not-the-cache');
  fs.writeFileSync(bystander, 'do not delete me');
  const envOver = {};
  const resOver = enableCompileCache({ repoRoot: over, env: envOver, max: 1000 });
  assert.equal(resOver.reset, true);
  assert.ok(resOver.bytes >= 5000, `measured ${resOver.bytes}`);
  assert.equal(envOver.NODE_COMPILE_CACHE, path.join(over, COMPILE_CACHE_DIR_NAME));

  const under = tmp();
  const underDir = path.join(under, COMPILE_CACHE_DIR_NAME);
  fill(underDir, 500);
  const envUnder = {};
  const resUnder = enableCompileCache({ repoRoot: under, env: envUnder, max: 1_000_000 });
  assert.equal(resUnder.reset, false);
  assert.equal(fs.existsSync(path.join(underDir, 'v24-x64-abc', 'entry')), true,
    'a healthy cache is not thrown away');

  // The over-cap case must have emptied OUR dir, not the repo root around it.
  const overDir = path.join(over, COMPILE_CACHE_DIR_NAME);
  assert.equal(fs.existsSync(overDir), false, 'the cache dir is removed; Node recreates it lazily');
  // THE TARGET, not just the occurrence. `reset === true` and "the cache dir is
  // gone" are BOTH still true when the wipe takes the whole of repoRoot with it, so
  // every assertion above survives an `rmSync(repoRoot)`. In production repoRoot is
  // the checkout, so that mutation deletes the repository while reporting a
  // successful cache reset. The bystander is the only thing here that tells the two
  // apart. (The neighbouring test pins the same directory for the MEASUREMENT; this
  // pins it for the DELETION, and no wipe fires there.)
  assert.equal(fs.existsSync(bystander), true,
    'the wipe removed the cache dir, not the repoRoot around it');
});

test('a cache sitting exactly ON the cap is kept', () => {
  // THE BOUNDARY, pinned separately because both directions above clear it by a
  // wide margin: the rule is `bytes > max`, and a `>` that drifted to `>=` passes
  // every other case in this file while throwing away a healthy cache that has
  // settled on the cap — on every single run, silently.
  const root = tmp();
  const dir = path.join(root, COMPILE_CACHE_DIR_NAME);
  fill(dir, 4096);
  const res = enableCompileCache({ repoRoot: root, env: {}, max: 4096 });
  assert.equal(res.bytes, 4096, 'sanity: the fixture is exactly the cap');
  assert.equal(res.reset, false, 'equal is not over');
  assert.equal(fs.existsSync(path.join(dir, 'v24-x64-abc', 'entry')), true);
});

test('the over-cap wipe measures the cache dir, not the repo root around it', () => {
  // The bound walks <repoRoot>/.compile-cache. A mutant that walked repoRoot
  // instead would fire on any repo bigger than the cap and wipe a healthy cache
  // on every single run.
  const root = tmp();
  fs.writeFileSync(path.join(root, 'big-source-file'), Buffer.alloc(50_000, 1));
  const dir = path.join(root, COMPILE_CACHE_DIR_NAME);
  fill(dir, 100);
  const res = enableCompileCache({ repoRoot: root, env: {}, max: 10_000 });
  assert.equal(res.reset, false, 'only the cache dir counts toward the cap');
  assert.equal(fs.existsSync(path.join(root, 'big-source-file')), true);
});

test('the default cache dir is git-ignored', () => {
  // The only real pin on "this does not land in git" — asserting the .gitignore
  // text would be a tautology. The PROBE PATH, not the bare directory: a
  // directory-only pattern reports "not ignored" while the directory does not
  // exist yet (harness/mutation/README.md records the same subtlety).
  const probe = path.join(repoRoot, COMPILE_CACHE_DIR_NAME, 'probe');
  try {
    execFileSync('git', ['check-ignore', '-q', probe], { cwd: repoRoot, stdio: 'ignore' });
  } catch (e) {
    if (e.code === 'ENOENT') { console.log('SKIP: git is not available on this host'); return; }
    assert.fail(`git check-ignore says ${probe} is NOT ignored`);
  }
});

test('the cap is a positive byte count', () => {
  // It is a measured anchor (see the module), so this pins only that it is a
  // usable one — a zero or negative cap would wipe the cache on every run.
  assert.ok(Number.isInteger(COMPILE_CACHE_MAX_BYTES) && COMPILE_CACHE_MAX_BYTES > 0);
});
