// Focus mode, client side: a headless-family server (a headless run, or a
// `--replay`) names on GET /api/health the one session the UI shows, and
// the client then renders no sidebar and opens it. Under `--ui interact` that
// session is also the interactive one (shared/viewOnly.ts isInteractiveSession).
// DOM-free: node-tested without a DOM.

/** The session a headless-family server focuses on; `null` until a live run's root has spawned. */
export interface HealthFocus {
  sessionId: string | null;
}

let current: HealthFocus | null = null;
const listeners = new Set<() => void>();

/** The focus the server advertised, or null on an ordinary server (or before the health read lands). */
export function focusState(): HealthFocus | null {
  return current;
}

/** Sets the focus; listeners fire only when it changed. */
export function setFocus(next: HealthFocus | null): void {
  const same = next === null || current === null
    ? next === current
    : next.sessionId === current.sessionId;
  if (same) return;
  current = next;
  for (const fn of [...listeners]) fn();
}

/** Notified when the focus changes; returns the unsubscribe. */
export function subscribeFocus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The `focus` key of a GET /api/health body, or null when absent or malformed. */
export function focusFromHealth(body: unknown): HealthFocus | null {
  const f = (body as { focus?: unknown } | null)?.focus;
  if (typeof f !== 'object' || f === null) return null;
  const id = (f as { sessionId?: unknown }).sessionId;
  if (id !== null && typeof id !== 'string') return null;
  return { sessionId: id };
}
