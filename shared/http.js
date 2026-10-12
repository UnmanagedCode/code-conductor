// One fetch-error idiom for the whole client — the client-side counterpart of
// src/httpError.ts. Every REST route on this server answers JSON, including
// its errors ({error: string}), so one helper covers the "throw the server's
// message, fall back to the status" shape that used to be copied per call
// site.
//
// Returns the PARSED BODY, so a caller that used the response needs no second
// `await r.json()`. A non-JSON body (a bodyless 204, or an HTML 502 from a
// proxy) yields null rather than a SyntaxError — which is what the hand-rolled
// copies leaked into an alert as `Unexpected token '<'…`.
//
// Callers that need the raw Response (a status-specific branch, a body stream,
// an error carrying extra fields) keep their own fetch — see
// sessionActions.js's silent-resume and force-remove paths.

export async function apiFetch(url, opts) {
  const r = await fetch(url, opts);
  // `||`, not `??`: matches the sites that already had a fallback, and differs
  // only for a falsy-but-present `.error`, which no route emits.
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}
