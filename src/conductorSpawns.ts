// Which projects each root conductor has ever spawned a worker into, derived
// from the spawn-time facts `markConducted` records (`parent` / `project`).
// A read-only consumer of the session store: everything goes through
// `loadSessions()`, nothing here writes.

import { loadSessions, type SessionsDoc } from './sessionStore.ts';

export interface SpawnedProject { project: string; lastSpawnAt: string }
export type SpawnedProjectsByRoot = Record<string, SpawnedProject[]>;

// The root conductor a conducted session was spawned under — the rule
// `rootOwnerOf` (src/instances.ts) applies live: climb conducted parents to the
// first non-conducted session. Null when the chain cannot be followed to one (a
// missing record, a conducted ancestor with no recorded parent, or a cycle a
// conductor-side resume can create by overwriting `parent`): an unattributed
// worker is preferred over a misattributed one.
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

const memo = new WeakMap<SessionsDoc, SpawnedProjectsByRoot>();

// root publicId → one entry per project a conducted worker under it carries,
// newest `lastSpawnAt` first, then by name. `lastSpawnAt` is the newest segment
// `at` across that root's workers in the project: a segment is minted at the
// conducted spawn and at every renew/prune, so a conductor resuming an existing
// worker does not bump it. A root whose current segment is archived is omitted.
// Memoised per doc object: `loadSessions()` hands back the same doc until the
// file changes.
export function spawnedProjectsByRoot(doc: SessionsDoc): SpawnedProjectsByRoot {
  const hit = memo.get(doc);
  if (hit) return hit;
  const byRoot = new Map<string, Map<string, string>>();
  for (const [publicId, rec] of doc) {
    if (rec.conducted !== true || !rec.project) continue;
    const root = rootOf(doc, publicId);
    if (!root) continue;
    let projects = byRoot.get(root);
    if (!projects) { projects = new Map(); byRoot.set(root, projects); }
    let newest = projects.get(rec.project) ?? '';
    for (const s of rec.segments) if (s.at > newest) newest = s.at;
    projects.set(rec.project, newest);
  }
  const out: SpawnedProjectsByRoot = {};
  for (const [root, projects] of byRoot) {
    const rootRec = doc.get(root);
    if (rootRec?.segments.find(s => s.id === rootRec.current)?.archived) continue;
    out[root] = [...projects].map(([project, lastSpawnAt]) => ({ project, lastSpawnAt }))
      .sort((a, b) => (a.lastSpawnAt < b.lastSpawnAt ? 1 : a.lastSpawnAt > b.lastSpawnAt ? -1 : a.project.localeCompare(b.project)));
  }
  memo.set(doc, out);
  return out;
}

export async function conductorSpawnedProjects(): Promise<SpawnedProjectsByRoot> {
  return spawnedProjectsByRoot((await loadSessions()).byPublic);
}
