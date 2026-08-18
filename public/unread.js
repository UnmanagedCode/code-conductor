// Per-sessionId unread count. Incremented when a turn_notification lands
// for a session the user isn't currently viewing; cleared on
// selectInstance. Keyed by sessionId (not instance id) so the count
// survives a crash + resume cycle that mints a new instance id for the
// same session. Persisted to localStorage so it also survives page
// refreshes — turn_notifications keep firing for live background
// instances even when no tab is connected (the server-side ring buffer
// can't replay missed ones, but new ones after reload are counted).
//
// `onChange(counts)` fires after every successful mutation, AFTER the save —
// app.js wires it to sidebar.setUnread so the pills repaint. `counts` is the
// live Map itself (not a copy): callers seed the sidebar with the same
// instance the store keeps mutating in place.

const UNREAD_STORAGE_KEY = 'code-conductor:unread';

export function createUnreadStore({ onChange }) {
  function loadUnreadFromStorage() {
    try {
      const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return new Map();
      return new Map(Object.entries(obj).filter(([, v]) => Number.isInteger(v) && v > 0));
    } catch {
      return new Map();
    }
  }
  function saveUnreadToStorage() {
    try {
      if (unreadBySessionId.size === 0) localStorage.removeItem(UNREAD_STORAGE_KEY);
      else localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(Object.fromEntries(unreadBySessionId)));
    } catch {
      // localStorage can throw (private mode, quota) — unread is best-effort.
    }
  }
  const unreadBySessionId = loadUnreadFromStorage();
  function bumpUnread(sessionId) {
    if (!sessionId) return;
    unreadBySessionId.set(sessionId, (unreadBySessionId.get(sessionId) ?? 0) + 1);
    saveUnreadToStorage();
    onChange(unreadBySessionId);
  }
  function clearUnread(sessionId) {
    if (!sessionId) return;
    if (!unreadBySessionId.delete(sessionId)) return;
    saveUnreadToStorage();
    onChange(unreadBySessionId);
  }

  return { counts: unreadBySessionId, bump: bumpUnread, clear: clearUnread };
}
