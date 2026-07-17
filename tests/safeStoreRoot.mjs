// Test-suite store isolation. The orchestrator's sidecar stores resolve their
// on-disk root from `PROJECTS_ROOT` (src/projects.js), falling back to a
// SOURCE-RELATIVE default (`src/../..`) when it is unset — which, run from this
// checkout, is the parent of the repo: the REAL production `.code-conductor`.
// A test that touches a store with `PROJECTS_ROOT` unset therefore corrupts the
// live archived-sessions store. This module is the backstop: `run.mjs` pins the
// whole run to a throwaway temp root, `helpers.mjs` restores to it, and
// `assertStoreIsolated` fails loudly if any resolved store path would still land
// in the real workspace.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root (this file lives at <repo>/tests/), and the real production
// projects root one level above it. `REAL_STORE_DIR` is exactly what
// orchStoreRoot() yields when PROJECTS_ROOT is unset (src/projects.js resolves
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

// Make a fresh throwaway root under os.tmpdir() and the projects/claude sub-roots
// under it. Sync so it's ready before any test-file child forks.
export function createSafeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cc-testrun-'));
  return {
    root,
    projectsRoot: path.join(root, 'project'),
    claudeProjectsRoot: path.join(root, '.claude', 'projects'),
  };
}

// Guarantee a safe store root is in effect and return its paths. If
// PROJECTS_ROOT is already set (the common case: inherited from run.mjs), reuse
// it; otherwise mint a fresh throwaway root and point the env at it. Idempotent
// enough to call once per child process at module load.
export function ensureSafeStoreEnv() {
  if (process.env.PROJECTS_ROOT) {
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
