// Closing the session the URL names: a stop, an archive or its project's delete
// clears the `#session` anchor naming it with a replace, so neither a reload nor
// the first connect's restore resumes it, and Back has no entry added. A close
// is no gesture: one started before it still opens its session. Back/forward
// onto an entry naming a session no longer listed clears that anchor once the
// first instance list has landed.
// First: the anchor's replaceState must not resync the route through a hashchange a browser never fires.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStashedAnchor } from '@/lib/core/anchor.js';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@/lib/core/ws.js', () => {
  const bus = new EventTarget();
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
});
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

type Inst = { id: string; sessionId: string; project: string; status: string; mode: string };
const inst = (id: string, sessionId: string): Inst => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
/** The instance the server answers a resume of `sessionId` with. */
const resumed = (sessionId: string): Inst => inst(`i:${sessionId}`, sessionId);
const A = inst('iA', 's-a');
const B = inst('iB', 's-b');
const C = inst('iC', 's-c');
const Y = resumed('s-y');
const ON_DISK: RouteAnswer = { json: { project: 'p', worktreeName: null, archived: false } };

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/** A fresh controller (module state included) over a mocked socket; every GET /api/instances waits on its own deferred. */
async function boot(locate: (sessionId: string) => RouteAnswer | Promise<RouteAnswer> = () => ON_DISK) {
  stop?.();
  vi.resetModules();
  const ws = (await import('@/lib/core/ws.js')) as unknown as { bus: EventTarget };
  const reads: Held[] = [];
  const calls = routeFetch({
    'GET /api/instances/': () => ({ json: {} }),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'POST /api/instances': (body) => ({ json: resumed(body.resume) }),
    'GET /api/sessions/': (_body, url) => locate(decodeURIComponent(url.split('/')[3])),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  const c = await import('./controller');
  const actions = await import('./sessionActions');
  const route = await import('@/state/route');
  const { appStore, activeInstance } = await import('@/state/app');
  c.startController();
  stop = c.stopController;
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const frame = async (t: string) => { ws.bus.dispatchEvent(new CustomEvent(t, { detail: {} })); await flush(); };
  const land = async (n: number, list: Inst[]) => { reads[n - 1].release({ json: list }); await flush(); };
  /** Answers every instance read not answered yet, from the n-th on, with `list`. */
  const landRest = async (from: number, list: Inst[]) => { for (let n = from; n <= reads.length; n++) await land(n, list); };
  return {
    c, actions, route, reads, flush, land, landRest,
    open: () => frame('open'),
    hint: () => frame('instances'),
    /** Connects and lands the first connect's list. */
    connected: async (list: Inst[]) => { await frame('open'); await land(1, list); },
    stopIdle: (i: Inst) => actions.stopSession({ projectName: 'p', instanceId: i.id, sessionId: i.sessionId, status: 'idle' }),
    active: () => activeInstance(appStore.get())?.id ?? null,
    locates: () => calls.filter((x) => x.url.endsWith('/locate')).length,
    posts: () => calls.filter((x) => x.method === 'POST' && x.url === '/api/instances').length,
  };
}

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); consumeStashedAnchor(); });

describe('closing the session the anchor names', () => {
  it('stopping the active session clears the anchor naming it with a replace, adding no history entry', async () => {
    const b = await boot();
    await b.connected([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    expect(location.hash, 'fixture check: the pick wrote its anchor').toBe('#session=s-c');
    const entries = history.length;
    const stopped = b.stopIdle(C);
    await b.flush();
    await b.landRest(2, [A]);
    await stopped;
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('');
    expect(b.route.routeStore.get().route.sessionId).toBeNull();
    expect(history.length).toBe(entries);
  });

  it('archiving the active session clears the anchor naming it with a replace, adding no history entry', async () => {
    const b = await boot();
    await b.connected([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    const entries = history.length;
    const archived = b.actions.archiveSession({ projectName: 'p', sessionId: 's-c' });
    await b.flush();
    await b.landRest(2, [A]);
    await archived;
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('');
    expect(history.length).toBe(entries);
  });

  it('deleting the active session\'s project clears the anchor naming it with a replace, adding no history entry', async () => {
    const b = await boot();
    await b.connected([C]);
    b.c.selectInstance('iC', { userGesture: true });
    const entries = history.length;
    const deleted = b.actions.performProjectDelete({ name: 'p', deleteDirectory: false });
    await b.flush();
    await b.landRest(2, []);
    await deleted;
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('');
    expect(history.length).toBe(entries);
  });

  it('a session picked before the first connect\'s restore starts and then stopped is not resumed when the first list lands, and nothing is selected', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    await b.hint();
    await b.land(2, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    const stopped = b.stopIdle(B);
    await b.flush();
    expect(b.reads, 'fixture check: the first connect\'s read is still held behind the stop\'s').toHaveLength(3);
    await b.land(3, [A]);
    await stopped;
    await b.land(1, [A]);
    expect(b.locates()).toBe(0);
    expect(b.posts()).toBe(0);
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('');
  });

  it('a notification click started before the active session is stopped still opens its session when it lands', async () => {
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.connected([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    const stopped = b.stopIdle(C);
    await b.flush();
    await b.landRest(2, [A]);
    await stopped;
    expect(b.active(), 'fixture check: the stop closed the active session').toBeNull();
    lookup.release(ON_DISK);
    await b.flush();
    await b.landRest(3, [A, Y]);
    await click;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('stopping the active session while a full-page view is open leaves that view\'s hash and history entry alone', async () => {
    const b = await boot();
    await b.connected([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    b.route.openView('#settings');
    const state = history.state;
    expect(state, 'fixture check: the view was pushed as one of the app\'s view entries').not.toBeNull();
    const stopped = b.stopIdle(C);
    await b.flush();
    await b.landRest(2, [A]);
    await stopped;
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('#settings');
    expect(history.state).toEqual(state);
  });

  it('stopping a session that is not the active one leaves the active session\'s anchor alone', async () => {
    const b = await boot();
    await b.connected([A, C]);
    b.c.selectInstance('iC', { userGesture: true });
    const stopped = b.stopIdle(A);
    await b.flush();
    await b.landRest(2, [C]);
    await stopped;
    expect(b.active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });
});

describe('Back onto an entry naming a session that is not listed', () => {
  it('Back onto an entry naming a session no longer listed, with nothing selected, clears that anchor with a replace and resumes nothing', async () => {
    history.replaceState(null, '', '/#session=s-c');
    history.pushState(null, '', '/');
    const b = await boot();
    await b.connected([A]);
    expect(b.active(), 'fixture check: the current entry names no session, so nothing was restored').toBeNull();
    history.back();
    await b.flush();
    expect(location.hash).toBe('');
    expect(b.route.routeStore.get().route.sessionId).toBeNull();
    expect(b.active()).toBeNull();
    expect(b.locates()).toBe(0);
    expect(b.posts()).toBe(0);
  });

  it('Back onto an entry naming the listed session already shown leaves its anchor intact and adds no history entry', async () => {
    const b = await boot();
    await b.connected([A]);
    b.c.selectInstance('iA', { push: true });
    b.c.selectInstance('iA', { push: true });
    const entries = history.length;
    history.back();
    await b.flush();
    expect(b.active(), 'fixture check: Back landed on the session already shown').toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(history.length).toBe(entries);
  });

  it('Back onto an unlisted entry before the first instance list has landed leaves it to the first connect\'s restore', async () => {
    // Only the first applied list opens the gate, whoever's read it is: a Back made after a hint's list landed but
    // before the first connect's restore runs may clear its entry's anchor, since that Back is the user's own navigation.
    history.replaceState(null, '', '/#session=s-a');
    history.pushState(null, '', '/');
    const b = await boot();
    await b.open();
    history.back();
    await b.flush();
    expect(location.hash, 'fixture check: Back reached the entry naming the session').toBe('#session=s-a');
    await b.land(1, [A]);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
  });

  it('Back onto an unlisted entry before a restarted controller\'s first instance list has landed leaves it to that controller\'s restore', async () => {
    const b = await boot();
    await b.connected([A]);
    history.replaceState(null, '', '/#session=s-x');
    history.pushState(null, '', '/');
    b.c.stopController();
    b.c.startController();
    await b.open();
    history.back();
    await b.flush();
    expect(location.hash).toBe('#session=s-x');
    await b.land(2, [A]);
    expect(b.posts(), 'fixture check: the restore resumed the session its entry names').toBe(1);
    await b.landRest(3, [A, resumed('s-x')]);
    expect(b.active()).toBe(resumed('s-x').id);
    expect(location.hash).toBe('#session=s-x');
  });
});
