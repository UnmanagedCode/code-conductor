import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSafeStoreEnv, assertSafeTestRunRoot } from './safeStoreRoot.mjs';
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
