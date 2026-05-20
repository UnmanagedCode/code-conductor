// URL-hash anchor for the active conversation. Lets a page refresh restore
// whichever session the user was viewing instead of dropping them on the
// empty placeholder. The hash carries the sessionId (stable across crash /
// resume cycles), not the transient instance id.

export function readSessionAnchor() {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!h) return null;
  const params = new URLSearchParams(h);
  return params.get('session') || null;
}

// Writes the session anchor without polluting browser history (replaceState).
// Passing null/undefined clears the hash.
export function writeSessionAnchor(sessionId) {
  const base = location.pathname + location.search;
  if (sessionId) {
    history.replaceState(null, '', `${base}#session=${encodeURIComponent(sessionId)}`);
  } else if (location.hash) {
    history.replaceState(null, '', base);
  }
}
