// Regression test for the harness store-isolation backstop.
//
// Bug: tests/run.mjs never set PROJECTS_ROOT, and bootServer's teardown restored
// it to UNSET — so any store access outside an open bootServer window fell
// through to src/projects.js's SOURCE-RELATIVE default, which is the REAL
// production `.code-conductor`. This asserts the two safety nets are live:
//   - under the suite, orchStoreRoot() never resolves into the real workspace
//   - assertStoreIsolated() TRIPS on the real store path (so a future leak
//     aborts the run instead of corrupting production)
//
// NB: the "unset PROJECTS_ROOT" case only ever *resolves* the path and asserts
// the guard throws — it never performs a store write while unset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { orchStoreRoot } from '../src/projects.js';
import { assertStoreIsolated, REAL_STORE_DIR } from './safeStoreRoot.mjs';

test('under the suite the store never resolves into the real workspace', () => {
  const store = path.resolve(orchStoreRoot());
  assert.notEqual(store, REAL_STORE_DIR);
  assert.ok(
    !store.startsWith(REAL_STORE_DIR + path.sep),
    `store ${store} must not be inside the real workspace ${REAL_STORE_DIR}`,
  );
  // The backstop must accept the current (safe) store and reject the real one.
  assert.doesNotThrow(() => assertStoreIsolated(store));
  assert.throws(() => assertStoreIsolated(REAL_STORE_DIR), /production|workspace/i);
});

test('unset PROJECTS_ROOT falls back to the real store and trips the guard', () => {
  const saved = process.env.PROJECTS_ROOT;
  try {
    delete process.env.PROJECTS_ROOT;
    // Resolve only — no store write. With PROJECTS_ROOT unset, orchStoreRoot()
    // returns the source-relative default, which IS the real production store.
    const unsafe = orchStoreRoot();
    assert.equal(path.resolve(unsafe), REAL_STORE_DIR);
    assert.throws(() => assertStoreIsolated(unsafe), /production|workspace/i);
  } finally {
    process.env.PROJECTS_ROOT = saved;
  }
});
