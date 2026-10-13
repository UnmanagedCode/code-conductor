// Conduct selects the conductor the moment the create answers: the created
// instance goes into the store and is opened before any list read lands, so a
// slow or contended list read cannot delay the session. A list read already in
// flight when the conductor was created predates it and cannot drop it; a
// session the user picks while the create is in flight stands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import type { Instance } from '@/state/types';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Held = ReturnType<typeof held<RouteAnswer>>;

const conductor: Instance = { id: 'c1', sessionId: 's1', project: '.conduct', status: 'starting', mode: 'bypassPermissions' };
const other: Instance = { id: 'o1', sessionId: 's-o', project: 'p', status: 'idle', mode: 'default' };

let pending: Held[] = [];

/** A fresh controller + store; every GET waits on its own deferred, the POST on `post` (answered at once when omitted). */
async function boot({ post }: { post?: Held } = {}) {
  vi.resetModules();
  history.replaceState(null, '', '/');
  pending = [];
  const instanceReads: Held[] = [];
  const calls = routeFetch({
    'GET /api/instances': () => { const h = held<RouteAnswer>(); pending.push(h); instanceReads.push(h); return h.answer; },
    'GET /api/': () => { const h = held<RouteAnswer>(); pending.push(h); return h.answer; },
    'POST /api/instances': () => post?.answer ?? { json: conductor },
  });
  const { startConducting } = await import('./conduct');
  const c = await import('@/app/controller');
  const { appStore, activeInstance } = await import('@/state/app');
  const settled = (p: Promise<void>) => {
    const s = { done: false };
    p.then(() => { s.done = true; }, () => { s.done = true; });
    return s;
  };
  return {
    startConducting, c, appStore, calls, instanceReads, settled,
    active: () => activeInstance(appStore.get())?.id ?? null,
    ids: () => appStore.get().instances.map((i) => i.id),
    gets: (url: string) => calls.filter((x) => x.method === 'GET' && x.url === url).length,
  };
}

beforeEach(() => { pending = []; });
afterEach(async () => {
  // Answer whatever an unfixed build still waits on, so a red run fails at its assertion instead of hanging.
  for (const h of pending) h.release({ json: [] });
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
});

describe('Conduct selects the conductor before any list read lands', () => {
  it('the conductor is open, in the store and anchored while every list read is still held', async () => {
    const b = await boot();
    const done = b.settled(b.startConducting());
    await vi.waitFor(() => expect(done.done, 'startConducting waits on no list read').toBe(true));
    expect(b.active()).toBe('c1');
    expect(b.appStore.get().instances.map((i) => i.id)).toEqual(['c1']);
    expect(location.hash).toBe('#session=s1');
  });

  it('a list read in flight when the conductor is created cannot drop it, and a read after the create replaces it', async () => {
    const b = await boot();
    b.c.refreshInstances().catch(() => {});
    await vi.waitFor(() => expect(b.instanceReads).toHaveLength(1));
    b.startConducting().catch(() => {});
    await vi.waitFor(() => expect(b.active()).toBe('c1'));
    b.instanceReads[0].release({ json: [] });
    await vi.waitFor(() => expect(b.instanceReads, 'a read that starts after the create is requested').toHaveLength(2));
    expect(b.active(), 'the older read answered [] and applied nothing').toBe('c1');
    expect(b.ids()).toEqual(['c1']);
    b.instanceReads[1].release({ json: [{ ...conductor, status: 'idle' }] });
    await vi.waitFor(() => expect(b.appStore.get().instances[0]?.status).toBe('idle'));
    expect(b.active()).toBe('c1');
  });

  it('a session picked while the create is in flight stands: the conductor joins the store but is not opened', async () => {
    const post = held<RouteAnswer>();
    const b = await boot({ post });
    b.appStore.set({ instances: [other], activeId: null });
    const done = b.settled(b.startConducting());
    await vi.waitFor(() => expect(b.calls.some((x) => x.method === 'POST' && x.url === '/api/instances')).toBe(true));
    b.c.selectInstance('o1', { userGesture: true });
    post.release({ json: conductor });
    await vi.waitFor(() => expect(done.done).toBe(true));
    expect(b.ids()).toEqual(['o1', 'c1']);
    expect(b.active()).toBe('o1');
    expect(location.hash).toBe('#session=s-o');
  });

  it('an `instances` subscriber sees the adopted conductor in the store at the moment of adoption', async () => {
    const b = await boot();
    const { on } = await import('@/app/events');
    const seen: string[][] = [];
    on('instances', () => { seen.push(b.ids()); });
    b.c.adoptInstance(conductor);
    expect(seen[0], 'the first `instances` emit comes with the adopted row already stored').toEqual(['c1']);
  });

  it('an `instances` subscriber sees an already-listed instance replaced by the adopted one', async () => {
    const b = await boot();
    const { on } = await import('@/app/events');
    b.appStore.set({ instances: [{ ...conductor, status: 'idle' }] });
    const seen: string[] = [];
    on('instances', () => { seen.push(b.appStore.get().instances[0]?.status ?? ''); });
    b.c.adoptInstance(conductor);
    expect(seen[0]).toBe('starting');
  });
});
