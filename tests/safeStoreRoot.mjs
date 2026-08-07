// Test-suite store isolation. The orchestrator's sidecar stores resolve their
// on-disk root from `PROJECTS_ROOT` (src/projects.ts), falling back to a
// SOURCE-RELATIVE default (`src/../..`) when it is unset — which, run from this
// checkout, is the parent of the repo: the REAL production `.code-conductor`.
// A test that touches a store with `PROJECTS_ROOT` unset therefore corrupts the
// live archived-sessions store. This module is the backstop: `run.mjs` pins the
// whole run to a throwaway temp root, `helpers.mjs` restores to it, and
// `assertStoreIsolated` fails loudly if any resolved store path would still land
// in the real workspace.
//
// The code-conductor orchestrator sets PROJECTS_ROOT/CLAUDE_PROJECTS_ROOT in the
// environment of every worker it spawns — pointing at the REAL workspace. A test
// file run standalone (not through run.mjs) inherits that env. `ensureSafeStoreEnv`
// must never trust an inherited PROJECTS_ROOT just because it's set:
// `assertSafeTestRunRoot` below is the one gate that stands between "reuse the
// inherited value" and running (and, worse, cleaning up) against a real project
// tree. A value that fails this check aborts the whole run — it is never
// "fixed up" by silently minting a new root over the top.

import { mkdtempSync, realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from './rmrf.mjs';

// The repo root (this file lives at <repo>/tests/), and the real production
// projects root one level above it. `REAL_STORE_DIR` is exactly what
// orchStoreRoot() yields when PROJECTS_ROOT is unset (src/projects.ts resolves
// its default to `src/../..`, the same `<repo>/..` dir).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REAL_PROJECTS_ROOT = path.resolve(repoRoot, '..');
export const REAL_STORE_DIR = path.join(REAL_PROJECTS_ROOT, '.code-conductor');

// Throw if `storeRoot` (an orchStoreRoot() value) would resolve into the real
// production store. Pure — never writes. Message names "production"/"workspace"
// so callers/tests can match on it.
export function assertStoreIsolated(storeRoot) {
  const resolved = path.resolve(storeRoot);
  if (resolved === REAL_STORE_DIR || resolved.startsWith(REAL_STORE_DIR + path.sep)) {
    throw new Error(
      `test isolation breach: archived-sessions store would resolve to the REAL ` +
      `production workspace store at ${resolved} — refusing to run (set PROJECTS_ROOT).`,
    );
  }
}

const REAL_TMP = realpathSync(os.tmpdir());
const RUN_ROOT_SHAPE = /^cc-testrun-[A-Za-z0-9]{6}$/;

// Realpath the nearest EXISTING ancestor of `p` (p itself may not exist yet —
// e.g. PROJECTS_ROOT points at a "project" subdir nothing has mkdir'd yet).
// Every ancestor above an existing, real directory is itself real, so this is
// enough to fully resolve symlinks in the portion of the path that matters.
function realpathNearestExistingAncestor(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { return realpathSync(cur); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err; // reached filesystem root, still missing
      cur = parent;
    }
  }
}

// Walk up from `candidatePath` until a directory is found that is a DIRECT
// child of the real tmpdir (path.dirname(resolved) === REAL_TMP, not a
// startsWith prefix test). Returns null if the walk reaches the filesystem
// root first — i.e. candidatePath isn't under a direct-child-of-tmpdir
// directory at all.
function locateRunRoot(candidatePath) {
  let cur = realpathNearestExistingAncestor(candidatePath);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === REAL_TMP) return cur;
    if (parent === cur) return null; // reached filesystem root
    cur = parent;
  }
}

let verified = false;

// Throw loudly (naming the offending path) unless `candidatePath` resolves
// under a `cc-testrun-XXXXXX` directory that is itself a direct child of the
// real tmpdir. On success, marks the safe-root invariant as established for
// this process (see assertVerified).
export function assertSafeTestRunRoot(candidatePath) {
  const runRoot = locateRunRoot(candidatePath);
  if (!runRoot || !RUN_ROOT_SHAPE.test(path.basename(runRoot))) {
    throw new Error(
      `refusing to trust PROJECTS_ROOT="${candidatePath}" as a test run root — it does not ` +
      `resolve under a cc-testrun-XXXXXX directory that is a direct child of the real tmpdir ` +
      `(${REAL_TMP}). This looks like a real, non-throwaway path; aborting before any test runs.`,
    );
  }
  assertStoreIsolated(candidatePath);
  verified = true;
  return runRoot;
}

// Gate for any destructive cleanup: refuse to run if the safe-root invariant
// was never established in this process (no assertSafeTestRunRoot success).
export function assertVerified() {
  if (!verified) {
    throw new Error('safe test-run root was never established — refusing to clean up anything');
  }
}

// Make a fresh throwaway root under os.tmpdir() and the projects/claude sub-roots
// under it. Sync so it's ready before any test-file child forks.
export function createSafeRoot() {
  const root = mkdtempSync(path.join(REAL_TMP, 'cc-testrun-'));
  assertSafeTestRunRoot(root); // guaranteed to pass by construction; keeps one verification path
  return {
    root,
    projectsRoot: path.join(root, 'project'),
    claudeProjectsRoot: path.join(root, '.claude', 'projects'),
  };
}

// Guarantee a safe store root is in effect and return its paths. If
// PROJECTS_ROOT is already set (the common case: inherited from run.mjs, or —
// the dangerous case — inherited from the orchestrator's own worker env), it is
// verified via assertSafeTestRunRoot before being trusted; a bad inherited
// value throws rather than falling back to a freshly minted root. Otherwise
// mint a fresh throwaway root and point the env at it. Idempotent enough to
// call once per child process at module load.
export function ensureSafeStoreEnv() {
  if (process.env.PROJECTS_ROOT) {
    assertSafeTestRunRoot(process.env.PROJECTS_ROOT);
    const root = path.dirname(process.env.PROJECTS_ROOT);
    return {
      root,
      projectsRoot: process.env.PROJECTS_ROOT,
      claudeProjectsRoot:
        process.env.CLAUDE_PROJECTS_ROOT ?? path.join(root, '.claude', 'projects'),
    };
  }
  const safe = createSafeRoot();
  process.env.PROJECTS_ROOT = safe.projectsRoot;
  process.env.CLAUDE_PROJECTS_ROOT = safe.claudeProjectsRoot;
  return safe;
}

// Test-only: reset the verified flag so a test can exercise assertVerified()'s
// refusal path without faking an entire process. Never used by production code.
export const _forTesting = {
  resetVerified() { verified = false; },
};

// Remove the per-run root minted by createSafeRoot(). Re-validates
// independently of any prior verification (never trusts a caller-passed path
// on the strength of module state alone).
export async function removeSafeRoot(root) {
  assertSafeTestRunRoot(root);
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`refusing to remove ${root}: it is a symlink`);
  }
  await rmrf(root);
}
