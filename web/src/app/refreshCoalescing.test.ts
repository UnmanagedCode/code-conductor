// The list refreshers (refreshProjects, refreshInstances) coalesce: one read in
// flight plus at most one trailing read, however many calls arrive. A call's
// promise resolves only after a read that STARTED AFTER that call has landed,
// so a change that lands while a read is in flight is never lost. A hint burst
// (the server fans out `projects`/`instances` on every status flip) therefore
// costs two reads, not one per hint.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  return { bus, connect: vi.fn(), send: vi.fn() };
});

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/** A fresh controller (the coalescer is module state); every GET of the list under test waits on its own deferred. */
async function boot() {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget };
  const projectReads: Held[] = [];
  const instanceReads: Held[] = [];
  const calls = routeFetch({
    'GET /api/projects/.conduct/sessions': () => ({ json: [] }),
    'GET /api/projects': () => { const h = held<RouteAnswer>(); projectReads.push(h); return h.answer; },
    'GET /api/instances': () => { const h = held<RouteAnswer>(); instanceReads.push(h); return h.answer; },
  });
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  c.startController();
  stop = c.stopController;
  const count = (url: string) => calls.filter((x) => x.method === 'GET' && x.url === url).length;
  const settled = (p: Promise<void>) => {
    const s = { done: false, error: null as unknown };
    p.then(() => { s.done = true; }, (e) => { s.done = true; s.error = e; });
    return s;
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const signalOf = (url: string) => calls.find((x) => x.method === 'GET' && x.url === url)?.signal;
  return { c, appStore, bus: ws.bus, projectReads, instanceReads, count, settled, flush, signalOf };
}

afterEach(() => { stop?.(); stop = null; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('coalesced list reads', () => {
  it('a burst of refreshes costs one read in flight and one trailing read, and every caller resolves after the trailing one', async () => {
    const b = await boot();
    const first = b.settled(b.c.refreshProjects());
    const rest = [b.c.refreshProjects(), b.c.refreshProjects(), b.c.refreshProjects()].map(b.settled);
    await b.flush();
    expect(b.count('/api/projects'), 'three more calls while A is in flight start no read').toBe(1);
    b.projectReads[0].release({ json: [] });
    await vi.waitFor(() => expect(b.count('/api/projects'), 'one trailing read for all three').toBe(2));
    await b.flush();
    expect(first.done).toBe(true);
    expect(rest.map((s) => s.done), 'the trailing callers wait for the trailing read').toEqual([false, false, false]);
    b.projectReads[1].release({ json: [] });
    await vi.waitFor(() => expect(rest.map((s) => s.done)).toEqual([true, true, true]));
    expect(b.count('/api/projects')).toBe(2);
  });

  it('a call made while a read is in flight resolves only after a read that started after the call, whose list the store then holds', async () => {
    const b = await boot();
    b.c.refreshProjects().catch(() => {});
    const second = b.settled(b.c.refreshProjects());
    await vi.waitFor(() => expect(b.projectReads).toHaveLength(1));
    b.projectReads[0].release({ json: [{ name: 'one' }] });
    await vi.waitFor(() => expect(b.appStore.get().projects.map((p: { name: string }) => p.name)).toEqual(['one']));
    await vi.waitFor(() => expect(b.projectReads).toHaveLength(2));
    await b.flush();
    expect(second.done, 'handed the in-flight read\'s promise, it would be done here').toBe(false);
    b.projectReads[1].release({ json: [{ name: 'two' }] });
    await vi.waitFor(() => expect(second.done).toBe(true));
    expect(b.appStore.get().projects.map((p: { name: string }) => p.name)).toEqual(['two']);
  });

  it('a burst of `instances` hints is one read in flight plus one trailing read', async () => {
    const b = await boot();
    for (let i = 0; i < 4; i++) b.bus.dispatchEvent(new CustomEvent('instances'));
    await b.flush();
    expect(b.count('/api/instances')).toBe(1);
    b.instanceReads[0].release({ json: [] });
    await vi.waitFor(() => expect(b.count('/api/instances')).toBe(2));
    b.instanceReads[1].release({ json: [] });
    await b.flush();
    expect(b.count('/api/instances')).toBe(2);
  });

  it('a failed in-flight read rejects its caller and the trailing read still runs for the next', async () => {
    const b = await boot();
    const first = b.settled(b.c.refreshInstances());
    const second = b.settled(b.c.refreshInstances());
    await vi.waitFor(() => expect(b.instanceReads).toHaveLength(1));
    b.instanceReads[0].release(new Error('boom'));
    await vi.waitFor(() => expect(first.error).toBeInstanceOf(Error));
    await vi.waitFor(() => expect(b.instanceReads, 'the trailing read starts after the failure').toHaveLength(2));
    b.instanceReads[1].release({ json: [{ id: 'i1', sessionId: 's1' }] });
    await vi.waitFor(() => expect(second.done).toBe(true));
    expect(second.error).toBeNull();
    expect(b.appStore.get().instances.map((i) => i.id)).toEqual(['i1']);
  });

  it('a failed trailing read rejects every caller waiting on it, and the next call starts a fresh read', async () => {
    const b = await boot();
    b.c.refreshInstances().catch(() => {});
    const waiting = [b.c.refreshInstances(), b.c.refreshInstances()].map(b.settled);
    await vi.waitFor(() => expect(b.instanceReads).toHaveLength(1));
    b.instanceReads[0].release({ json: [] });
    await vi.waitFor(() => expect(b.instanceReads).toHaveLength(2));
    b.instanceReads[1].release(new Error('boom'));
    await vi.waitFor(() => expect(waiting.map((s) => s.error instanceof Error)).toEqual([true, true]));
    const next = b.settled(b.c.refreshInstances());
    await vi.waitFor(() => expect(b.instanceReads, 'no read is left in flight to join').toHaveLength(3));
    b.instanceReads[2].release({ json: [{ id: 'i2', sessionId: 's2' }] });
    await vi.waitFor(() => expect(next.done).toBe(true));
    expect(b.appStore.get().instances.map((i) => i.id)).toEqual(['i2']);
  });
});

describe('a read that never settles', () => {
  it('times out: its callers reject like a failed read, its fetch is aborted, and the trailing read runs', async () => {
    const b = await boot();
    vi.useFakeTimers();
    const first = b.settled(b.c.refreshInstances());
    const second = b.settled(b.c.refreshInstances());
    await vi.advanceTimersByTimeAsync(0);
    expect(b.instanceReads, 'fixture check: the first read is in flight, the second call waits').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(b.c.READ_TIMEOUT_MS);
    expect(first.error, 'the hung read\'s caller is rejected, as for a failed read').toBeInstanceOf(Error);
    expect(b.signalOf('/api/instances')?.aborted, 'the hung request is cancelled').toBe(true);
    expect(b.instanceReads, 'the trailing read starts after the timeout').toHaveLength(2);
    b.instanceReads[1].release({ json: [{ id: 'i1', sessionId: 's1' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.done).toBe(true);
    expect(second.error).toBeNull();
    expect(b.appStore.get().instances.map((i) => i.id)).toEqual(['i1']);
  });

  it('applies nothing if it answers after its timeout', async () => {
    const b = await boot();
    vi.useFakeTimers();
    const first = b.settled(b.c.refreshInstances());
    await vi.advanceTimersByTimeAsync(b.c.READ_TIMEOUT_MS);
    expect(first.error).toBeInstanceOf(Error);
    b.instanceReads[0].release({ json: [{ id: 'late', sessionId: 'sl' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.appStore.get().instances).toEqual([]);
  });

  it('leaves the next hint a fresh read of its own', async () => {
    const b = await boot();
    vi.useFakeTimers();
    b.c.refreshInstances().catch(() => {});
    await vi.advanceTimersByTimeAsync(b.c.READ_TIMEOUT_MS);
    b.bus.dispatchEvent(new CustomEvent('instances'));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.instanceReads, 'no hung read is left to queue behind').toHaveLength(2);
    b.instanceReads[1].release({ json: [{ id: 'i2', sessionId: 's2' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.appStore.get().instances.map((i) => i.id)).toEqual(['i2']);
  });

  it('leaves no timer running once a read has landed', async () => {
    const b = await boot();
    vi.useFakeTimers();
    const p = b.settled(b.c.refreshInstances());
    await vi.advanceTimersByTimeAsync(0);
    b.instanceReads[0].release({ json: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
