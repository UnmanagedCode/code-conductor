// The one "the human saw it" write behind POST /api/sessions/:sid/viewed. It is
// browser-only by construction: routes.ts is its one importer and no MCP
// handler reaches it, so a conductor reading a worker's output never marks the
// worker viewed (pinned by tests/session-viewed.test.mjs).

import { markViewed, type TurnMarks } from './sessionStore.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

// Raise the session's viewedSeq to `seq` (clamped by markViewed) and push the
// stored marks to every live instance attached to it; their status emit is what
// tells every client to re-fetch.
export async function applySessionViewed(
  instances: Pick<InstanceManagerLike, 'idsForSession' | 'get'> | null | undefined,
  sid: string,
  seq: number,
): Promise<TurnMarks> {
  const marks = await markViewed(sid, seq);
  if (instances) {
    for (const id of instances.idsForSession(sid)) instances.get(id)?.setTurnMarks(marks);
  }
  return marks;
}
