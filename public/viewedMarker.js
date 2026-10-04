// Tells the server the human saw a session's latest turn end
// (POST /api/sessions/:sid/viewed), the write behind the sidebar's unread pill
// and the needs-you strip's Finished dot. A turn end counts as seen only when,
// at the moment check() decides, its session is the active pane, the document
// is visible, no full-page view (Settings, Costs, Commits, Review, a plugin)
// owns the hash, and none is open by its own state (isAnyMainViewOpen). The
// phone drawer covering the pane does not count as hidden.
//
// check() is idempotent; every trigger just calls it. app.js calls it from
// selectInstance (after reconcileMainViews, so a superseded view no longer
// reads open) and refreshInstances (a turn ended, or another device marked it);
// this module adds visibilitychange and every full-page view exit
// (onMainViewClosed, raised after the exit restores the session anchor however
// it does). An exit's check is deferred one microtask: an exit that hands the
// pane to another view in the same tick (settings.close(); costs.open()) must
// be judged after that open, not at the signal.

import { isMainViewHash, isAnyMainViewOpen, onMainViewClosed } from './mainViews.js';
import { apiFetch } from './http.js';

// A localStorage key no module reads; install removes it.
const LEGACY_UNREAD_KEY = 'code-conductor:unread';

// The "seen" half of check(): the document is visible and no full-page view
// owns the pane. Shared with the attention notifier's on-screen test.
export function isActivePaneSeen({ doc = document, win = window } = {}) {
  return doc.visibilityState === 'visible' && !isMainViewHash(win.location.hash) && !isAnyMainViewOpen();
}

export function installViewedMarker({
  getActiveInstance, fetchJson = apiFetch, doc = document, win = window, storage = localStorage,
}) {
  try { storage.removeItem(LEGACY_UNREAD_KEY); } catch { /* storage can throw (private mode) */ }
  // sessionId → the highest seq posted or in flight, so repeat checks post once.
  const posted = new Map();

  function check() {
    if (!isActivePaneSeen({ doc, win })) return;
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
  onMainViewClosed(() => queueMicrotask(check));
  return { check };
}
