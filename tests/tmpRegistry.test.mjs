// Pins the deeper safety gates in tmpRegistry.mjs / safeStoreRoot.mjs that are
// unreachable through the normal mkdtemp()-only entry point — the registry is
// seeded directly via _forTesting to prove each check actually refuses (and
// survives) a malformed entry, not just that the happy path is unused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cleanupAll, _forTesting } from './tmpRegistry.mjs';
import { _forTesting as storeRootTesting, ensureSafeStoreEnv } from './safeStoreRoot.mjs';

const REAL_TMP = realpathSync(os.tmpdir());

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

// F2: assertVerified() must actually gate cleanupAll — not just be dead code
// that happens to always be true by the time cleanup runs.
test('cleanupAll refuses to delete anything when the safe-root invariant is not established, then resumes once it is', async () => {
  const dir = await mkdtemp('cc-f2-guard-');
  storeRootTesting.resetVerified();
  try {
    await assert.rejects(() => cleanupAll(), /safe test-run root was never established/);
    assert.equal(await exists(dir), true, 'refused cleanup must leave the registered dir untouched');
  } finally {
    ensureSafeStoreEnv(); // re-establish verified=true for the rest of this file/process
  }
  // Now that the invariant holds again, the SAME still-registered dir is removed.
  await cleanupAll();
  assert.equal(await exists(dir), false, 'cleanupAll must resume deleting once verified again');
});

// F3: validateForDeletion's direct-child / shape / symlink checks, each
// isolated so only ONE check fails per case, driven through cleanupAll so we
// also prove a bad entry never blocks cleanup of a good one alongside it.
test('validateForDeletion refuses a symlink, a non-direct-child, and a wrong-shape entry — each survives — while a good entry alongside them is still removed', async () => {
  const symlinkTarget = await mkdtemp('cc-f3-symlink-target-');
  const symlinkPath = path.join(REAL_TMP, 'cc-f3-link-AbC123');
  await fsp.symlink(symlinkTarget, symlinkPath, 'dir');

  // NOT via mkdtemp(): the outer dir must stay unregistered, or cleanupAll's
  // own legitimate (recursive) removal of it would wipe the nested entry
  // out from under this test before the nested entry's own turn comes up.
  const nestOuter = await fsp.mkdtemp(path.join(REAL_TMP, 'cc-f3-nest-outer-'));
  const nestedPath = path.join(nestOuter, 'cc-f3-nested-AbCdEf');
  await fsp.mkdir(nestedPath);

  const shapePath = path.join(REAL_TMP, 'cc-f3-shape-TOOLONGSUFFIX');
  await fsp.mkdir(shapePath);

  const goodDir = await mkdtemp('cc-f3-good-');

  _forTesting.registry.set(symlinkPath, 'cc-f3-link-');
  _forTesting.registry.set(nestedPath, 'cc-f3-nested-');
  _forTesting.registry.set(shapePath, 'cc-f3-shape-');

  try {
    await assert.rejects(() => cleanupAll(), (err) => {
      assert.ok(err instanceof AggregateError, `expected an AggregateError, got ${err}`);
      assert.equal(err.errors.length, 3);
      assert.ok(err.errors.some((e) => /is a symlink/.test(e.message)));
      assert.ok(err.errors.some((e) => /not a direct child/.test(e.message)));
      assert.ok(err.errors.some((e) => /doesn't match the mkdtemp shape/.test(e.message)));
      return true;
    });

    assert.equal(await exists(symlinkPath), true, 'the symlink entry must survive');
    assert.equal(await exists(nestedPath), true, 'the non-direct-child entry must survive');
    assert.equal(await exists(shapePath), true, 'the wrong-shape entry must survive');
    assert.equal(await exists(goodDir), false, 'a good entry alongside bad ones must still be removed');
  } finally {
    // These were seeded straight into the registry, bypassing mkdtemp(), so
    // cleanupAll's own bookkeeping already dropped them from the map — this
    // test owns cleaning up the malformed artifacts it created directly.
    await fsp.rm(symlinkPath, { force: true });
    await fsp.rm(symlinkTarget, { recursive: true, force: true });
    await fsp.rm(nestOuter, { recursive: true, force: true });
    await fsp.rm(shapePath, { recursive: true, force: true });
  }
});

// F3 (direct): validateForDeletion itself, not just through cleanupAll's
// aggregation, so the exact refusal reason for each malformed shape is pinned
// independently of how cleanupAll happens to report it.
test('validateForDeletion throws a specific, distinguishable reason per malformed entry', async () => {
  const symlinkTarget = await mkdtemp('cc-f3b-symlink-target-');
  const symlinkPath = path.join(REAL_TMP, 'cc-f3b-link-Zz9Yy8');
  await fsp.symlink(symlinkTarget, symlinkPath, 'dir');

  const nestOuter = await fsp.mkdtemp(path.join(REAL_TMP, 'cc-f3b-nest-outer-')); // unregistered — see note above
  const nestedPath = path.join(nestOuter, 'cc-f3b-nested-Zz9Yy8');
  await fsp.mkdir(nestedPath);

  const shapePath = path.join(REAL_TMP, 'cc-f3b-shape-TOOLONGSUFFIX');
  await fsp.mkdir(shapePath);

  try {
    assert.throws(
      () => _forTesting.validateForDeletion(symlinkPath, 'cc-f3b-link-'),
      /is a symlink/,
    );
    assert.throws(
      () => _forTesting.validateForDeletion(nestedPath, 'cc-f3b-nested-'),
      /not a direct child/,
    );
    assert.throws(
      () => _forTesting.validateForDeletion(shapePath, 'cc-f3b-shape-'),
      /doesn't match the mkdtemp shape/,
    );
  } finally {
    await fsp.rm(symlinkPath, { force: true });
    await fsp.rm(symlinkTarget, { recursive: true, force: true });
    await fsp.rm(nestOuter, { recursive: true, force: true });
    await fsp.rm(shapePath, { recursive: true, force: true });
  }
});
