// The session-title vocabulary, and the one title write behind both the REST
// rename and the MCP set_session_title. The title itself is a session-level
// fact on the session's record in the unified store (src/sessionStore.ts), so a
// rotation never strands it.

import { setTitle } from './sessionStore.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

export const MAX_TITLE_LEN = 100;

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
