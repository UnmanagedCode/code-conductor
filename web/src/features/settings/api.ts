// Fetch helpers for the Settings routes: every route answers JSON (errors as
// {error, tail?}, thrown as @shared/http's ApiError); the install/update routes
// stream NDJSON progress.
import { ApiError, apiFetch, apiResponse, readApiBody } from '@shared/http';

export async function json<T = any>(url: string, init?: Omit<RequestInit, 'body'> & { body?: any }): Promise<T> {
  const opts: RequestInit = { cache: 'no-store', ...(init as RequestInit) };
  if (init?.body !== undefined && typeof init.body !== 'string') {
    opts.body = JSON.stringify(init.body);
    opts.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  }
  // A non-JSON 2xx reads as {} here, not apiFetch's null.
  return ((await apiFetch<T | null>(url, opts)) ?? {}) as T;
}

export const post = <T = any>(url: string, body?: unknown) => json<T>(url, { method: 'POST', body: body ?? {} });
export const put = <T = any>(url: string, body?: unknown) => json<T>(url, { method: 'PUT', body: body ?? {} });
export const patch = <T = any>(url: string, body?: unknown) => json<T>(url, { method: 'PATCH', body: body ?? {} });
export const del = <T = any>(url: string) => json<T>(url, { method: 'DELETE' });

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * POST a streaming action (`{type:'chunk',text,phase?}` lines, then one
 * `{type:'result', ok, result|error, tail?}`). A non-NDJSON answer (an early
 * refusal) is handled as plain JSON. `body` is sent as JSON.
 */
export async function streamAction(
  path: string,
  onChunk: (text: string, phase?: string) => void,
  method = 'POST',
  { body, fetchImpl = fetch }: { body?: unknown; fetchImpl?: typeof fetch } = {},
): Promise<any> {
  const r = await apiResponse(path, {
    method,
    cache: 'no-store',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }, fetchImpl);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('ndjson')) return (await readApiBody(r)) ?? {};
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final: any = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.type === 'chunk') onChunk(evt.text, evt.phase);
      else if (evt.type === 'result') final = evt;
    }
    if (done) break;
  }
  if (!final) throw new Error('stream ended unexpectedly');
  if (!final.ok) throw new ApiError(final.error || 'operation failed', r.status, final);
  return final.result;
}

/** Keep the last `cap` characters of a growing log. */
export const capLog = (prev: string, add: string, cap = 8192) => (prev + add).slice(-cap);
