// The first connect's restore of the session the URL names, under every order
// the instance list, the server's `instances` hints and the anchor lookup can
// answer in: the named session opens whenever it is live or resumable, a stale
// list never overwrites a newer one, an unknown session lands on the home
// screen with nothing re-read, a session the user picks meanwhile stands, and a
// notification clicked meanwhile opens its own session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStashedAnchor, stashCurrentAnchorForRelaunch } from '@/lib/core/anchor.js';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@/lib/core/ws.js', () => {
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
  const ws = (await import('@/lib/core/ws.js')) as unknown as { bus: EventTarget; sent: [string, unknown][] };
  ws.sent.length = 0;
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
  it('the first list read landing before a hint\'s newer read still opens the named session, and the newer list then applies', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    await b.hint();
    expect(b.reads, 'fixture check: the hint started a second read while the first was in flight').toHaveLength(2);
    await b.land(1, [A]);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.subscribes()).toEqual(['iA']);
    expect(b.locates()).toBe(0);
    await b.land(2, [A, B]);
    expect(b.ids()).toEqual(['iA', 'iB']);
    expect(b.active()).toBe('iA');
  });

  it('a hint\'s newer read landing before the first list read opens the named session, and the older read never overwrites it', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    await b.hint();
    await b.land(2, [A, B]);
    await b.land(1, [A]);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.ids()).toEqual(['iA', 'iB']);
  });

  it('a hint arriving before the first connect reads the list: the newer list opens the session and the older one landing last never overwrites it', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.hint();
    await b.open();
    expect(b.reads, 'fixture check: the hint\'s read, then the first connect\'s').toHaveLength(2);
    await b.land(2, [A, B]);
    await b.land(1, []);
    expect(b.active()).toBe('iA');
    expect(b.ids()).toEqual(['iA', 'iB']);
  });

  it('with three list reads in flight, the oldest landing first never drops the first connect\'s newer read, which opens the named session, and the newest still applies after it', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.hint();
    await b.open();
    await b.hint();
    expect(b.reads, 'fixture check: a hint\'s read, the first connect\'s, then a second hint\'s, all in flight').toHaveLength(3);
    await b.land(1, [B]);
    expect(b.ids(), 'fixture check: the oldest read, landing first, applied').toEqual(['iB']);
    // Invariant: a read is dropped only when a newer read has landed, not merely started, so the first connect's await resolves on its own list.
    await b.land(2, [A]);
    expect(b.ids()).toEqual(['iA']);
    expect(b.active()).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
    expect(b.locates()).toBe(0);
    await b.land(3, [A, B]);
    expect(b.ids()).toEqual(['iA', 'iB']);
    expect(b.active()).toBe('iA');
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

  it('a session the user picks before the first list read lands stands, and the transcript already arriving for it is kept; the named one is never selected', async () => {
    history.replaceState(null, '', '/#session=s-a');
    const b = await boot();
    await b.open();
    await b.hint();
    await b.land(2, [A, B]);
    b.c.selectInstance('iB', { userGesture: true });
    await b.frame('snapshot', { id: 'iB', events: [{ kind: 'user_echo', text: 'hi', userIndex: 0, _seq: 1 }, { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'yo', _seq: 2 }] });
    expect(b.items(), 'fixture check: the pick\'s transcript arrived').toEqual(['user', 'assistant']);
    await b.land(1, [A, B]);
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
