// One fetch-error idiom for the whole client — the client-side counterpart of
// src/httpError.ts. Every REST route on this server answers JSON, including
// its errors ({error: string}), so one helper covers the "throw the server's
// message, fall back to the status" shape.
//
// Every client REST call goes through this file; there is no raw fetch
// outside it. The throw contract:
//   - the server answers non-2xx → ApiError (status, parsed body, tail);
//   - fetch() itself rejects (server down, restarting, unreachable) →
//     NetworkError, whose message is SERVER_UNREACHABLE_MESSAGE whatever the
//     browser's own wording was;
//   - an AbortError passes through untouched.
// Callers branch on a status with `e instanceof ApiError && e.status === N`.
//
// apiFetch returns the PARSED BODY. A non-JSON body (a bodyless 204, or an
// HTML 502 from a proxy) yields null rather than a SyntaxError. apiResponse
// is for status-agnostic or streamed readers that need the raw Response;
// readApiBody applies apiFetch's body half to a Response one of them holds.
//
// `T` names the route's body; it is the caller's claim about the wire.

/** The one message every network failure (server down, restarting, unreachable) surfaces as. */
export const SERVER_UNREACHABLE_MESSAGE = 'cc server unreachable — it may be restarting';

/** The server answered non-2xx. `body` is the parsed JSON (null when it did not parse). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The command output some routes attach to a failure (`{error, tail}`); only a string counts. */
  readonly tail: string | undefined;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    const tail = fieldOf(body, 'tail');
    this.tail = typeof tail === 'string' ? tail : undefined;
  }
}

/** fetch() itself rejected: no answer from the server. The original rejection is `cause`. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(SERVER_UNREACHABLE_MESSAGE, { cause });
  }
}

/** fetch with network failures normalized; the raw Response, no status check. For status-agnostic or streamed readers. */
export async function apiResponse(url: string, opts?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    return await fetchImpl(url, opts);
  } catch (e) {
    if (fieldOf(e, 'name') === 'AbortError') throw e;
    throw new NetworkError(e);
  }
}

/** A Response's parsed JSON body; non-2xx throws ApiError(body.error || `HTTP <status>`). A non-JSON body reads as null. */
export async function readApiBody<T = unknown>(r: Response): Promise<T> {
  const body: unknown = await r.json().catch(() => null);
  // `||`, not `??`: matches the sites that already had a fallback, and differs
  // only for a falsy-but-present `.error`, which no route emits.
  if (!r.ok) throw new ApiError(String(fieldOf(body, 'error') || `HTTP ${r.status}`), r.status, body);
  return body as T;
}

export async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  return readApiBody<T>(await apiResponse(url, opts));
}

// `x && x[key]`, for a value of unknown shape.
function fieldOf(x: unknown, key: string): unknown {
  return x && typeof x === 'object' && key in x ? (x as Record<string, unknown>)[key] : undefined;
}
