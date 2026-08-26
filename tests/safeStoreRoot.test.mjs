import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSafeRoot, ensureSafeStoreEnv, assertSafeTestRunRoot, removeSafeRoot,
  RUN_ROOT_SHAPE, _forTesting as storeRootTesting,
} from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('assertSafeTestRunRoot refuses a real, non-temp path', () => {
  assert.throws(
    () => assertSafeTestRunRoot(repoRoot),
    (err) => err.message.includes(repoRoot) && /cc-testrun-/.test(err.message),
  );
});

// F1: a direct child of the real tmpdir that is NOT shaped like cc-testrun-XXXXXX
// must still be refused. Without the RUN_ROOT_SHAPE check, any tool's own tmpdir
// scratch dir (unrelated to this suite) would be silently trusted as a run root.
test('assertSafeTestRunRoot refuses a direct child of tmpdir with the wrong shape (not cc-testrun-XXXXXX)', async () => {
  const wrongShapeDir = await mkdtemp('not-cc-testrun-');
  assert.throws(
    () => assertSafeTestRunRoot(path.join(wrongShapeDir, 'project')),
    (err) => err.message.includes(wrongShapeDir),
  );
});

test('ensureSafeStoreEnv refuses an inherited PROJECTS_ROOT outside the temp root, naming the offending path', () => {
  withEnv(
    {
      PROJECTS_ROOT: repoRoot,
      CLAUDE_PROJECTS_ROOT: path.join(repoRoot, '.claude', 'projects'),
    },
    () => {
      assert.throws(
        () => ensureSafeStoreEnv(),
        (err) => err.message.includes(repoRoot) && /cc-testrun-/.test(err.message),
        'ensureSafeStoreEnv must throw naming the untrusted PROJECTS_ROOT, not just throw for any reason',
      );
    },
  );
});

// --- the run marker for a STANDALONE file run --------------------------------
//
// A child of `node tests/foo.test.mjs` used to carry no CC_TEST_RUN_ID at all —
// the one mode in which a leaked process is invisible to both the hang guard's
// sweep and tests/reapOrphans.mjs, and the mode narrow-scope flake-rate
// measurements are taken in. Both directions matter and neither is the other's
// converse: minting one when absent is the fix, and NOT replacing an inherited
// one is what keeps a child inside its own run's sweep rather than a run nobody
// is tracking.

test('ensureSafeStoreEnv mints a run marker when the process has none', () => {
  withEnv({ PROJECTS_ROOT: undefined, CLAUDE_PROJECTS_ROOT: undefined, CC_TEST_RUN_ID: undefined }, () => {
    delete process.env.PROJECTS_ROOT;
    delete process.env.CLAUDE_PROJECTS_ROOT;
    delete process.env.CC_TEST_RUN_ID;
    const safe = ensureSafeStoreEnv();
    // It must be the basename of the root it actually minted, not merely
    // well-shaped: the marker is only useful if it identifies THIS run, and
    // tests/reapOrphans.mjs licences a kill on `the root named by the marker is
    // gone`, which a marker naming some other root would answer about.
    assert.equal(process.env.CC_TEST_RUN_ID, path.basename(safe.root));
    assert.match(process.env.CC_TEST_RUN_ID, /^cc-testrun-[A-Za-z0-9]{6}$/);
  });
});

test('ensureSafeStoreEnv never replaces an inherited run marker', () => {
  // The `??=`-not-`=` half. Under run.mjs the marker is already set before any
  // file forks; re-minting it here would drop this child and everything it
  // spawns out of its own run's sweep, silently re-opening the leak this card
  // closed for exactly the runs that go through the runner.
  withEnv({ PROJECTS_ROOT: undefined, CLAUDE_PROJECTS_ROOT: undefined, CC_TEST_RUN_ID: 'cc-testrun-Inhrtd' }, () => {
    delete process.env.PROJECTS_ROOT;
    delete process.env.CLAUDE_PROJECTS_ROOT;
    const safe = ensureSafeStoreEnv();
    assert.equal(process.env.CC_TEST_RUN_ID, 'cc-testrun-Inhrtd',
      'the inherited marker was overwritten — this child is no longer swept by its own run');
    assert.notEqual(process.env.CC_TEST_RUN_ID, path.basename(safe.root));
  });
});

test('ensureSafeStoreEnv marks an inherited PROJECTS_ROOT branch too', async () => {
  // The OTHER branch. A standalone file whose PROJECTS_ROOT already resolves
  // under a valid run root takes the early return, so marking only the
  // freshly-minted branch would leave that path blind. The root must come from
  // createSafeRoot() rather than tmpRegistry's mkdtemp: assertSafeTestRunRoot
  // requires a DIRECT child of the real tmpdir named exactly cc-testrun-XXXXXX,
  // and tmpRegistry roots are neither.
  const outer = createSafeRoot();
  try {
    withEnv({ PROJECTS_ROOT: outer.projectsRoot, CC_TEST_RUN_ID: undefined }, () => {
      delete process.env.CC_TEST_RUN_ID;
      const safe = ensureSafeStoreEnv();
      assert.equal(safe.root, outer.root, 'the inherited root must be reused, not re-minted');
      assert.equal(process.env.CC_TEST_RUN_ID, path.basename(outer.root));
    });
  } finally {
    // Deterministic in-test removal: this test mints its own root, so it removes
    // its own root rather than leaving it to the exit backstop below.
    await removeSafeRoot(outer.root);
  }
});

// --- root ownership: mint => own => remove at exit, inherit => never remove ----
//
// The observable effect of an exit handler only exists AFTER a process exits, so
// these spawn a child and then look at what it left behind.

const MODULE_URL = pathToFileURL(path.join(__dirname, 'safeStoreRoot.mjs')).href;

// `safeStoreRoot.mjs` imports only .mjs (node:fs/os/path/url + ./rmrf.mjs), so a
// bare `node --input-type=module -e` child needs no type-stripping loader.
function runChild({ env: overrides, exitCode = null }) {
  const env = { ...process.env, ...overrides };
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
  delete env.NODE_TEST_CONTEXT; // a child that inherits it misbehaves under node:test
  // CC_TEST_RUN_ID is deliberately INHERITED, never scrubbed: the mint branch keys
  // on PROJECTS_ROOT alone, so the child still mints, and keeping the parent's
  // marker leaves it inside this run's hang-guard sweep instead of orphaned under
  // a marker nobody tracks.
  const src =
    `import { ensureSafeStoreEnv } from ${JSON.stringify(MODULE_URL)};\n` +
    `const safe = ensureSafeStoreEnv();\n` +
    `process.stdout.write('ROOT=' + safe.root + '\\n');\n` +
    (exitCode === null ? '' : `process.exit(${exitCode});\n`);
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { env, encoding: 'utf8', timeout: 20_000 });
  const m = /^ROOT=(.+)$/m.exec(res.stdout ?? '');
  assert.ok(m, `child printed no ROOT line:\n${res.stdout}\n${res.stderr}`);
  return { root: m[1], status: res.status, stderr: res.stderr };
}

test('a minted run root is gone once the minting process exits', () => {
  const child = runChild({ env: { PROJECTS_ROOT: undefined, CLAUDE_PROJECTS_ROOT: undefined } });
  // Shape-check the child's root first: it proves the MINT branch ran, so a
  // vanished directory means "the owner removed it", not "nothing was created".
  assert.match(path.basename(child.root), RUN_ROOT_SHAPE);
  assert.equal(existsSync(child.root), false,
    `the minting process exited but left ${child.root} behind`);
});

test('an INHERITED run root is never removed by the process that inherited it', async () => {
  // The ownership rule. Registering in ensureSafeStoreEnv() across BOTH branches
  // would make every test file under run.mjs delete the whole run's store root at
  // its own exit, pulling it out from under its still-running siblings.
  const outer = createSafeRoot();
  try {
    const child = runChild({
      env: { PROJECTS_ROOT: outer.projectsRoot, CLAUDE_PROJECTS_ROOT: outer.claudeProjectsRoot },
    });
    assert.equal(child.root, outer.root, 'the child re-minted instead of inheriting — test is not measuring the inherited branch');
    assert.equal(existsSync(outer.root), true,
      'a process that only INHERITED this root removed it at exit');
  } finally {
    await removeSafeRoot(outer.root);
  }
});

test('the backstop removes a minted root on a non-zero process.exit()', () => {
  // The literal shape of run.mjs's signal path, which ends at
  // process.exit(128+signo) and so never reaches removeSafeRoot. Cleanup has to
  // be an 'exit' handler to cover it — 'beforeExit' does not fire here.
  const child = runChild({
    env: { PROJECTS_ROOT: undefined, CLAUDE_PROJECTS_ROOT: undefined },
    exitCode: 143,
  });
  assert.equal(child.status, 143);
  assert.match(path.basename(child.root), RUN_ROOT_SHAPE);
  assert.equal(existsSync(child.root), false,
    `a process that exited with 143 left ${child.root} behind`);
});

// --- the deletion gate --------------------------------------------------------
//
// Second gate on a path ALREADY drawn from the minted-roots registry: it never
// selects what to delete, it only vetoes an entry that doesn't look right.
//
// Disclosed gap: `mintedRoots.delete()` running only AFTER a successful rmrf is
// untested. Its purpose is the retry case (an rmrf failing EBUSY/EACCES leaves
// the entry registered for the exit backstop), and inducing a deterministic rmrf
// failure would require faking the filesystem. Dropping the ordering is benign —
// the backstop lstats, gets ENOENT and skips — so no test can distinguish it.

test('the deletion gate refuses a symlink pointing at a valid run root', async () => {
  // Discriminating by construction: the realpath'd TARGET passes
  // assertSafeTestRunRoot, so only the lstat gate can refuse this.
  const realRoot = createSafeRoot().root;
  try {
    const holder = await mkdtemp('cc-root-gate-');
    const link = path.join(holder, 'link');
    symlinkSync(realRoot, link);
    assert.throws(() => storeRootTesting.validateRootForDeletion(link), /is a symlink/);
  } finally {
    await removeSafeRoot(realRoot);
  }
});

test('the deletion gate refuses a temp dir that is not shaped like a run root', async () => {
  const wrongShape = await mkdtemp('not-cc-testrun-');
  assert.throws(() => storeRootTesting.validateRootForDeletion(wrongShape), /cc-testrun-/);
});

test('the deletion gate reports an already-removed root as ENOENT, not as an untrusted path', async () => {
  // Why lstat runs before assertSafeTestRunRoot. Once the directory is gone the
  // ancestor walk falls back to the tmpdir, so the shape gate would reject it as
  // "does not resolve under a cc-testrun-… directory" — an error with no `code`,
  // which the exit backstop would log as a failure on every root the normal path
  // had already cleaned up, instead of skipping it.
  const root = createSafeRoot().root;
  await removeSafeRoot(root);
  assert.throws(
    () => storeRootTesting.validateRootForDeletion(root),
    (err) => err.code === 'ENOENT',
    'an already-removed root must surface as ENOENT so the backstop skips it silently',
  );
});
