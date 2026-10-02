// Tells the server the human saw a session's latest turn end
// (POST /api/sessions/:sid/viewed), the write behind the sidebar's unread pill
// and the needs-you strip's Finished dot. A turn end counts as seen only while
// its session is the active pane, the document is visible, and no full-page
// view (Settings, Costs, a plugin…) owns the hash. The phone drawer covering
// the pane does not count as hidden.
//
// check() is idempotent; every trigger just calls it. app.js calls it from
// selectInstance (a pane opened) and refreshInstances (a turn ended, or another
// device marked it); this module adds visibilitychange and hashchange (leaving a
// full-page view through history.back()).

import { isMainViewHash } from './mainViews.js';
import { apiFetch } from './http.js';

// A localStorage key no module reads; install removes it.
const LEGACY_UNREAD_KEY = 'code-conductor:unread';

export function installViewedMarker({
  getActiveInstance, fetchJson = apiFetch, doc = document, win = window, storage = localStorage,
}) {
  try { storage.removeItem(LEGACY_UNREAD_KEY); } catch { /* storage can throw (private mode) */ }
  // sessionId → the highest seq posted or in flight, so repeat checks post once.
  const posted = new Map();

  function check() {
    if (doc.visibilityState !== 'visible') return;
    if (isMainViewHash(win.location.hash)) return;
    const inst = getActiveInstance();
    const sid = inst?.sessionId;
    if (!sid) return;
    const seq = inst.turnEndSeq ?? 0;
    if (seq <= (inst.viewedSeq ?? 0) || seq <= (posted.get(sid) ?? 0)) return;
    posted.set(sid, seq);
    fetchJson(`/api/sessions/${encodeURIComponent(sid)}/viewed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq }),
    }).catch((e) => {
      console.warn(`viewedMarker: marking ${sid} viewed at ${seq} failed: ${e?.message ?? e}`);
      if (posted.get(sid) === seq) posted.delete(sid);
    });
  }

  doc.addEventListener('visibilitychange', check);
  win.addEventListener('hashchange', check);
  return { check };
}
