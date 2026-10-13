// A routed `fetch` stub for component tests. Each call is recorded; a route is
// matched on the `${method} ${url}` prefix and answers `{ status?, json? }`, an
// Error (thrown, as a network failure is), or a Promise of either (an answer
// the test holds and releases). An unmatched call answers 200 `{}`. A request's
// `signal` is honoured as `fetch` does: already aborted at call time, or aborted
// while the answer is held, it rejects with an AbortError.
import { vi } from 'vitest';

export type RoutedCall = { method: string; url: string; body: any; signal: AbortSignal | undefined };
export type RouteAnswer = { status?: number; json?: unknown } | Error;
export type Route = (body: any, url: string) => RouteAnswer | Promise<RouteAnswer>;

export function routeFetch(routes: Record<string, Route>): RoutedCall[] {
  const calls: RoutedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ method, url, body, signal: init?.signal ?? undefined });
    const signal = init?.signal ?? undefined;
    const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw aborted();
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const answer: Promise<RouteAnswer> = Promise.resolve(key ? routes[key](body, url) : { json: {} });
    const r = await (signal
      ? Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(aborted()), { once: true }))])
      : answer);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }));
  return calls;
}

/** An answer the test holds: the route returns `answer`, the test calls `release`. */
export function held<T = RouteAnswer>() {
  let release!: (a: T) => void;
  const answer = new Promise<T>((r) => { release = r; });
  return { answer, release };
}
