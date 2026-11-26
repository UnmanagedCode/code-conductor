// Focus mode, client side: the UI shows one session with no sidebar. Two
// sources feed it. A headless-family server (a headless run, or a `--replay`)
// names the session on GET /api/health (the server focus); and a page whose URL
// carries `?focus=<sid>` focuses itself (the page focus), on any server. The
// server focus wins. Only the server focus makes a session interactive under
// `--ui interact` (shared/viewOnly.ts isInteractiveSession).
// DOM-free: node-tested without a DOM.

/** The session a headless-family server focuses on; `null` until a live run's root has spawned. */
export interface HealthFocus {
  sessionId: string | null;
}

let server: HealthFocus | null = null;
let page: HealthFocus | null = null;
const listeners = new Set<() => void>();

/** The query key that marks a page as focused on one session. */
export const FOCUS_PARAM = 'focus';

/** The focus in effect: the server's when it has one, else the page's. Null on an unfocused page. */
export function focusState(): HealthFocus | null {
  return server ?? page;
}

/** The focus the server advertised, or null on an ordinary server (or before the health read lands). */
export function serverFocus(): HealthFocus | null {
  return server;
}

/** The focus this page's URL marker names, or null. */
export function pageFocus(): HealthFocus | null {
  return page;
}

const sameFocus = (a: HealthFocus | null, b: HealthFocus | null): boolean =>
  a === null || b === null ? a === b : a.sessionId === b.sessionId;

/** Sets the server focus; listeners fire only when it changed. */
export function setFocus(next: HealthFocus | null): void {
  if (sameFocus(next, server)) return;
  server = next;
  for (const fn of [...listeners]) fn();
}

/** Sets the page focus; listeners fire only when it changed. */
export function setPageFocus(next: HealthFocus | null): void {
  if (sameFocus(next, page)) return;
  page = next;
  for (const fn of [...listeners]) fn();
}

/** The marker in a `location.search` string: the first non-empty `focus` value, else null. */
export function focusFromSearch(search: string): HealthFocus | null {
  const id = new URLSearchParams(search).get(FOCUS_PARAM);
  return id ? { sessionId: id } : null;
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
