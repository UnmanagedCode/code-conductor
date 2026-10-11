import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('viewed marker install with unusable storage', () => {
  it('survives a throwing storage and still marks a seen turn', async () => {
    // Invariant: a storage that throws (private mode) never stops the marker from installing or posting.
    vi.resetModules();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    const posts: [string, number][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      posts.push([decodeURIComponent(url.split('/')[3]), JSON.parse(String(init.body)).seq]);
      return { ok: true, json: async () => ({ ok: true }) };
    }));
    const { appStore } = await import('@/state/app');
    const events = await import('./events');
    const { startViewedMarker } = await import('./viewedMarker');
    appStore.set({
      instances: [{ id: 'A', project: 'p', sessionId: 'sa', status: 'idle', mode: 'x', turnEndSeq: 7, viewedSeq: 1 }] as any,
      activeId: 'A',
    });
    expect(() => startViewedMarker()).not.toThrow();
    events.emit('instances');
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([['sa', 7]]);
  });
});
