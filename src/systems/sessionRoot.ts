// Where a non-local system's local session roots will live, and the one
// property of that location cc has to be sure of before it promises a system
// can host sessions at all.
//
// A session root is cc-owned and LOCAL — the Claude CLI always runs on this
// machine, so a project on another system still needs a local directory to be
// the CLI's cwd. Keying it per (system, project, worktree) under cc's own store
// is what stops two systems that each host a project at `/app` from colliding
// on one local directory.
//
// WHAT LANDS IN ONE is not this module's business and is deliberately not built
// yet: nothing spawns a worker on a non-local system, so a composer here would
// have no caller. What IS needed now is the placement check, because
// registration is the only moment the user can act on a store that cannot host
// session roots.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from '../projects.ts';
import { httpError } from '../httpError.ts';

// `<store>/systems/<systemId>/sessions/` — the parent of every session root for
// one system. Exported so the assertion below and its test name one path rather
// than two spellings of it.
export function sessionRootsDir(systemId: string): string {
  return path.join(orchStoreRoot(), 'systems', systemId, 'sessions');
}

// THE PLACEMENT CHECK: no ancestor of the session roots may be a git repository.
//
// The CLI probes for a containing repo at startup by walking UP from its cwd. A
// session root inside one would make every session on this system report cc's
// own store's repo as the project's — git state from the wrong tree, with no
// env lever to turn the probe off. Placing session roots under the store is
// what normally makes this true; asserting it is what makes a store that was
// checked into a repo a REFUSAL at registration instead of a wrong answer at
// every later spawn.
//
// A decoy `.git` in the session root is deliberately NOT the fix: it would stop
// the walk by making the CLI believe the session root is itself a repo.
//
// Walks from the deepest existing ancestor upward — the session roots dir does
// not exist until a session is created, and the directories that would hold it
// are cc's own.
export async function assertSessionRootsPlaceable(systemId: string): Promise<void> {
  let dir = sessionRootsDir(systemId);
  for (;;) {
    // `.git` is a DIRECTORY in a normal checkout and a FILE in a worktree, so
    // the test is existence, not kind.
    try {
      await fs.lstat(path.join(dir, '.git'));
      throw httpError(
        400,
        `cannot host sessions for system '${systemId}': '${dir}' is a git repository, `
        + `and it contains where cc keeps this system's local session directories `
        + `(${sessionRootsDir(systemId)}). Move the code-conductor store out of the repository.`,
      );
    } catch (e) {
      if ((e as { statusCode?: unknown }).statusCode === 400) throw e;
      // ENOENT/ENOTDIR: no `.git` here, or this ancestor does not exist yet.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return; // reached the filesystem root
    dir = parent;
  }
}
