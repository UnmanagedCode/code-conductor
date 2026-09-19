// CANDIDATE DIRECTORIES FOR ADOPTION — the scan behind `GET
// /api/projects/suggestions` and the Adopt dialog's list.
//
// Registration is user-initiated: nothing on disk is authoritative and a human
// confirms every adoption. So this module never answers "is this a project?" —
// it answers "which directories under the projects root are NOT registered",
// ranks the likely ones first, and leaves the decision to the person reading
// the list. `adoptProject` re-checks everything before writing anything.
//
// ITS CORRECTNESS CONDITION IS AGREEMENT WITH `adoptProject`: a candidate the
// backend would refuse is a broken suggestion. Each rule below is therefore
// derived from one of that function's refusals, and
// `tests/project-suggestions.test.mjs` adopts every candidate a fixture root
// yields to keep the two from drifting apart.
//
// A SEPARATE MODULE from `src/projects.ts` deliberately: filesystem discovery
// of unregistered directories is a second responsibility, and the dependency
// runs one way — this imports the registry, never the reverse.
//
// WHY `node:fs` AND NOT A `System` HANDLE. The System seam is for
// PROJECT-SCOPED I/O (docs/architecture.md → Conventions). A suggestion is not
// a project and has no handle to take, and the question this scan asks is
// about CC'S OWN MACHINE by construction: the dialog never names a system, and
// a remote adopt's probes already run on the named system inside
// `adoptProject`. Same standing as `listProjects`, which readdirs the store
// with `node:fs`.
//
// WHY THERE IS NO `node_modules` / `vendor` / `target` SKIP-LIST, and why one
// must not be added: a hardcoded name list is inference about directory
// CONTENTS, which is exactly what the registration model refuses. The
// stop-descend-at-a-repo rule below disarms the hazard almost entirely — a
// tree with `node_modules` in it is nearly always inside a repo, and the walk
// stops at that repo's toplevel. What leaks past is bounded by the two caps
// and ranks below every `.git`-bearing hit. A drifting name list costs more
// than a few low-ranked junk rows.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOCAL_SYSTEM_ID } from './systems/localSystem.ts';
import { listProjects, projectsRoot } from './projects.ts';

// Levels below the projects root. Three gives container → sub-container →
// project: one level of headroom past the model's normal container → project.
export const SUGGEST_MAX_DEPTH = 3;

// Directories READ before the walk stops. Depth alone does not bound the work
// — an unregistered, non-git directory holding `node_modules/` is not a
// dotdir and would be descended — so breadth is capped too, and `truncated`
// reports it rather than letting a partial list pass for the whole answer.
export const SUGGEST_MAX_DIRS = 2000;

export interface AdoptCandidate {
  // Absolute, and canonical: the walk starts at the root's realpath and never
  // follows a symlink, so every path it composes is already resolved.
  path: string;
  relPath: string;
  // 1 for a direct child of the root.
  depth: number;
  // A `.git` entry exists at `path` — true for a repo's directory and for a
  // worktree's `.git` FILE alike. No `git` is ever run.
  isGitRepo: boolean;
  // Omitted when the basename sanitises to nothing; the dialog then leaves its
  // Name field blank.
  suggestedName?: string;
}

export interface AdoptSuggestions {
  // The realpath of the projects root, or its unresolved value when it does
  // not exist.
  root: string;
  // The cap actually applied, so a caller need not assume the constant.
  maxDepth: number;
  // The visited cap tripped: the list is a PREFIX, not the whole answer.
  truncated: boolean;
  // Directories the walk could not read (EACCES, a raced deletion). Counted
  // rather than thrown: an unreadable directory in a user's root is routine.
  unreadable: number;
  candidates: AdoptCandidate[];
}

const errCode = (e: unknown): string | undefined =>
  (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined);

// The charset `NAME_RE` admits in src/projects.ts.
const ILLEGAL_IN_NAME = /[^a-zA-Z0-9._-]/g;

// A directory basename turned into a project name the server will accept, or
// `null` when nothing usable is left. Derived HERE rather than in the dialog
// because both rules it encodes belong to `src/projects.ts` — `NAME_RE`'s
// charset, and `registerProject`'s refusal of a dot-leading name — and
// suggesting a name the server would refuse is a worse affordance than
// suggesting none.
//
// Two directories may legitimately sanitise to the same name (`work/api` and
// `personal/api`). They are NOT disambiguated: both are registrable under
// distinct names, and the collision surfaces as `PROJECT_EXISTS` for the user
// to resolve by picking one.
export function suggestedNameFor(basename: string): string | null {
  const sanitised = basename.replace(ILLEGAL_IN_NAME, '-').replace(/^\.+/, '');
  return sanitised === '' ? null : sanitised;
}

interface Pending { dir: string; depth: number }

export async function suggestAdoptableDirs(
  { maxDepth = SUGGEST_MAX_DEPTH, maxDirs = SUGGEST_MAX_DIRS }: {
    maxDepth?: number; maxDirs?: number;
  } = {},
): Promise<AdoptSuggestions> {
  // Both options exist ONLY as a test seam (so the cap test need not create
  // 2000 directories). The route calls this with neither; they are not
  // user-facing config and are not plumbed to the wire.
  const declared = projectsRoot();
  let root: string;
  try { root = await fs.realpath(declared); }
  catch (e) {
    // A root that is not there yet is an EMPTY answer, not an error — cc is
    // usable before its root exists. Anything else is a real fault and is the
    // route's to report.
    if (errCode(e) !== 'ENOENT') throw e;
    return { root: declared, maxDepth, truncated: false, unreadable: 0, candidates: [] };
  }

  const skip = await registeredLocalPaths();
  const candidates: AdoptCandidate[] = [];
  const queue: Pending[] = [{ dir: root, depth: 0 }];
  let visited = 0;
  let truncated = false;
  let unreadable = 0;

  while (queue.length > 0) {
    // Checked before the read, and only when something is actually left to
    // read, so `truncated` means "there was more" rather than "the cap was
    // reached exactly as the walk finished".
    if (visited >= maxDirs) { truncated = true; break; }
    const { dir, depth } = queue.shift()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { unreadable++; continue; }
    visited++;
    for (const entry of entries) {
      // `isDirectory()` is lstat-based, so a symlink is false here and is
      // neither offered nor followed. That keeps the walk inside the root and
      // free of cycles, and costs nothing: the dialog's free-text field still
      // adopts a symlinked tree, and `adoptProject` realpaths it.
      if (!entry.isDirectory()) continue;
      // The DOT RULE. This alone covers everything `TARGET_IS_CC_STATE`
      // refuses — `orchStoreRoot()`, `localWorktreesRoot()` and
      // `pluginsRoot()` are all dot-prefixed children of the projects root —
      // plus `.conduct` and every `.git`. A second exclusion list naming them
      // would be a second source for a fact this answers.
      if (entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      // A registered project is not a candidate, AND is not descended into:
      // every directory inside one is refused `TARGET_INSIDE_REPO` (or is a
      // nested duplicate of a tree the user already has).
      if (skip.has(child)) continue;
      const childDepth = depth + 1;
      const isGitRepo = await hasGitEntry(child);
      const name = suggestedNameFor(entry.name);
      candidates.push({
        path: child,
        relPath: path.relative(root, child),
        depth: childDepth,
        isGitRepo,
        ...(name === null ? {} : { suggestedName: name }),
      });
      // STOP AT A REPO TOPLEVEL. `adoptProject` refuses any directory whose
      // `git rev-parse --show-toplevel` answers something other than itself,
      // so every descendant of a repo is unadoptable and descending would
      // produce only rows the backend rejects.
      if (isGitRepo) continue;
      if (childDepth < maxDepth) queue.push({ dir: child, depth: childDepth });
    }
  }

  // Total and deterministic: the likely answers first, then a stable order the
  // dialog and its tests can both rely on.
  candidates.sort((a, b) =>
    (Number(b.isGitRepo) - Number(a.isGitRepo)) || a.relPath.localeCompare(b.relPath));

  return { root, maxDepth, truncated, unreadable, candidates };
}

// One `stat`, not a `git` run: a `.git` entry answers both the ranking and the
// stop-descend rule, and it is true for a repo's `.git` DIRECTORY and a
// worktree's `.git` FILE alike.
async function hasGitEntry(dir: string): Promise<boolean> {
  try { await fs.stat(path.join(dir, '.git')); return true; }
  catch { return false; }
}

// The already-registered skip set, as CANONICAL paths.
//
// LOCAL PLACEMENTS ONLY. A remote record's `path` is a path on another
// machine, so a local directory spelling the same string is a different tree
// and must still be offered. A DEGRADED row carries `path: ''` and contributes
// nothing — it names no directory, so it can suppress none.
//
// Each entry is realpath'd because the walk compares against realpaths:
// `createProject` stores `path.join(projectsRoot(), name)` unresolved, so a
// root reached through a symlink would otherwise never match its own
// projects.
async function registeredLocalPaths(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of await listProjects({ includeConduct: true })) {
    if (p.system !== LOCAL_SYSTEM_ID || p.path === '') continue;
    try { out.add(await fs.realpath(p.path)); }
    catch { out.add(p.path); }
  }
  return out;
}
