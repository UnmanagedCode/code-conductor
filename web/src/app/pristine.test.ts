// A pristine conductor in the tab that started it: held in the app store's own
// slot, never in the instance list, until a list read carries it; resolved from
// its URL by the pristine lookup rather than a resume; and announced to the
// server (`pristine_view` / `pristine_leave`) as the session shown changes.
// First: the anchor writes must not resync the route through a hashchange a browser never fires.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeFetch } from '@/test/routeFetch';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
});

type Inst = { id: string; sessionId: string; project: string; status: string; mode: string; pristine?: boolean; title?: string | null };
const conductor = (id: string, sessionId: string, extra: Partial<Inst> = {}): Inst =>
  ({ id, sessionId, project: '.conduct', status: 'idle', mode: 'bypassPermissions', ...extra });
const P = conductor('iP', 's-p', { pristine: true });
const P2 = conductor('iP2', 's-p2', { pristine: true });
const Q = conductor('iQ', 's-q');
const R = conductor('iR', 's-r');

/** What GET /api/instances answers. */
let listed: Inst[];
/** What GET /api/sessions/<sid>/pristine answers per session; a miss is a 404. */
let lookup: Record<string, Inst>;
let stop: (() => void) | null = null;

async function boot() {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget; sent: [string, any][] };
  ws.sent.length = 0;
  const calls = routeFetch({
    'GET /api/instances': () => ({ json: listed }),
    'GET /api/sessions/': (_body, url) => {
      const [, , , sid, tail] = url.split('/');
      const hit = tail === 'pristine' ? lookup[decodeURIComponent(sid)] : undefined;
      return hit ? { json: hit } : { status: 404, json: { error: 'not found' } };
    },
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  const views = await import('@/features/views/api');
  c.startController();
  stop = c.stopController;
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const frame = async (t: string, detail: Record<string, unknown> = {}) => { ws.bus.dispatchEvent(new CustomEvent(t, { detail })); await flush(); };
  return {
    c, appStore, views, calls, flush,
    open: () => frame('open'),
    hint: () => frame('instances'),
    status: (detail: Record<string, unknown>) => frame('status', detail),
    /** Every presence frame sent, in order. */
    presence: () => ws.sent.filter(([t]) => t.startsWith('pristine_')),
    sent: () => ws.sent,
    listedIds: () => appStore.get().instances.map((i) => i.id),
    active: () => c.getActiveInstance()?.id ?? null,
  };
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  listed = [];
  lookup = {};
});
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); });

describe('the pristine slot', () => {
  it('(a) an adopted pristine conductor is held outside the instance list and is still the active session, across a list landing', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(R as any);
    expect(b.listedIds(), 'control: an adopted non-pristine instance joins the list').toContain('iR');
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    expect(b.listedIds()).not.toContain('iP');
    expect(b.active()).toBe('iP');
    listed = [Q];
    await b.hint();
    expect(b.listedIds()).toEqual(['iQ']);
    expect(b.active()).toBe('iP');
  });

  it('(b) a list that carries it clears the slot, and it stays active from the list', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    listed = [{ ...P, title: 'a draft' }];
    await b.hint();
    expect(b.appStore.get().pristine).toBeNull();
    expect(b.listedIds()).toEqual(['iP']);
    expect(b.active()).toBe('iP');
  });

  it('(c) its exit clears the slot', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    await b.status({ id: 'iP', status: 'exited', mode: 'bypassPermissions', sessionId: 's-p' });
    expect(b.appStore.get().pristine).toBeNull();
  });

  it('(f) a reconnect re-validates the slot: a 404 clears it and the active session it was', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    expect(b.active(), 'control: P is active').toBe('iP');
    await b.open();
    expect(b.appStore.get().activeId).toBeNull();
    expect(b.appStore.get().pristine).toBeNull();
    expect(b.calls.some((x) => x.url === '/api/sessions/s-p/pristine'), 'by the pristine lookup').toBe(true);
  });
});

describe('presence', () => {
  it('(d) selecting another session sends a view for the pristine conductor, then a leave', async () => {
    listed = [Q];
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    b.c.selectInstance('iQ', { userGesture: true });
    expect(b.presence()).toEqual([['pristine_view', { id: 'iP' }], ['pristine_leave', { id: 'iP' }]]);
  });

  it('(d) opening a full-page view leaves it too', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    b.views.openSettings();
    expect(b.presence()).toEqual([['pristine_view', { id: 'iP' }], ['pristine_leave', { id: 'iP' }]]);
  });

  it('(g) starting a second conductor over the first leaves the first and views the second, and the slot holds the second', async () => {
    const b = await boot();
    await b.open();
    b.c.adoptInstance(P as any);
    b.c.selectInstance('iP', { userGesture: true });
    b.c.adoptInstance(P2 as any);
    b.c.selectInstance('iP2', { userGesture: true });
    expect(b.presence()).toEqual([
      ['pristine_view', { id: 'iP' }],
      ['pristine_leave', { id: 'iP' }],
      ['pristine_view', { id: 'iP2' }],
    ]);
    expect(b.appStore.get().pristine?.id).toBe('iP2');
  });
});

describe('opening its URL', () => {
  it('(e) the anchor of an unlisted pristine conductor resolves through the pristine lookup, never a resume', async () => {
    history.replaceState(null, '', '/#session=s-p');
    lookup = { 's-p': P };
    const b = await boot();
    await b.open();
    expect(b.calls.some((x) => x.url.endsWith('/locate')), 'no locate (the resume path) is requested').toBe(false);
    expect(b.active()).toBe('iP');
    expect(b.sent()).toContainEqual(['subscribe', { id: 'iP' }]);
    expect(b.listedIds()).not.toContain('iP');
  });
});
