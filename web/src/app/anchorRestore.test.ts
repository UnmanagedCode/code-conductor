// The first connect's restore of the session the URL names, under every order
// the instance list, the server's `instances` hints and the anchor lookup can
// answer in: the named session opens whenever it is live or resumable, a hint's
// read starts only after the read in flight has landed, an unknown session
// lands on the home screen with nothing re-read, a session the user picks or
// Back returns to meanwhile stands, and a notification clicked meanwhile opens
// its own session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStashedAnchor, stashCurrentAnchorForRelaunch } from '@shared/anchor';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import type { Instance, Project } from '@/state/types';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
});

const inst = (id: string, sessionId: string) => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
/** The instance the server answers a resume of `sessionId` with. */
const resumed = (sessionId: string) => inst(`i:${sessionId}`, sessionId);
const A = inst('iA', 's-a');
const B = inst('iB', 's-b');
const D = resumed('s-disk');
const X = resumed('s-x');
const Y = resumed('s-y');
const MISS: RouteAnswer = { status: 404, json: {} };
const ON_DISK: RouteAnswer = { json: { project: 'p', worktreeName: null, archived: false } };

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/** A fresh controller (module state included) over a mocked socket; every GET /api/instances waits on its own deferred. */
async function boot(locate: (sessionId: string) => RouteAnswer | Promise<RouteAnswer> = () => MISS) {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget; sent: [string, unknown][] };
  ws.sent.length = 0;
  const reads: Held[] = [];
  const calls = routeFetch({
    'GET /api/instances/': () => ({ json: {} }),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'POST /api/instances': (body) => ({ json: resumed(body.resume) }),
    // No session here is a pristine conductor: its lookup (tried before locate) misses.
    'GET /api/sessions/': (_body, url) => (url.endsWith('/pristine') ? { status: 404, json: {} } : locate(decodeURIComponent(url.split('/')[3]))),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  const c = await import('./controller');
  const { appStore, activeInstance } = await import('@/state/app');
  c.startController();
  stop = c.stopController;
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const frame = async (t: string, detail: object = {}) => { ws.bus.dispatchEvent(new CustomEvent(t, { detail })); await flush(); };
  return {
    c, appStore, calls, reads, flush, frame,
    open: () => frame('open'),
    hint: () => frame('instances'),
    /** Answers the n-th instance read (1-based) with `list`, then lets everything it unblocks run. */
    land: async (n: number, list: unknown[]) => { reads[n - 1].release({ json: list }); await flush(); },
    /** Answers every instance read not answered yet with `list`. */
    landRest: async (from: number, list: unknown[]) => { for (let n = from; n <= reads.length; n++) { reads[n - 1].release({ json: list }); await flush(); } },
    active: () => activeInstance(appStore.get())?.id ?? null,
    ids: () => appStore.get().instances.map((i) => i.id),
    items: () => c.conversation.items.map((i) => i.type),
    locates: () => calls.filter((x) => x.url.endsWith('/locate')).length,
    posts: () => calls.filter((x) => x.method === 'POST' && x.url === '/api/instances').length,
    subscribes: () => ws.sent.filter(([t]) => t === 'subscribe').map(([, p]) => (p as { id: string }).id),
  };
}

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); consumeStashedAnchor(); });

describe('restoring the URL-named session on first connect', () => {
  it('a hint\'s read waits behind the first list read, which opens the named session; the trailing list then applies', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    await b.hint();
    expect(b.reads, 'fixture check: the hint started no read while the first was in flight').toHaveLength(1);
    await b.land(1, [A]);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.subscribes()).toEqual(['iA']);
    expect(b.locates()).toBe(0);
    expect(b.reads, 'the hint\'s trailing read started once the first landed').toHaveLength(2);
    await b.land(2, [A, B]);
    expect(b.ids()).toEqual(['iA', 'iB']);
    expect(b.active()).toBe('iA');
  });

  it('a hint arriving before the first connect: the connect waits for a read that started after it, so the older list never decides the restore', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.hint();
    await b.open();
    expect(b.reads, 'fixture check: the hint\'s read is in flight and the connect\'s waits behind it').toHaveLength(1);
    await b.land(1, []);
    expect(b.active(), 'the older, empty list does not judge the anchor').toBeNull();
    expect(b.locates()).toBe(0);
    expect(location.hash).toBe('#session=s-a');
    expect(b.reads).toHaveLength(2);
    await b.land(2, [A, B]);
    expect(b.active()).toBe('iA');
    expect(b.ids()).toEqual(['iA', 'iB']);
  });

  it('a hint, the first connect and a second hint share one trailing read: the oldest list landing first does not resolve the connect, and the trailing list opens the named session', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.hint();
    await b.open();
    await b.hint();
    expect(b.reads, 'fixture check: one read in flight, the connect and the second hint wait on one trailing read').toHaveLength(1);
    await b.land(1, [B]);
    expect(b.ids(), 'fixture check: the oldest read, landing first, applied').toEqual(['iB']);
    expect(b.active(), 'the connect has not restored from the older list').toBeNull();
    expect(b.locates()).toBe(0);
    expect(b.reads).toHaveLength(2);
    await b.land(2, [A]);
    expect(b.ids()).toEqual(['iA']);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.locates()).toBe(0);
    expect(b.reads, 'nothing else was read').toHaveLength(2);
  });

  it('an unknown session id lands on the home screen with the anchor cleared, looked up once and nothing re-read', async () => {
    history.replaceState(null, '', '/#session=s-gone');
    const b = await boot();
    await b.open();
    await b.hint();
    await b.land(1, [A, B]);
    await b.land(2, [A, B]);
    await b.flush();
    expect(b.active()).toBeNull();
    expect(location.hash).toBe('');
    expect(b.locates()).toBe(1);
    expect(b.reads).toHaveLength(2);
  });

  it('a session the user picks before the first connect\'s own list read lands stands, and the transcript already arriving for it is kept; the named one is never selected', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.hint();
    await b.open();
    await b.land(1, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.frame('snapshot', { id: 'iB', events: [{ kind: 'user_echo', text: 'hi', userIndex: 0, _seq: 1 }, { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'yo', _seq: 2 }] });
    expect(b.items(), 'fixture check: the pick\'s transcript arrived').toEqual(['user', 'assistant']);
    await b.land(2, [A, B]);
    expect(b.active()).toBe('iB');
    expect(location.hash).toBe('#session=s-b');
    expect(b.items()).toEqual(['user', 'assistant']);
    expect(b.subscribes()).not.toContain('iA');
  });

  it('a session the user picks while the named one is looked up stands, with its anchor, when the lookup misses', async () => {
    history.replaceState(null, '', '/#session=s-x');
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.open();
    await b.land(1, [A, B]);
    expect(b.locates(), 'fixture check: the unlisted anchor is being looked up').toBe(1);
    b.c.selectInstance('iB', { userGesture: true });
    lookup.release(MISS);
    await b.flush();
    expect(location.hash).toBe('#session=s-b');
    expect(b.active()).toBe('iB');
    expect(b.subscribes()).toEqual(['iB']);
  });

  it('a session the user picks while the named one is looked up stands, with its anchor, when the lookup finds it archived', async () => {
    history.replaceState(null, '', '/#session=s-old');
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.open();
    await b.land(1, [A, B]);
    expect(b.locates(), 'fixture check: the unlisted anchor is being looked up').toBe(1);
    b.c.selectInstance('iB', { userGesture: true });
    lookup.release({ json: { project: 'p', worktreeName: null, archived: true } });
    await b.flush();
    expect(location.hash).toBe('#session=s-b');
    expect(b.active()).toBe('iB');
  });

  it('a session the user picks while the named one is looked up stands, and the named one is not resumed, when the lookup finds it on disk', async () => {
    history.replaceState(null, '', '/#session=s-disk');
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.open();
    await b.land(1, [A, B]);
    expect(b.locates(), 'fixture check: the unlisted anchor is being looked up').toBe(1);
    b.c.selectInstance('iB', { userGesture: true });
    lookup.release(ON_DISK);
    await b.flush();
    await b.landRest(2, [A, B, D]);
    expect(b.posts()).toBe(0);
    expect(b.active()).toBe('iB');
    expect(location.hash).toBe('#session=s-b');
  });

  it('a session the user picks while the named one is looked up stands, with its anchor, when the lookup fails', async () => {
    history.replaceState(null, '', '/#session=s-x');
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.open();
    await b.land(1, [A, B]);
    expect(b.locates(), 'fixture check: the unlisted anchor is being looked up').toBe(1);
    b.c.selectInstance('iB', { userGesture: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lookup.release(new Error('offline'));
    await b.flush();
    expect(location.hash).toBe('#session=s-b');
    expect(b.active()).toBe('iB');
    expect(b.subscribes()).toEqual(['iB']);
  });

  it('a session Back returns to while the named one is looked up stands, with its anchor, and the named one is not resumed, when the lookup finds it on disk', async () => {
    history.replaceState(null, '', '/#session=s-b');
    history.pushState(null, '', '/#session=s-disk');
    const ctlLookup = held<RouteAnswer>();
    const ctl = await boot(() => ctlLookup.answer);
    await ctl.open();
    await ctl.land(1, [A, B]);
    ctlLookup.release(ON_DISK);
    await ctl.flush();
    await ctl.landRest(2, [A, B, D]);
    expect(ctl.active(), 'control: the restore alone resumes and opens the named session').toBe(D.id);

    history.replaceState(null, '', '/#session=s-b');
    history.pushState(null, '', '/#session=s-disk');
    const lookup = held<RouteAnswer>();
    const b = await boot(() => lookup.answer);
    await b.open();
    await b.land(1, [A, B]);
    expect(b.locates(), 'fixture check: the unlisted anchor is being looked up').toBe(1);
    history.back();
    await b.flush();
    expect(b.active(), 'fixture check: Back selected the session its entry names').toBe('iB');
    lookup.release(ON_DISK);
    await b.flush();
    await b.landRest(2, [A, B, D]);
    expect(b.posts()).toBe(0);
    expect(b.active()).toBe('iB');
    expect(location.hash).toBe('#session=s-b');
  });

  it('a hash the user changes while the list is loading is the one restored', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    history.replaceState(null, '', '/#session=s-b');
    await b.land(1, [A, B]);
    expect(b.active()).toBe('iB');
    expect(location.hash).toBe('#session=s-b');
  });

  it('a full-page view named on first load stays open; no session is selected or looked up', async () => {
    history.replaceState(null, '', '/#settings');
    const b = await boot();
    await b.open();
    await b.hint();
    await b.land(1, [A, B]);
    await b.land(2, [A, B]);
    expect(location.hash).toBe('#settings');
    expect(b.active()).toBeNull();
    expect(b.locates()).toBe(0);
  });

  it('a stashed session anchor is restored on a plain first load, and under a full-page view it is neither restored nor consumed', async () => {
    history.replaceState(null, '', '/#session=s-a');
    stashCurrentAnchorForRelaunch();
    history.replaceState(null, '', '/');
    const plain = await boot();
    await plain.open();
    await plain.land(1, [A, B]);
    expect(plain.active(), 'control: a plain first load restores the stashed session').toBe('iA');
    expect(consumeStashedAnchor(), 'control: and consumes the stash').toBeNull();

    history.replaceState(null, '', '/#session=s-a');
    stashCurrentAnchorForRelaunch();
    history.replaceState(null, '', '/#settings');
    const b = await boot();
    await b.open();
    await b.land(1, [A, B]);
    expect(location.hash).toBe('#settings');
    expect(b.active()).toBeNull();
    expect(b.locates()).toBe(0);
    expect(consumeStashedAnchor()).toBe('s-a');
  });

  it('a stopped session the URL names is resumed and keeps its anchor when a hint\'s newer read is in flight past the post-resume read', async () => {
    history.replaceState(null, '', '/#session=s-disk');
    const b = await boot(() => ON_DISK);
    await b.open();
    await b.land(1, []);
    expect(b.posts(), 'fixture check: the anchor was resumed').toBe(1);
    expect(b.reads, 'fixture check: the post-resume read is in flight').toHaveLength(2);
    await b.hint();
    await b.land(2, [D]);
    expect(location.hash).toBe('#session=s-disk');
    expect(b.active()).toBe(D.id);
    await b.land(3, [D]);
    expect(b.active()).toBe(D.id);
  });

  it('a notification click whose lookup answers after the first-connect restore has resumed its session still resumes and opens the clicked one, with its anchor', async () => {
    history.replaceState(null, '', '/#session=s-x');
    const lookups: Record<string, Held> = { 's-x': held<RouteAnswer>(), 's-y': held<RouteAnswer>() };
    const b = await boot((sid) => lookups[sid].answer);
    await b.open();
    await b.land(1, [A]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    expect(b.locates(), 'fixture check: the restore and the click are both looking up').toBe(2);
    lookups['s-x'].release(ON_DISK);
    await b.flush();
    await b.land(2, [A, X]);
    expect(b.active(), 'fixture check: the restore resumed and opened its session').toBe(X.id);
    lookups['s-y'].release(ON_DISK);
    await b.flush();
    await b.landRest(3, [A, X, Y]);
    await click;
    expect(b.posts()).toBe(2);
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });

  it('a notification click whose lookup answers first opens the clicked session over the first-connect restore resuming behind it, with its anchor', async () => {
    history.replaceState(null, '', '/#session=s-x');
    const lookups: Record<string, Held> = { 's-x': held<RouteAnswer>(), 's-y': held<RouteAnswer>() };
    const b = await boot((sid) => lookups[sid].answer);
    await b.open();
    await b.land(1, [A]);
    const click = b.c.handleNotificationClick({ sessionId: 's-y' });
    await b.flush();
    expect(b.locates(), 'fixture check: the restore and the click are both looking up').toBe(2);
    lookups['s-y'].release(ON_DISK);
    await b.flush();
    expect(b.posts(), 'fixture check: the click is resuming').toBe(1);
    lookups['s-x'].release(ON_DISK);
    await b.flush();
    expect(b.posts(), 'fixture check: the restore resumed behind it').toBe(2);
    await b.land(2, [A, Y]);
    await b.land(3, [A, X, Y]);
    await click;
    expect(b.active()).toBe(Y.id);
    expect(location.hash).toBe('#session=s-y');
  });
});

describe('a first connect whose list read is refused', () => {
  it('a refused projects read is logged, the last project list is kept, and the named session still opens and is subscribed', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    const kept = [{ name: 'kept-project' }];
    b.appStore.set({ projects: kept as unknown as Project[] });
    routeFetch({
      'GET /api/projects': () => ({ status: 500, json: { error: 'projects read refused' } }),
      'GET /api/workspaces': () => ({ json: [] }),
      'GET /api/conductors/projects': () => ({ json: {} }),
      'GET /api/instances': () => ({ json: [A] }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await b.open();
    expect(warn.mock.calls.map((c) => (c[1] as Error).message)).toEqual(['projects read refused']);
    expect(b.appStore.get().projects).toEqual(kept);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.subscribes()).toEqual(['iA']);
  });

  it('a refused instances read is logged, the last instance list is kept, and the active session is re-subscribed', async () => {
    const b = await boot();
    b.appStore.set({ instances: [A] as Instance[], activeId: 'iA' });
    routeFetch({
      'GET /api/projects': () => ({ json: [] }),
      'GET /api/workspaces': () => ({ json: [] }),
      'GET /api/conductors/projects': () => ({ json: {} }),
      'GET /api/instances': () => ({ status: 503, json: { error: 'instances read refused' } }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await b.open();
    expect(warn.mock.calls.map((c) => (c[1] as Error).message)).toEqual(['instances read refused']);
    expect(b.ids()).toEqual(['iA']);
    expect(b.active()).toBe('iA');
    expect(b.subscribes()).toEqual(['iA']);
  });
});
