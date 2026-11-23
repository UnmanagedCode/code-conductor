// View-only (spectator) mode, client side: the flag, and the allowlists the two
// client chokepoints (http.ts apiResponse, ws.ts send) enforce while it is on.
// A UX convenience, not access control — the server enforces nothing.
// DOM-free: node-tested without a DOM.
//
// Both allowlists FAIL CLOSED: a route or frame type not named here is refused
// in view-only, so a new mutating call is blocked by default.

export const VIEW_ONLY_MESSAGE = 'View-only mode: changes are disabled. Restart cc without CC_VIEW_ONLY to make changes.';
export const VIEW_ONLY_CODE = 'VIEW_ONLY';

/** Thrown by a chokepoint for a refused call; neither an ApiError nor a NetworkError. `what` names the refused call. */
export class ViewOnlyError extends Error {
  readonly code = VIEW_ONLY_CODE;
  readonly what: string;
  constructor(what: string) {
    super(VIEW_ONLY_MESSAGE);
    this.what = what;
  }
}

/** The non-GET/HEAD REST calls a view-only client may still make. Paths match with the query stripped. */
export const VIEW_ONLY_REST_ALLOW: readonly { method: string; pattern: RegExp; why: string }[] = [
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/viewed$/, why: 'the unread marker' },
  { method: 'POST', pattern: /^\/api\/tts$/, why: 'read-aloud; persists nothing' },
  { method: 'POST', pattern: /^\/api\/plugins\/[^/]+\/start$/, why: 'a plugin view lazily starts its backend' },
];

/** The WebSocket frame types a view-only client may still send (read-only subscriptions and presence). */
export const VIEW_ONLY_FRAMES_ALLOW: ReadonlySet<string> = new Set(['subscribe', 'unsubscribe', 'pristine_view', 'pristine_leave']);

let on = false;
const changeListeners = new Set<() => void>();
const refusalListeners = new Set<(e: ViewOnlyError) => void>();

export function isViewOnly(): boolean {
  return on;
}

export function setViewOnly(next: boolean): void {
  if (on === next) return;
  on = next;
  for (const fn of [...changeListeners]) fn();
}

/** Notified when the flag changes; returns the unsubscribe. */
export function subscribeViewOnly(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

/** Notified once per refused call; returns the unsubscribe. */
export function onViewOnlyRefusal(fn: (e: ViewOnlyError) => void): () => void {
  refusalListeners.add(fn);
  return () => { refusalListeners.delete(fn); };
}

/** Records a refusal: notifies every listener and returns the error for the caller to throw or reject with. */
export function refuse(what: string): ViewOnlyError {
  const e = new ViewOnlyError(what);
  for (const fn of [...refusalListeners]) fn(e);
  return e;
}

export function requestAllowed(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const p = url.split(/[?#]/, 1)[0];
  return VIEW_ONLY_REST_ALLOW.some((r) => r.method === m && r.pattern.test(p));
}

export function frameAllowed(t: string): boolean {
  return VIEW_ONLY_FRAMES_ALLOW.has(t);
}
