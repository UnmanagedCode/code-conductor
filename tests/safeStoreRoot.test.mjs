import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSafeRoot, ensureSafeStoreEnv, assertSafeTestRunRoot, removeSafeRoot } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    // Don't add to the stale-/tmp-root pile this suite already leaks (card
    // 2026-0227) — this test mints its own root, so it removes its own root.
    await removeSafeRoot(outer.root);
  }
});
