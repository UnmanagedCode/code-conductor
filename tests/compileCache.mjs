// Where NODE_COMPILE_CACHE points for a suite run, and when that directory is
// thrown away (card 2026-0344).
//
// WHY IT IS ON BY DEFAULT. Every test file runs in its own process and pays V8
// compile plus TypeScript type-stripping of the same `helpers.mjs -> server.ts ->
// src/*.ts` graph. Measured on this box, importing tests/helpers.mjs in a bare
// child: ~220ms uncached, ~120ms cached, in ~360 children per suite run.
//
// TWO PER-CHILD FIGURES ARE IN CIRCULATION AND THEY MEASURE DIFFERENT THINGS — do
// not read one as a target for the other. ~770ms of a child's ~1s startup is the
// WHOLE-CHILD cost (spawn, the module graph, type-stripping, node:test bootstrap),
// charged under load; the ~220/~120ms pair above is a BARE-IMPORT PROBE of just
// the graph, on an idle box, with spawn excluded. So ~100ms saved per child is the
// probe's answer and is not a shortfall against 770 — the cache can only ever
// attack the compile component the probe isolates. The figure that settles whether
// it was worth doing is neither, and it is the whole-gate pair below.
//
// (A THIRD ~770ms in this suite is unrelated: `C`, the per-file child-lifecycle
// cost at 72-way starvation, in tests/summary-attribution.test.mjs and
// docs/architecture.md's ratio-vs-difference worked example. Same number, different
// quantity, different conditions.)
//
// SHARED ACROSS RUNS, AND PER WORKTREE. Both halves are load-bearing:
//   * shared, because that is the entire win — one run warms the next run, the
//     gate's second row, and every mutation iteration. A per-run directory pays
//     the cold compile every time and is worth roughly nothing to the mutation
//     harness, whose iterations are narrow `npm test -- <file>` invocations;
//   * per worktree (repo root, not os.tmpdir()), because sibling worktrees on this
//     box run concurrent mutation campaigns. A shared tmpdir location would let
//     one checkout's size-bound wipe delete entries out from under another's live
//     run. The precedent for a persistent gitignored repo-root scratch dir is
//     `.mutation/` — NOT tmpRegistry's fixtures, which are per-test and must be
//     isolated; this one is deliberately the opposite.
//
// NODE'S CACHE IS PATH-KEYED AND OVERWRITES. Measured on node v24.18.0: a scratch
// `.mjs` and a scratch `.ts` cached into a fresh dir, then edited and re-imported
// three times, left the entry count unchanged at 5. So an in-place mutation
// campaign that edits one source per mutant REPLACES that path's entry rather than
// adding one — 500 mutants add 0 entries, not 500 — and the rest of the import
// graph, which is where the 770ms lives, stays warm. (The bound below does not
// depend on that answer; it is why the bound is unconditional.)
//
// A NODE UPGRADE does not need a wipe either: entries live under a
// `<version>-<arch>-<hash>-<uid>` subdirectory, so a new version simply starts a
// new one — and the bound counts the total, so the stale one is eventually
// collected.

import fs from 'node:fs';
import path from 'node:path';

export const COMPILE_CACHE_DIR_NAME = '.compile-cache';

// A MEASURED ANCHOR, ~4x one full warm gate. Measured on this box: 9.48 MB /
// 2627 entries after three consecutive whole `gate:systems` runs, still creeping
// (7.81 -> 8.64 -> 9.48 MB) as run-to-run variation reaches modules the earlier
// runs never loaded — repeating the SAME files twice adds nothing, which is the
// path-keyed overwrite above. A cap that fires on a healthy run would be a
// self-inflicted cold cache, so re-anchor this if the suite's module set grows.
//
// AND THE WIPE IS CHEAP, which is why the cap can be this tight: a cold gate and
// a warm one measured 142.6s and 142.3s: the first children populate the cache and
// the other ~350 read it, so a whole run warms itself in its first seconds. The
// cache's win is against having NO cache at all — 166.9s / 973.6s CPU with
// CC_TEST_COMPILE_CACHE=0 against 143.4s / 717.3s with it on, back to back.
export const COMPILE_CACHE_MAX_BYTES = 40 * 1024 * 1024;

// Total size of `dir`, or 0 when it does not exist. One walk of a few thousand
// small files at run start (~10-20ms), paid once per run and never per child.
function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0; // not there yet — the ordinary first-run case
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } catch { /* vanished */ }
  }
  return total;
}

// Point `env.NODE_COMPILE_CACHE` at this worktree's cache, bounding it first.
// Mutates the env object only, so it must be called BEFORE any child forks — the
// children inherit it and there is no per-child wiring to keep in step.
//
// Three rules, in order:
//   1. CC_TEST_COMPILE_CACHE=0 is the opt-out and leaves the variable untouched;
//   2. an already-set NODE_COMPILE_CACHE wins verbatim and its directory is NEVER
//      walked or removed — we do not delete a directory we did not choose. (The
//      mutation harness inherits the reviewer's shell env, so an exported value
//      must reach the children unchanged.);
//   3. otherwise it becomes <repoRoot>/.compile-cache, wiped first if over `max`.
//
// THE WIPE RACE IS BENIGN AND IS NOT WORTH A LOCK. Two concurrent gate rows both
// bound-check at start; if both wipe, a concurrent writer loses entries. This is a
// pure cache — a lost entry costs one recompile, never correctness — and Node's
// own writes are atomic and non-fatal on failure.
export function enableCompileCache({ repoRoot, env = process.env, max = COMPILE_CACHE_MAX_BYTES } = {}) {
  if (env.CC_TEST_COMPILE_CACHE === '0') return { enabled: false, dir: null, reset: false, bytes: 0 };
  if (env.NODE_COMPILE_CACHE) return { enabled: true, dir: env.NODE_COMPILE_CACHE, reset: false, bytes: 0 };

  const dir = path.join(repoRoot, COMPILE_CACHE_DIR_NAME);
  const bytes = dirBytes(dir);
  let reset = false;
  if (bytes > max) {
    fs.rmSync(dir, { recursive: true, force: true }); // Node recreates it lazily
    reset = true;
  }
  env.NODE_COMPILE_CACHE = dir;
  return { enabled: true, dir, reset, bytes };
}
