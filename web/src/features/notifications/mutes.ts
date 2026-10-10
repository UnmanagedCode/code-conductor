// Per-session notification mutes, keyed by sessionId (survives respawns) and
// persisted under the same localStorage key the app has always used.
import { createSignal } from '@/state/createStore';

const MUTED_STORAGE_KEY = 'code-conductor:muted-sessions';
export const mutesSignal = createSignal();
const muted = new Set<string>();

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

(function restore() {
  try {
    const raw = storage()?.getItem(MUTED_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && id) muted.add(id);
  } catch { /* corrupt: start unmuted */ }
})();

export function isSessionMuted(sessionId: string | null | undefined) {
  return !!sessionId && muted.has(sessionId);
}

export function muteSession(sessionId: string | null | undefined, mute: boolean) {
  if (!sessionId) return;
  if (mute) muted.add(sessionId);
  else muted.delete(sessionId);
  try {
    const s = storage();
    if (muted.size === 0) s?.removeItem(MUTED_STORAGE_KEY);
    else s?.setItem(MUTED_STORAGE_KEY, JSON.stringify([...muted]));
  } catch { /* best effort */ }
  mutesSignal.bump();
}
