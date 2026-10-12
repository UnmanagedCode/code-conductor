// Tells the server when the user saw the active session's latest turn end —
// the fact behind the sidebar's unread marks and the needs-you strip's
// "Finished" group. Seen = tab visible and the session pane (not a full-page
// view) showing.
import { apiFetch } from '@shared/http';
import { appStore, activeInstance } from '@/state/app';
import { routeStore } from '@/state/route';
import { on } from './events';

const LEGACY_UNREAD_KEY = 'code-conductor:unread';
const posted = new Map<string, number>();

function check() {
  if (document.visibilityState !== 'visible' || routeStore.get().route.view !== 'session') return;
  const inst = activeInstance(appStore.get());
  const sid = inst?.sessionId;
  if (!inst || !sid) return;
  const seq = inst.turnEndSeq ?? 0;
  if (seq <= (inst.viewedSeq ?? 0) || seq <= (posted.get(sid) ?? 0)) return;
  posted.set(sid, seq);
  apiFetch(`/api/sessions/${encodeURIComponent(sid)}/viewed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq }),
  }).catch((e: Error) => {
    console.warn(`viewedMarker: marking ${sid} viewed at ${seq} failed: ${e?.message ?? e}`);
    if (posted.get(sid) === seq) posted.delete(sid);
  });
}

export function startViewedMarker() {
  try { localStorage.removeItem(LEGACY_UNREAD_KEY); } catch { /* private mode */ }
  document.addEventListener('visibilitychange', check);
  on('select', () => queueMicrotask(check));
  on('instances', check);
  routeStore.subscribe(() => queueMicrotask(check));
}
