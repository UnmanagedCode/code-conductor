// After the socket opens, the active session is subscribed exactly once on it,
// whatever was selected meanwhile: a session picked while the open's list read
// is in flight already subscribed itself, so the open adds none; a session
// picked before the socket opened (its subscribe dropped) and the active session
// across a reconnect are subscribed by the open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStashedAnchor } from '@shared/anchor';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

type Link = { socket: number; open: boolean; answer: ((id: string) => object) | null };

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: [string, unknown, number][] = [];
  const link: Link = { socket: 0, open: false, answer: null };
  bus.addEventListener('open', () => { link.socket += 1; link.open = true; });
  bus.addEventListener('close', () => { link.open = false; });
  // As the real send: a frame sent while the socket is not open is dropped.
  const send = vi.fn((t: string, payload: { id: string }) => {
    if (!link.open) return;
    sent.push([t, payload, link.socket]);
    const answer = link.answer;
    if (t === 'subscribe' && answer) queueMicrotask(() => bus.dispatchEvent(new CustomEvent('snapshot', { detail: answer(payload.id) })));
  });
  return { bus, sent, link, connect: vi.fn(), send };
});

const inst = (id: string, sessionId: string) => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
const A = inst('iA', 's-a');
const B = inst('iB', 's-b');

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/**
 * A fresh controller (module state included) over a mocked socket that is not open yet; every GET /api/instances
 * waits on its own deferred, and with `holdProjects` so does every GET /api/projects.
 */
async function boot({ holdProjects = false } = {}) {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget; sent: [string, unknown, number][]; link: Link };
  ws.sent.length = 0;
  Object.assign(ws.link, { socket: 0, open: false, answer: null });
  const reads: Held[] = [];
  const projectReads: Held[] = [];
  const calls = routeFetch({
    'GET /api/instances/': () => ({ json: { events: [], hasMore: false, nextBefore: null, segment: null } }),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'GET /api/projects/': () => ({ json: [] }),
    'GET /api/projects': () => {
      if (!holdProjects) return { json: [] };
      const h = held<RouteAnswer>(); projectReads.push(h); return h.answer;
    },
    'GET /api/workspaces': () => ({ json: [] }),
  });
  const c = await import('./controller');
  const s = await import('./sessionActions');
  c.startController();
  stop = c.stopController;
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const frame = async (t: string) => { ws.bus.dispatchEvent(new CustomEvent(t)); await flush(); };
  return {
    c, s, ws, reads, flush,
    open: () => frame('open'),
    close: () => frame('close'),
    hint: () => frame('instances'),
    /** Answers the n-th instance read (1-based) with `list`, then lets everything it unblocks run. */
    land: async (n: number, list: unknown[]) => { reads[n - 1].release({ json: list }); await flush(); },
    /** Answers the n-th held projects read (1-based), then lets everything it unblocks run. */
    landProjects: async (n: number) => { projectReads[n - 1].release({ json: [] }); await flush(); },
    /** Each subscribe sent, as `[instance id, socket]`. */
    subscribes: () => ws.sent.filter(([t]) => t === 'subscribe').map(([, p, s]) => [(p as { id: string }).id, s]),
    historyReads: () => calls.filter((x) => x.url.includes('/lineage-events')).length,
  };
}

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); consumeStashedAnchor(); });

describe('subscribing the active session when the socket opens', () => {
  it('a session picked before the first connect\'s own list read lands is subscribed once', async () => {
    const b = await boot();
    await b.hint();
    await b.open();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    expect(b.subscribes(), 'fixture check: the pick subscribed itself').toEqual([['iB', 1]]);
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 1]]);
  });

  it('a session picked before the first connect\'s own list read lands reads its earlier history once', async () => {
    const b = await boot();
    b.ws.link.answer = (id) => ({ id, events: [], tailStartSeq: 0 });
    await b.hint();
    await b.open();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.flush();
    expect(b.historyReads(), 'fixture check: the pick\'s snapshot started at the ring head, so its history was probed').toBe(1);
    await b.land(2, [A, B]);
    expect(b.historyReads()).toBe(1);
  });

  it('a session picked while the socket is still connecting is subscribed once by the first connect', async () => {
    const b = await boot();
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    expect(b.subscribes(), 'fixture check: the pick\'s subscribe was dropped').toEqual([]);
    await b.open();
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 1]]);
  });

  it('a session picked while the socket is still connecting and picked again before the first list read lands is subscribed once', async () => {
    const b = await boot();
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.open();
    b.c.selectInstance('iB', { userGesture: true });
    expect(b.subscribes(), 'fixture check: the re-pick subscribed on the open socket').toEqual([['iB', 1]]);
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 1]]);
  });

  it('the active session is subscribed once more on a reconnect', async () => {
    const b = await boot();
    await b.open();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.close();
    await b.open();
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 1], ['iB', 2]]);
  });

  it('a session picked before a reconnect\'s list read lands is subscribed once on the new socket', async () => {
    const b = await boot();
    await b.open();
    await b.land(1, [A, B]);
    b.c.selectInstance('iA', { userGesture: true });
    await b.close();
    await b.open();
    b.c.selectInstance('iB', { userGesture: true });
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([['iA', 1], ['iB', 2]]);
  });

  it('respawning the active session while the first connect\'s list read is in flight: the open subscribes it once when its read lands, and the respawn once when its own read lands', async () => {
    const b = await boot();
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.open();
    const respawned = b.s.respawnActive();
    await b.flush();
    expect(b.reads, 'fixture check: the respawn\'s read waits behind the first connect\'s').toHaveLength(2);
    await b.land(2, [A, B]);
    expect(b.subscribes(), 'the open added one subscribe').toEqual([['iB', 1]]);
    await b.land(3, [A, B]);
    await respawned;
    expect(b.subscribes(), 'the respawn added one more, and nothing else subscribed').toEqual([['iB', 1], ['iB', 1]]);
  });

  it('a stale open whose list read lands after a newer open sends nothing on the new socket', async () => {
    const b = await boot();
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.open();
    await b.close();
    await b.open();
    await b.land(2, [A, B]);
    expect(b.subscribes()).toEqual([]);
    await b.land(3, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 2]]);
  });

  it('the newer open subscribes the active session once, when the stale open\'s read has landed, and a later list read adds no second subscribe', async () => {
    const b = await boot();
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.open();
    await b.close();
    await b.open();
    await b.land(2, [A, B]);
    expect(b.subscribes(), 'the stale open\'s read landed: nothing is sent').toEqual([]);
    await b.land(3, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 2]]);
    await b.hint();
    await b.land(4, [A, B]);
    expect(b.subscribes()).toEqual([['iB', 2]]);
  });

  it('a stale open whose projects read lands before the newer open\'s sends nothing on the new socket, and the newer open then subscribes once', async () => {
    const b = await boot({ holdProjects: true });
    void b.c.refreshInstances();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.open();
    await b.close();
    await b.open();
    await b.landProjects(1);
    await b.landProjects(2);
    await b.land(2, [A, B]);
    expect(b.subscribes(), 'fixture check: the stale open\'s lists landed, and it sends nothing').toEqual([]);
    await b.land(3, [A, B]);
    expect(b.subscribes(), 'the newer open subscribed the active session once').toEqual([['iB', 2]]);
  });
});
