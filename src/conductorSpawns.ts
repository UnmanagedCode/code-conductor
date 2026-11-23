// Which projects each root has ever had a worker spawned into, and the
// worktrees those workers ran in, derived from the spawn-time facts
// recorded on each session (`parent` by `markConducted`, `project` / `worktree`
// by `setSessionPlace`).
// `conductedLineage` answers a session's stored lineage for a caller-less resume.
// A read-only consumer of the session store: everything goes through
// `loadSessions()`, nothing here writes.

import type { SessionSpawner } from '../shared/wireRows.ts';
import { loadSessions, type SessionsDoc } from './sessionStore.ts';

export interface SpawnedProject { project: string; lastSpawnAt: string; worktrees: string[] }
export type SpawnedProjectsByRoot = Record<string, SpawnedProject[]>;

// The root a conducted session was spawned under — the rule
// `rootSessionOf` (src/instances.ts) applies live: climb conducted parents to the
// first non-conducted session. Null when the chain cannot be followed to one (a
// missing record, a conducted record on the chain — the worker's own included —
// with no recorded parent, or a cycle a conductor-side resume can create by
// overwriting `parent`): an unattributed worker is preferred over a
// misattributed one.
export function rootOf(doc: SessionsDoc, publicId: string): string | null {
  const seen = new Set([publicId]);
  let cur = doc.get(publicId)?.parent;
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const rec = doc.get(cur);
    if (!rec) return null;
    if (!rec.conducted) return cur;
    cur = rec.parent;
  }
  return null;
}

// The sessions `publicId` spawned (or last resumed): records whose recorded `parent` is it,
// with their recorded place. A record with no `project` cannot be placed and is skipped.
// Direct children only, not grandchildren.
export function spawnedChildren(doc: SessionsDoc, publicId: string): { sessionId: string; project: string; worktree: string | null }[] {
  const out: { sessionId: string; project: string; worktree: string | null }[] = [];
  for (const [sessionId, rec] of doc) {
    if (rec.parent === publicId && rec.project) out.push({ sessionId, project: rec.project, worktree: rec.worktree ?? null });
  }
  return out;
}

// A session's stored spawn lineage: null unless it is `conducted`; else its
// recorded `parent` and the `rootOf` its chain resolves to (either null when
// unrecorded).
export function conductedLineage(doc: SessionsDoc, publicId: string): { parent: string | null; root: string | null } | null {
  const rec = doc.get(publicId);
  if (rec?.conducted !== true) return null;
  return { parent: rec.parent ?? null, root: rootOf(doc, publicId) };
}

// GET /api/sessions/:sid/spawner: a session's recorded lineage, in the shape the client puts on an Instance.
export async function sessionSpawner(publicId: string): Promise<SessionSpawner> {
  const lineage = conductedLineage((await loadSessions()).byPublic, publicId);
  return lineage
    ? { conducted: true, parentSessionId: lineage.parent, rootSessionId: lineage.root }
    : { conducted: false, parentSessionId: null, rootSessionId: null };
}

const memo = new WeakMap<SessionsDoc, SpawnedProjectsByRoot>();

// root publicId → one entry per project a conducted worker under it carries,
// newest `lastSpawnAt` first, then by name. `lastSpawnAt` is the newest segment
// `at` across that root's workers in the project: a segment is minted at the
// conducted spawn and at every renew/prune, so a conductor resuming an existing
// worker does not bump it. `worktrees` is the distinct recorded `worktree`
// names of those workers, sorted by name — a main-checkout worker adds none,
// and nothing checks the worktree still exists (the client filters against
// the project's worktree list). A root whose current segment is archived is
// omitted.
// Memoised per doc object: `loadSessions()` hands back the same doc until the
// file changes.
export function spawnedProjectsByRoot(doc: SessionsDoc): SpawnedProjectsByRoot {
  const hit = memo.get(doc);
  if (hit) return hit;
  const byRoot = new Map<string, Map<string, { newest: string; worktrees: Set<string> }>>();
  for (const [publicId, rec] of doc) {
    if (rec.conducted !== true || !rec.project) continue;
    const root = rootOf(doc, publicId);
    if (!root) continue;
    let projects = byRoot.get(root);
    if (!projects) { projects = new Map(); byRoot.set(root, projects); }
    let entry = projects.get(rec.project);
    if (!entry) { entry = { newest: '', worktrees: new Set() }; projects.set(rec.project, entry); }
    for (const s of rec.segments) if (s.at > entry.newest) entry.newest = s.at;
    if (rec.worktree) entry.worktrees.add(rec.worktree);
  }
  const out: SpawnedProjectsByRoot = {};
  for (const [root, projects] of byRoot) {
    const rootRec = doc.get(root);
    if (rootRec?.segments.find(s => s.id === rootRec.current)?.archived) continue;
    out[root] = [...projects]
      .map(([project, e]) => ({ project, lastSpawnAt: e.newest, worktrees: [...e.worktrees].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => (a.lastSpawnAt < b.lastSpawnAt ? 1 : a.lastSpawnAt > b.lastSpawnAt ? -1 : a.project.localeCompare(b.project)));
  }
  memo.set(doc, out);
  return out;
}

export async function conductorSpawnedProjects(): Promise<SpawnedProjectsByRoot> {
  return spawnedProjectsByRoot((await loadSessions()).byPublic);
}
