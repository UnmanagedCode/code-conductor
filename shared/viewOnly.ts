// The UI mode, client side (shared/uiMode.ts names the modes): the current
// mode, and the allowlists the two client chokepoints (http.ts apiResponse,
// ws.ts send) enforce while it is not `full`.
//   - `view`: every mutating call is refused except VIEW_ONLY_REST_ALLOW /
//     VIEW_ONLY_FRAMES_ALLOW.
//   - `interact`: as `view`, plus INTERACT_FRAMES_ALLOW / INTERACT_REST_ALLOW
//     for the interactive session only — the focused session GET /api/health
//     names (serverFocus().sessionId) — and INTERACT_REST_ANY.
// A UX convenience, not access control: the server enforces none of this.
// The mode stays `full` until the health read answers (shared/capabilities.ts).
// DOM-free: node-tested without a DOM.
//
// Every allowlist FAILS CLOSED: a route or frame type not named here is
// refused, and an interact entry passes only when the session it addresses is
// the interactive one, so a new mutating call is blocked by default.

import type { UiMode } from './uiMode.ts';
import { serverFocus, subscribeFocus } from './focus.ts';

export const VIEW_ONLY_MESSAGE = 'Read-only here: this cc runs with --ui view or interact. Restart it with --ui full to make changes.';
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

/** The non-GET/HEAD REST calls every non-`full` client may still make. Paths match with the query stripped. */
export const VIEW_ONLY_REST_ALLOW: readonly { method: string; pattern: RegExp; why: string }[] = [
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/viewed$/, why: 'the unread marker' },
  { method: 'POST', pattern: /^\/api\/tts$/, why: 'read-aloud; persists nothing' },
  { method: 'POST', pattern: /^\/api\/plugins\/[^/]+\/start$/, why: 'a plugin view lazily starts its backend' },
];

/** The WebSocket frame types every non-`full` client may still send (read-only subscriptions and presence). */
export const VIEW_ONLY_FRAMES_ALLOW: ReadonlySet<string> = new Set(['subscribe', 'unsubscribe', 'pristine_view', 'pristine_leave']);

/** The frame types the interactive session's controls send; a frame passes only when its `id` is that session's instance. */
export const INTERACT_FRAMES_ALLOW: ReadonlySet<string> = new Set([
  'prompt',
  'interrupt',
  // A plan's Approve leaves plan mode (bypassPermissions) before its prompt.
  'mode',
]);

/** A REST call the interactive session's controls make; `session` names the session it addresses, or null. */
export interface InteractRestEntry {
  method: string;
  pattern: RegExp;
  session: (match: RegExpExecArray, body: string | undefined) => string | null;
  why: string;
}

const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

// The `resume` of a JSON body, or null (no body, not JSON, or no string `resume`).
function resumeOf(body: string | undefined): string | null {
  if (body === undefined) return null;
  try {
    const v: unknown = JSON.parse(body);
    const r = (v as { resume?: unknown } | null)?.resume;
    return typeof r === 'string' ? r : null;
  } catch { return null; }
}

/** The non-GET/HEAD REST calls `interact` admits for the interactive session. Paths match with the query stripped. */
export const INTERACT_REST_ALLOW: readonly InteractRestEntry[] = [
  { method: 'POST', pattern: /^\/api\/instances$/, session: (_m, body) => resumeOf(body), why: 'resuming the session (a fresh spawn carries no resume)' },
  { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/respawn$/, session: (m) => { const id = decode(m[1]); return id === null ? null : lookupSession(id); }, why: "the header Resume of a crashed or exited session" },
  { method: 'POST', pattern: /^\/api\/projects\/[^/]+\/sessions\/([^/]+)\/restore$/, session: (m) => decode(m[1]), why: 'un-archiving the session before its resume' },
  { method: 'POST', pattern: /^\/api\/projects\/[^/]+\/worktrees\/[^/]+\/sessions\/([^/]+)\/restore$/, session: (m) => decode(m[1]), why: 'un-archiving the session before its resume' },
];

/** The `interact` exceptions that address no session: admitted for any caller while the mode is `interact`. */
export const INTERACT_REST_ANY: readonly { method: string; pattern: RegExp; why: string }[] = [
  { method: 'POST', pattern: /^\/api\/transcribe$/, why: "the interactive Composer's dictation; persists nothing" },
];

let mode: UiMode = 'full';
let sessionLookup: ((instanceId: string) => string | null) | null = null;
const changeListeners = new Set<() => void>();
const refusalListeners = new Set<(e: ViewOnlyError) => void>();

/** The global gate: true under `view` and `interact`. */
export function isViewOnly(): boolean {
  return mode !== 'full';
}

export function uiMode(): UiMode {
  return mode;
}

export function setUiMode(next: UiMode): void {
  if (mode === next) return;
  mode = next;
  for (const fn of [...changeListeners]) fn();
}

/** Notified when the mode changes; returns the unsubscribe. */
export function subscribeViewOnly(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

/** Maps an instance id to its public session id, for the frames and routes that name an instance; null clears it. */
export function setInstanceSessionLookup(fn: ((instanceId: string) => string | null) | null): void {
  sessionLookup = fn;
}

function lookupSession(instanceId: string): string | null {
  return sessionLookup?.(instanceId) ?? null;
}

/** True only under `interact`, for the session the server focuses; a page's URL marker never counts, and nothing is interactive while the server focus is null. */
export function isInteractiveSession(sessionId: string | null | undefined): boolean {
  return mode === 'interact' && !!sessionId && sessionId === serverFocus()?.sessionId;
}

/** Whether `sessionId`'s controls are read-only: the global gate, minus the interactive session. */
export function sessionViewOnly(sessionId: string | null | undefined): boolean {
  return isViewOnly() && !isInteractiveSession(sessionId);
}

/** Notified when the mode or the focus changes (either can move sessionViewOnly); returns one unsubscribe. */
export function subscribeSessionViewOnly(fn: () => void): () => void {
  const offMode = subscribeViewOnly(fn);
  const offFocus = subscribeFocus(fn);
  return () => { offMode(); offFocus(); };
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

/** Whether a REST call may go out under the current mode; `body` is inspected only when it is a string. */
export function requestAllowed(method: string, url: string, body?: unknown): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const p = url.split(/[?#]/, 1)[0];
  if (VIEW_ONLY_REST_ALLOW.some((r) => r.method === m && r.pattern.test(p))) return true;
  if (mode !== 'interact') return false;
  if (INTERACT_REST_ANY.some((r) => r.method === m && r.pattern.test(p))) return true;
  const text = typeof body === 'string' ? body : undefined;
  return INTERACT_REST_ALLOW.some((r) => {
    if (r.method !== m) return false;
    const match = r.pattern.exec(p);
    return match !== null && isInteractiveSession(r.session(match, text));
  });
}

/** Whether a WebSocket frame may be written under the current mode. */
export function frameAllowed(t: string, payload?: Record<string, unknown>): boolean {
  if (VIEW_ONLY_FRAMES_ALLOW.has(t)) return true;
  if (mode !== 'interact' || !INTERACT_FRAMES_ALLOW.has(t)) return false;
  const id = payload?.id;
  return typeof id === 'string' && isInteractiveSession(lookupSession(id));
}
