// What a session's × does: one step down from where the session is. Pure, no
// DOM — the sidebar reads it to title the button and sessionActions reads it to
// route the click, so the state → action mapping lives here once.
//
// `status` is the status the session's dot renders (displayStatus ?? status).
// A disk row has no instance, and `isLiveStatus(null)` is true, so a missing
// instanceId or status is never live.

import { isLiveStatus } from './conductors.js';

// A live persistent session stops (transcript kept, resumable); a live temp
// session or one that is not live is archived.
export function closeActionOf({ instanceId, status, temp }) {
  const live = !!instanceId && !!status && isLiveStatus(status);
  return live && !temp ? 'stop' : 'archive';
}

export const CLOSE_TITLES = { stop: 'Stop session', archive: 'Archive session (keeps history)' };

// A stop kills running work unless the session is plain idle. `displayStatus`
// only overlays live states, so turn, running and spawning all count as busy.
export function stopNeedsConfirm(status) { return status !== 'idle'; }
