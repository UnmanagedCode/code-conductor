// The session-title vocabulary, and the one title write behind the REST
// rename, the MCP set_session_title and a fork's starting title. The title itself is a session-level
// fact on the session's record in the unified store (src/sessionStore.ts), so a
// rotation never strands it.

import { setTitle } from './sessionStore.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

export const MAX_TITLE_LEN = 100;

export const FORK_TITLE_PREFIX = 'fork: ';

// The title a fork of a session titled `source` starts with; null (no title)
// for an untitled source. Capping is left to the store write (normalizeTitle).
export function forkTitle(source: string | null): string | null {
  return source ? `${FORK_TITLE_PREFIX}${source}` : null;
}

// Trimmed and capped; '' means "no title".
export function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, MAX_TITLE_LEN);
}

// Store the title on the session `sid` names (a public id or any of its
// segments) and push the stored value to every live instance attached to it, so
// its header re-renders.
export async function applySessionTitle(
  instances: Pick<InstanceManagerLike, 'idsForSession' | 'get'> | null | undefined,
  sid: string,
  title: unknown,
): Promise<string | null> {
  const stored = await setTitle(sid, title);
  if (instances) {
    for (const id of instances.idsForSession(sid)) {
      const inst = instances.get(id);
      if (inst) inst.setTitle(stored);
    }
  }
  return stored;
}
