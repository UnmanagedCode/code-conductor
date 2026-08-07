// Forget-proof temp-dir cleanup. Any test file that imports { mkdtemp } from
// here gets automatic teardown of every directory it mints, with no per-file
// afterEach to remember.
//
// Deletion is EXACT-PATH-ONLY: the registry below records only paths this
// process itself got back from its own fs.mkdtemp() calls. cleanupAll() only
// ever iterates that in-memory map — never readdir()/glob()/find() against
// /tmp, and there is no "reap orphans from a previous run" feature, not even
// opt-in. Test files run in separate child processes and the mutation harness
// runs suites concurrently; a prefix scan against /tmp could delete a sibling
// run's live fixture dir mid-test. Exact-paths-only makes that structurally
// impossible — this process's registry never contains another process's
// directories.
//
// The `^<prefix>[A-Za-z0-9]{6}$` shape check in validateForDeletion is a
// second gate applied to a path ALREADY in the registry — it never selects
// what to delete, only vetoes a registry entry that doesn't look right before
// removal proceeds.

import { promises as fsp, realpathSync, lstatSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { rmrf } from './rmrf.mjs';
import { assertStoreIsolated, ensureSafeStoreEnv, assertVerified } from './safeStoreRoot.mjs';

// Establishes (or re-verifies) the safe test-run root for THIS process before
// this module hands out a single mkdtemp — see safeStoreRoot.mjs for why an
// inherited PROJECTS_ROOT can't be trusted blindly. ESM top-level evaluation
// runs before node:test starts executing any test in the importing file, so
// this throws before a single test runs on a bad root.
ensureSafeStoreEnv();

const REAL_TMP = realpathSync(os.tmpdir());
const registry = new Map(); // resolved path -> exact prefix string passed to fs.mkdtemp

// The only way to mint a tracked temp dir. Takes a prefix, never a path —
// there is no "delete this path" entry point taking caller-supplied input.
export async function mkdtemp(prefix) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('mkdtemp: non-empty prefix string required');
  }
  const dir = await fsp.mkdtemp(path.join(REAL_TMP, prefix));
  registry.set(path.resolve(dir), prefix);
  return dir;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pure, fully synchronous validation of a path ALREADY drawn from the
// registry. Throws on any failed check rather than skipping it.
function validateForDeletion(recordedPath, prefix) {
  const lst = lstatSync(recordedPath); // throws ENOENT if already removed
  if (lst.isSymbolicLink()) {
    throw new Error(`tmp cleanup refused: ${recordedPath} is a symlink`);
  }
  const real = realpathSync(recordedPath);
  if (path.dirname(real) !== REAL_TMP) {
    throw new Error(`tmp cleanup refused: ${real} is not a direct child of ${REAL_TMP}`);
  }
  const shape = new RegExp(`^${escapeRegExp(prefix)}[A-Za-z0-9]{6}$`);
  if (!shape.test(path.basename(real))) {
    throw new Error(`tmp cleanup refused: ${real} doesn't match the mkdtemp shape for prefix "${prefix}"`);
  }
  assertStoreIsolated(real);
  return real;
}

// An entry is dropped from the registry ONLY once its removal is confirmed
// (already gone, or rmrf succeeded) — never upfront. A validation refusal or
// an rmrf failure (EBUSY/EACCES/EMFILE under contention; this codebase does
// fire-and-forget writes that can make a dir transiently busy) leaves the
// entry in the registry so the process-exit backstop below still has it to
// retry, instead of finding an already-emptied map with nothing left to do.
export async function cleanupAll() {
  assertVerified(); // refuse to run any deletion if the root invariant wasn't established
  const attempt = [...registry.entries()]; // snapshot of what to try this pass
  const refused = [];
  for (const [recordedPath, prefix] of attempt) {
    let safe;
    try {
      safe = validateForDeletion(recordedPath, prefix);
    } catch (err) {
      if (err.code === 'ENOENT') { registry.delete(recordedPath); continue; } // genuinely already gone
      // A validation failure on ONE entry must never block cleanup of the rest —
      // collect it and keep going, then throw loudly once every entry's been
      // tried. Left in the registry: it never resolved to a safe path to delete.
      refused.push(err);
      continue;
    }
    try {
      await rmrf(safe);
      registry.delete(recordedPath); // only now is it actually gone
    } catch (err) {
      // rmrf failed after its own retries — leave it registered for the backstop.
      refused.push(err);
    }
  }
  if (refused.length > 0) {
    throw new AggregateError(refused, `tmp cleanup refused ${refused.length} entr${refused.length === 1 ? 'y' : 'ies'}`);
  }
}

// Test-only: direct access to the registry and the validation gate, so a test
// can seed a deliberately-malformed entry and assert it's refused (and
// survives) without weakening the real mkdtemp()-only entry point. Never used
// by production code.
export const _forTesting = {
  registry,
  validateForDeletion,
};

after(async () => { await cleanupAll(); });

// Crash backstop: after() does not run on process.exit()/an uncaught
// exception, and even when after() DOES run, cleanupAll() only drops an
// entry once its removal is confirmed — so anything a rejected rmrf() left
// behind is still sitting in the registry for this handler to retry. Reuses
// the IDENTICAL synchronous validation gate above, so it can never delete
// anything the async path wouldn't also have deleted — a second chance at
// the same check, not a looser one. Best-effort: logs rather than throws,
// since an exit handler can't usefully stop the process. The one path this
// cannot cover is SIGKILL — no handler runs at all — which only leaks a
// throwaway /tmp dir, never anything outside it.
process.on('exit', () => {
  if (registry.size === 0) return;
  try { assertVerified(); } catch { return; }
  for (const [recordedPath, prefix] of registry) {
    try {
      const safe = validateForDeletion(recordedPath, prefix);
      rmSync(safe, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      console.error(`tmp cleanup backstop failed for ${recordedPath}: ${err.message}`);
    }
  }
});
