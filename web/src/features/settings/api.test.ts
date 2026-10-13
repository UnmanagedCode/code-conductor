// The Settings fetch helpers on a 2xx whose body is not JSON: each resolves
// `{}`, never apiFetch's null, so a caller can read a field off the answer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, streamAction } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('Settings fetch helpers', () => {
  it('json() resolves {} for a 2xx with no JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const answer = await json<{ ok?: boolean }>('/api/settings/whatever');
    expect(answer).toEqual({});
    expect(answer.ok).toBeUndefined();
  });

  it('streamAction() resolves {} for a non-NDJSON 2xx with no JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    expect(await streamAction('/api/settings/whatever', () => {}, 'POST', { fetchImpl })).toEqual({});
  });
});
