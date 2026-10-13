// routeFetch honours a request's AbortSignal as the real fetch does, so a test
// of code that cancels and retries cannot pass on a fake that ignores aborts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { held, routeFetch, type RouteAnswer } from './routeFetch';

afterEach(() => { vi.unstubAllGlobals(); });

describe('routeFetch and AbortSignal', () => {
  it('a request on an already-aborted signal rejects with an AbortError and is still recorded', async () => {
    const calls = routeFetch({ 'GET /a': () => ({ json: { ok: true } }) });
    const ctl = new AbortController();
    ctl.abort();
    await expect(fetch('/a', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('a held request rejects with an AbortError when its signal aborts while it is held', async () => {
    const h = held<RouteAnswer>();
    routeFetch({ 'GET /a': () => h.answer });
    const ctl = new AbortController();
    const pending = fetch('/a', { signal: ctl.signal });
    const outcome = pending.then(() => 'answered', (e: Error) => e.name);
    ctl.abort();
    expect(await outcome).toBe('AbortError');
  });

  it('a request whose signal never aborts is answered, and one with no signal too', async () => {
    routeFetch({ 'GET /a': () => ({ json: { ok: true } }) });
    const ctl = new AbortController();
    expect(await (await fetch('/a', { signal: ctl.signal })).json()).toEqual({ ok: true });
    expect(await (await fetch('/a')).json()).toEqual({ ok: true });
  });
});
