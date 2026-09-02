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
//
// Ownership rule for the roots themselves: a root is removed by the process that
// MINTED it, at that process's exit. A process that merely INHERITED a root (via
// ensureSafeStoreEnv's early return) never removes it — its siblings are still
// running against it.

import { mkdtempSync, realpathSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
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
// Exported so tests/reapOrphans.mjs licences a marker against THIS shape rather
// than re-declaring the regex — a second copy could widen while this one did not.
export const RUN_ROOT_SHAPE = /^cc-testrun-[A-Za-z0-9]{6}$/;

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

// Pin git's GLOBAL config at a run-scoped file, so the run neither reads the
// developer's ~/.gitconfig nor lets git start work nobody asked for.
//
// The load-bearing key is `maintenance.auto`. Without it, git spawns
// `git maintenance run --auto --quiet --detach` after ordinary write commands —
// measured 765 spawns per `npm test` on this host at fe610017. It is DETACHED, so
// it outlives the command that spawned it and repacks whenever it lands: inside a
// tree-snapshot window it shows up as a spurious diff and reds the run with no
// defect in the diff under test (card 2026-0290 §3).
//
// GIT_CONFIG_GLOBAL, not GIT_CONFIG_COUNT/KEY/VALUE: git CLEARS the GIT_CONFIG_*
// family for commands run against another repository (`local_repo_env`), so the
// env form leaks on the local transport. Measured over a full run: the env form
// took 765 spawns to 40, all of them `git-receive-pack`; this form takes it to 0.
//
// `gc.auto` is a SECOND key for the same outcome, not a refinement of the first.
// Measured on git 2.55 here, interleaved with no-change controls (3/3 controls
// spawned): each key ALONE takes the ordinary-commit spawn to 0. It is kept for
// git versions that reach the repack through `git gc --auto` rather than through
// `maintenance` — that portability claim is the part this host cannot check,
// having only git 2.55.
//
// Consequence for future tests: a test needing a global git setting must add it
// HERE. Nothing in the run reads the developer's global config any more.
const GIT_CONFIG_BODY = '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n';

// Idempotent: under run.mjs every child inherits an already-correct value and
// this writes nothing. Only a process that minted its own root (a standalone
// `node tests/foo.test.mjs`) actually creates the file.
export function pinGitConfig(root) {
  const file = path.join(root, 'gitconfig');
  if (process.env.GIT_CONFIG_GLOBAL === file) return file;
  writeFileSync(file, GIT_CONFIG_BODY);
  process.env.GIT_CONFIG_GLOBAL = file;
  return file;
}

// Roots THIS process minted via createSafeRoot(). Exact paths only — never a
// readdir/glob of /tmp, and never a root that was merely INHERITED:
// ensureSafeStoreEnv's early-return branch reuses a root the PARENT run owns, and
// removing that at a child's exit would pull the whole run's store out from under
// its siblings. Mint => own => remove; inherit => never remove.
const mintedRoots = new Set();

// Make a fresh throwaway root under os.tmpdir() and the projects/claude sub-roots
// under it. Sync so it's ready before any test-file child forks. Registering
// ownership HERE rather than in ensureSafeStoreEnv() is what makes the rule
// structural: the inherited branch never calls this, so an inherited root can
// never enter the set.
export function createSafeRoot() {
  const root = mkdtempSync(path.join(REAL_TMP, 'cc-testrun-'));
  assertSafeTestRunRoot(root); // guaranteed to pass by construction; keeps one verification path
  mintedRoots.add(root);
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
    markRun(root);
    pinGitConfig(root);
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
  markRun(safe.root);
  pinGitConfig(safe.root);
  return safe;
}

// Give this process a run marker if it does not already have one, so children of
// a STANDALONE `node tests/foo.test.mjs` are visible to the hang guard's sweep
// and to tests/reapOrphans.mjs. Without it, a single-file run is the one blind
// spot where a leaked child carries no identity at all and nothing can ever reap
// it — which is exactly the mode used for narrow-scope flake-rate measurements.
//
// `??=`, NEVER `=`: under run.mjs the value is already set, and re-minting it
// here would drop this child (and everything it spawns) out of its OWN run's
// sweep. That is also why this is not in createSafeRoot() —
// tests/tmpRegistry.test.mjs calls ensureSafeStoreEnv() mid-file, and a bare
// assignment there would clobber the child's inherited marker.
function markRun(root) {
  process.env.CC_TEST_RUN_ID ??= path.basename(root);
}

// Test-only: reset the verified flag so a test can exercise assertVerified()'s
// refusal path without faking an entire process. Never used by production code.
export const _forTesting = {
  resetVerified() { verified = false; },
  validateRootForDeletion,
};

// Sync validation of a root ALREADY drawn from mintedRoots — shared by
// removeSafeRoot() and the exit backstop, so the backstop can never delete
// anything the async path would not have. Re-validates independently of module
// state (never trusts a path on the strength of `verified` alone).
//
// lstat runs FIRST so an already-removed root surfaces as a clean ENOENT: left to
// assertSafeTestRunRoot it degrades into "does not resolve under a cc-testrun-…
// directory" (the ancestor walk falls back to the tmpdir once the dir is gone),
// which would make the backstop log a false alarm instead of skipping. The
// symlink check is the only gate that catches a symlink POINTING AT a valid run
// root — assertSafeTestRunRoot realpaths, so that shape passes it.
function validateRootForDeletion(root) {
  const lst = lstatSync(root); // throws ENOENT if already removed
  if (lst.isSymbolicLink()) {
    throw new Error(`refusing to remove ${root}: it is a symlink`);
  }
  assertSafeTestRunRoot(root);
  return root;
}

// Remove the per-run root minted by createSafeRoot(). Re-validates
// independently of any prior verification (never trusts a caller-passed path
// on the strength of module state alone). The registry entry is dropped only
// once removal is confirmed, so an rmrf that fails (EBUSY/EACCES under
// contention) leaves the root registered for the exit backstop to retry.
export async function removeSafeRoot(root) {
  validateRootForDeletion(root);
  await rmrf(root);
  mintedRoots.delete(root); // only now is it actually gone
}

// Crash/interrupt backstop. `removeSafeRoot` sits on run.mjs's NORMAL completion
// path only: the SIGINT/SIGTERM handler ends at process.exit(128+signo), the
// store-isolation guard exits 1 before any file forks, and a standalone file run
// never had a removal at all. Each of those runs 'exit' handlers, so one
// registration point covers all of them. Sync by necessity — no async work runs
// in an exit handler. Reuses the IDENTICAL validation gate as the async path, so
// it can never delete anything that path would not have. Best-effort: logs rather
// than throws, since an exit handler cannot usefully stop the process. SIGKILL
// stays uncoverable (no handler runs), which only ever leaks a throwaway /tmp
// dir; see tests/reapOrphans.mjs for why no directory reaper follows.
process.on('exit', () => {
  if (mintedRoots.size === 0) return;
  for (const root of mintedRoots) {
    try {
      rmSync(validateRootForDeletion(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      console.error(`safe-root cleanup backstop failed for ${root}: ${err.message}`);
    }
  }
});
