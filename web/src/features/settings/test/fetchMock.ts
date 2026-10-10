import { vi } from 'vitest';

export type Call = { method: string; url: string; body: any };
type Handler = (call: Call) => { status?: number; json?: unknown } | unknown;

/**
 * Install a fetch stub routed by "METHOD path" (query ignored); an unrouted
 * request answers 404. Returns the recorded calls.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    let body: any = init?.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* raw */ }
    const call = { method, url, body };
    calls.push(call);
    const key = `${method} ${url.split('?')[0]}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: `unrouted ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const out = h(call) as any;
    const isEnvelope = out && typeof out === 'object' && ('status' in out || 'json' in out) && Object.keys(out).every((k) => k === 'status' || k === 'json');
    const status = isEnvelope ? out.status ?? 200 : 200;
    const json = isEnvelope ? out.json : out;
    return new Response(JSON.stringify(json ?? {}), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
