// URL-hash anchor for the active conversation. Lets a page refresh restore
// whichever session the user was viewing instead of dropping them on the
// empty placeholder. The hash carries the sessionId (stable across crash /
// resume cycles), not the transient instance id.

const STASH_KEY = 'cc:session-stash';

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

// Persist the current session anchor to localStorage so it survives a PWA
// cold-relaunch. We do this only at the moment we're about to hand the user
// off to an external browser tab (where Android may reap the PWA process
// while it's backgrounded) — not on every session change — so the stash
// doesn't outlive the round-trip and silently snap an unrelated future
// launch back into an old conversation.
export function stashCurrentAnchorForRelaunch(storage = safeStorage()) {
  if (!storage) return;
  const id = readSessionAnchor();
  try {
    if (id) storage.setItem(STASH_KEY, id);
    else storage.removeItem(STASH_KEY);
  } catch { /* quota / disabled storage — best effort */ }
}

// Read and remove the stashed session id. One-shot: a successful read clears
// the stash so the next cold start doesn't keep resuming the same session.
export function consumeStashedAnchor(storage = safeStorage()) {
  if (!storage) return null;
  try {
    const id = storage.getItem(STASH_KEY);
    if (id) storage.removeItem(STASH_KEY);
    return id || null;
  } catch {
    return null;
  }
}

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}
