// Focus mode's opener (app/focus.ts, wired by the controller's first connect and
// its popstate handler): a headless-family server names the session on
// GET /api/health, and the client opens it with no gesture — a live session is
// selected, an inactive one opens read-only, nothing is ever POSTed — waiting
// for a live run's root to spawn, yielding to an anchor that resolves, and
// keeping Back from a worker on the focused session.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStashedAnchor } from '@shared/anchor';
import { routeFetch, type RouteAnswer } from '@/test/routeFetch';
import { settle } from '@/test/settle';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
});

const inst = (id: string, sessionId: string) => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
const MISS: RouteAnswer = { status: 404, json: {} };
const ON_DISK: RouteAnswer = { json: { project: 'p', worktreeName: null, archived: false } };
const CAPS = { git: true };
let stop: (() => void) | null = null;

/** A fresh controller over a mocked socket; `health` answers each GET /api/health in turn (the last repeats). */
async function boot({ health, instances = [], url, locate }: { health: (object | Error)[]; instances?: unknown[] | Error; url?: string; locate?: RouteAnswer }) {
  stop?.();
  vi.resetModules();
  if (url) history.replaceState(null, '', url);
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget; sent: [string, unknown][] };
  ws.sent.length = 0;
  let healthReads = 0;
  const calls = routeFetch({
    'GET /api/health': () => {
      const h = health[Math.min(healthReads++, health.length - 1)];
      return h instanceof Error || 'status' in h ? (h as RouteAnswer) : { json: { capabilities: CAPS, ...(h as object) } };
    },
    'GET /api/instances/': () => ({ json: {} }),
    'GET /api/instances': () => (instances instanceof Error ? instances : { json: instances }),
    'POST /api/instances': () => ({ json: {} }),
    'GET /api/sessions/': (_body, url) => (url.endsWith('/pristine') ? MISS
      : locate && !url.includes('/lineage-events') ? locate
      : url.includes('/lineage-events') ? { json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }
      : ON_DISK),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  // The app's startup read (main.tsx).
  (await import('./focus')).readPageFocus();
  void (await import('@shared/capabilities')).loadCapabilities();
  const c = await import('./controller');
  const { appStore, activeInstance } = await import('@/state/app');
  c.startController();
  stop = c.stopController;
  return {
    c, appStore, calls,
    open: async () => { ws.bus.dispatchEvent(new CustomEvent('open', { detail: {} })); await settle(); },
    active: () => activeInstance(appStore.get())?.id ?? null,
    posts: () => calls.filter((x) => x.method === 'POST' && x.url === '/api/instances').length,
    subscribes: () => ws.sent.filter(([t]) => t === 'subscribe').map(([, p]) => (p as { id: string }).id),
  };
}
/** shared/anchor.ts's stash key: the PWA relaunch hand-off. */
const STASH = 'cc:session-stash';
const focusOn = (sessionId: string | null) => ({ focus: { sessionId } });

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { void import('@shared/focus').then((f) => { f.setFocus(null); f.setPageFocus(null); }); stop?.(); stop = null; vi.useRealTimers(); vi.restoreAllMocks(); consumeStashedAnchor(); });

describe('opening the focused session', () => {
  it('an inactive focused session opens read-only, anchored, with no POST', async () => {
    // Invariant: page load in focus mode shows the named session's transcript and never starts a CLI.
    const b = await boot({ health: [focusOn('S')] });
    await b.open();
    expect(b.appStore.get().activeId).toBe('ended:S');
    expect(location.hash).toBe('#session=S');
    expect(b.posts()).toBe(0);
  });

  it('a live focused session is selected and subscribed', async () => {
    // Invariant: a live session is selected as it stands (a subscribe frame goes out), not opened read-only.
    const b = await boot({ health: [focusOn('S')], instances: [inst('iS', 'S')] });
    await b.open();
    expect(b.active()).toBe('iS');
    expect(b.subscribes()).toEqual(['iS']);
    expect(b.posts()).toBe(0);
  });

  it('waits while the server names no session yet, then opens the one it names', async () => {
    // Invariant: a live run's root has not spawned at page load; the client re-reads health every FOCUS_POLL_MS until it names the session.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { FOCUS_POLL_MS } = await import('./focus');
    const b = await boot({ health: [focusOn(null), focusOn(null), focusOn('S')], instances: [inst('iS', 'S')] });
    await b.open();
    expect(b.active(), 'nothing opens while the focus names no session').toBeNull();
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS);
    await settle();
    expect(b.active(), 'still null after the first poll').toBeNull();
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS);
    await settle();
    expect(b.active()).toBe('iS');
  });

  it('stops polling when the controller is stopped', async () => {
    // Invariant: abort ends the wait for the root; no health read follows it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { FOCUS_POLL_MS } = await import('./focus');
    const b = await boot({ health: [focusOn(null)] });
    await b.open();
    const reads = () => b.calls.filter((x) => x.url === '/api/health').length;
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS);
    const before = reads();
    expect(before, 'fixture check: the poll read health').toBeGreaterThan(1);
    stop?.(); stop = null;
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS * 5);
    expect(reads()).toBe(before);
  });

  it('stops polling, warning once, when the server is unreachable', async () => {
    // Invariant: a network failure is terminal for the poll — no read and no warning per tick against a dead server.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { FOCUS_POLL_MS } = await import('./focus');
    const { SERVER_UNREACHABLE_MESSAGE } = await import('@shared/http');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await boot({ health: [focusOn(null), new Error('connection refused')] });
    await b.open();
    const reads = () => b.calls.filter((x) => x.url === '/api/health').length;
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS);
    const failed = reads();
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS * 5);
    expect(reads(), 'no read after the failed one').toBe(failed);
    const focusWarns = warn.mock.calls.filter((c) => String(c[0]).startsWith('focus:'));
    expect(focusWarns).toHaveLength(1);
    expect(String((focusWarns[0][1] as Error).message)).toBe(SERVER_UNREACHABLE_MESSAGE);
    expect(b.appStore.get().activeId).toBeNull();
  });

  it('keeps polling, warning once, while health answers a refusal', async () => {
    // Invariant: a non-network failure (a 500) is retried every FOCUS_POLL_MS, and warned about once, not per tick.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { FOCUS_POLL_MS } = await import('./focus');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await boot({ health: [focusOn(null), { status: 500, json: { error: 'boom' } }] });
    await b.open();
    const reads = () => b.calls.filter((x) => x.url === '/api/health').length;
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS);
    const first = reads();
    await vi.advanceTimersByTimeAsync(FOCUS_POLL_MS * 4);
    expect(reads(), 'health reads keep growing').toBeGreaterThan(first + 2);
    const focusWarns = warn.mock.calls.filter((c) => String(c[0]).startsWith('focus:'));
    expect(focusWarns).toHaveLength(1);
    expect(String((focusWarns[0][1] as Error).message)).toContain('boom');
  });

  it('a failed instances read still opens the focused session, warning once', async () => {
    // Invariant: the list read failing does not stop the focused session opening read-only.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await boot({ health: [focusOn('S')], instances: new Error('connection refused') });
    await b.open();
    expect(b.appStore.get().activeId).toBe('ended:S');
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('focus:'))).toHaveLength(1);
  });

  it('an anchor that resolves wins over the focused session', async () => {
    // Invariant: a reload on a worker stays on that worker.
    history.replaceState(null, '', '/#session=W');
    const b = await boot({ health: [focusOn('S')], instances: [inst('iW', 'W'), inst('iS', 'S')] });
    await b.open();
    expect(b.active()).toBe('iW');
    expect(location.hash).toBe('#session=W');
  });

  it('without a focus key nothing opens by itself', async () => {
    // Invariant (control): an ordinary server's page load opens no session on its own.
    const b = await boot({ health: [{}], instances: [inst('iS', 'S')] });
    await b.open();
    expect(b.appStore.get().activeId).toBeNull();
    expect(b.posts()).toBe(0);
  });
});

describe('Back in focus mode', () => {
  it('from a worker returns to the exited focused session, not the empty screen', async () => {
    // Invariant: Back onto an entry naming an unlisted (exited) session opens its read-only pane instead of clearing the selection.
    const b = await boot({ health: [focusOn('S')], instances: [inst('iW', 'W')] });
    await b.open();
    expect(b.appStore.get().activeId, 'fixture check: the focused session is open').toBe('ended:S');
    b.c.selectInstance('iW', { push: true });
    expect(b.active(), 'fixture check: the worker is selected').toBe('iW');
    history.back();
    await settle();
    expect(b.appStore.get().activeId).toBe('ended:S');
    expect(location.hash).toBe('#session=S');
  });

  it('control: without focus, Back onto an entry naming an unlisted session selects nothing', async () => {
    // Invariant: the Back-to-ended behaviour belongs to focus mode alone. Back lands on an entry that
    // carries #session=S (S unlisted), the same shape as the focus arm, so the focus guard is what decides.
    const b = await boot({ health: [{}], instances: [inst('iW', 'W')] });
    await b.open();
    expect(b.appStore.get().activeId, 'fixture check: nothing opened by itself').toBeNull();
    history.replaceState(null, '', '/#session=S');
    b.c.selectInstance('iW', { push: true });
    expect(b.active(), 'fixture check: the worker is selected').toBe('iW');
    history.back();
    await settle();
    expect(b.appStore.get().activeId).toBeNull();
    expect(b.appStore.get().ended).toBeNull();
    expect(b.posts()).toBe(0);
  });
});

describe('focus from the URL marker', () => {
  it('an inactive marked session opens read-only, anchored, query kept, no POST', async () => {
    // Invariant: a page marked ?focus=S on an ordinary server opens S's transcript and never starts a CLI.
    const b = await boot({ health: [{}], url: '/?focus=S' });
    await b.open();
    expect(b.appStore.get().activeId).toBe('ended:S');
    expect(location.hash).toBe('#session=S');
    expect(location.search).toBe('?focus=S');
    expect(b.posts()).toBe(0);
  });

  it('a live marked session is selected and subscribed', async () => {
    // Invariant: a live marked session is selected as it stands, not opened read-only.
    const b = await boot({ health: [{}], instances: [inst('iS', 'S')], url: '/?focus=S' });
    await b.open();
    expect(b.active()).toBe('iS');
    expect(b.subscribes()).toEqual(['iS']);
    expect(b.posts()).toBe(0);
  });

  it('an anchor that resolves wins over the marker', async () => {
    // Invariant: a reload on a worker stays on that worker.
    const b = await boot({ health: [{}], instances: [inst('iW', 'W'), inst('iS', 'S')], url: '/?focus=S#session=W' });
    await b.open();
    expect(b.active()).toBe('iW');
  });

  it('a worker switch keeps the marker, and Back returns to the exited focused session', async () => {
    // Invariant: the marker persists across in-page navigation, and Back returns to the focused conductor.
    const b = await boot({ health: [{}], instances: [inst('iW', 'W')], url: '/?focus=S' });
    await b.open();
    expect(b.appStore.get().activeId, 'fixture check: the marked session is open').toBe('ended:S');
    b.c.selectInstance('iW', { push: true });
    expect(b.active(), 'fixture check: the worker is selected').toBe('iW');
    expect(location.search).toBe('?focus=S');
    const { focusState } = await import('@shared/focus');
    expect(focusState()).not.toBeNull();
    history.back();
    await settle();
    expect(b.appStore.get().activeId).toBe('ended:S');
    expect(location.hash).toBe('#session=S');
    expect(location.search).toBe('?focus=S');
  });

  it('an unknown marked id opens nothing, posts nothing, and stays focused', async () => {
    // Invariant: an unknown id leaves focus mode's empty state, not a session start.
    const b = await boot({ health: [{}], url: '/?focus=X', locate: MISS });
    await b.open();
    expect(b.appStore.get().activeId).toBeNull();
    expect(b.posts()).toBe(0);
    const { focusState } = await import('@shared/focus');
    expect(focusState()).toEqual({ sessionId: 'X' });
  });

  it('the server focus wins over the marker', async () => {
    // Invariant: health focus beats the URL marker.
    const b = await boot({ health: [focusOn('R')], instances: [inst('iR', 'R'), inst('iS', 'S')], url: '/?focus=S' });
    await b.open();
    expect(b.active()).toBe('iR');
  });

  it('a marked page neither follows nor consumes the relaunch stash', async () => {
    // Invariant: a focused page names its own session and leaves another tab's relaunch stash alone.
    localStorage.setItem(STASH, 'X');
    const b = await boot({ health: [{}], instances: [inst('iX', 'X'), inst('iS', 'S')], url: '/?focus=S' });
    expect(localStorage.getItem(STASH), 'fixture check: the stash is stored').toBe('X');
    await b.open();
    expect(b.active()).toBe('iS');
    expect(localStorage.getItem(STASH), 'the stash is still there').toBe('X');
  });

  it('control: an unmarked page consumes the stash and opens it', async () => {
    // Invariant: the stash skip belongs to the marker alone.
    localStorage.setItem(STASH, 'X');
    const b = await boot({ health: [{}], instances: [inst('iX', 'X'), inst('iS', 'S')] });
    await b.open();
    expect(b.active()).toBe('iX');
    expect(localStorage.getItem(STASH)).toBeNull();
  });
});
