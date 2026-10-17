import { afterEach, describe, expect, it, vi } from 'vitest';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

async function boot(instances: any[], activeId: string | null, { failFirst = false } = {}) {
  vi.resetModules();
  const posts: [string, number][] = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    n++;
    if (failFirst && n === 1) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    posts.push([decodeURIComponent(url.split('/')[3]), JSON.parse(String(init.body)).seq]);
    return { ok: true, json: async () => ({ ok: true }) };
  }));
  const { appStore } = await import('@/state/app');
  const events = await import('./events');
  const route = await import('@/state/route');
  const { startViewedMarker } = await import('./viewedMarker');
  appStore.set({ instances, activeId });
  startViewedMarker();
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { posts, appStore, events, route, settle };
}

afterEach(() => {
  visibility = 'visible';
  history.replaceState(null, '', '/');
});

const inst = (extra: object) => ({ id: 'A', project: 'p', sessionId: 'sa', status: 'idle', mode: 'x', turnEndSeq: 5, viewedSeq: 2, ...extra });

describe('viewed marker', () => {
  it('a visible active session with an unseen turn end posts its turnEndSeq, once per seq', async () => {
    const b = await boot([inst({})], 'A');
    b.events.emit('instances');
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([['sa', 5]]);
    b.appStore.set({ instances: [inst({ turnEndSeq: 6 })] });
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([['sa', 5], ['sa', 6]]);
  });

  it('a hidden document posts nothing until it becomes visible', async () => {
    visibility = 'hidden';
    const b = await boot([inst({})], 'A');
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([]);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await b.settle();
    expect(b.posts).toEqual([['sa', 5]]);
  });

  it('a full-page view posts nothing until it closes back to the session', async () => {
    history.replaceState(null, '', '/#settings');
    const b = await boot([inst({})], 'A');
    b.route.syncRoute();
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([]);
    history.replaceState(null, '', '/#session=sa');
    b.route.syncRoute();
    await b.settle();
    expect(b.posts).toEqual([['sa', 5]]);
  });

  it('a rejected POST is retried on the next check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await boot([inst({})], 'A', { failFirst: true });
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith('viewedMarker: marking sa viewed at 5 failed: boom');
    b.events.emit('instances');
    await b.settle();
    expect(b.posts).toEqual([['sa', 5]]);
  });

  it('nothing posts for an inactive session, a seen one, or one without a sessionId', async () => {
    const b = await boot([inst({}), inst({ id: 'B', sessionId: 'sb' })], 'B');
    b.appStore.set({ instances: [inst({}), inst({ id: 'B', sessionId: 'sb', turnEndSeq: 2 })] });
    b.events.emit('instances');
    const c = await boot([inst({ sessionId: null })], 'A');
    c.events.emit('instances');
    await c.settle();
    expect([...b.posts, ...c.posts]).toEqual([]);
  });

  it('removes the legacy unread key', async () => {
    localStorage.setItem('code-conductor:unread', '{}');
    await boot([], null);
    expect(localStorage.getItem('code-conductor:unread')).toBeNull();
  });
});
