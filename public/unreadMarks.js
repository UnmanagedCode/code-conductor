// The unread fact, from the server's turn marks (the session record's
// turnEndSeq / viewedSeq, carried by every /api/instances summary and every
// disk session row). Pure: no DOM, no storage.

export function unreadCount({ turnEndSeq, viewedSeq }) {
  return Math.max(0, (turnEndSeq ?? 0) - (viewedSeq ?? 0));
}

// sessionId → unread count, counts > 0 only. A live instance wins over a disk
// row for the same session: rows sit in the sidebar's sessions cache, the
// instance list is refetched on every status change.
export function unreadBySession({ instances = [], rows = [] }) {
  const marks = new Map();
  for (const r of rows) if (r?.sessionId) marks.set(r.sessionId, r);
  for (const i of instances) if (i?.sessionId) marks.set(i.sessionId, i);
  const out = new Map();
  for (const [sid, m] of marks) {
    const n = unreadCount(m);
    if (n > 0) out.set(sid, n);
  }
  return out;
}
