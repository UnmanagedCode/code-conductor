// An open session pane whose instance leaves every list (a conductor's
// kill_instance, a temp worker's exit) stays where it is as a read-only "ended"
// pane: the same transcript node, the reader's scroll-back, the composer
// disabled with the draft still in it, and a banner saying it ended. Selecting
// another session, or the UI's own Stop, leaves no ended pane behind.
// First: the anchor's replaceState must not resync the route through a hashchange a browser never fires.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  return { bus, connect: vi.fn(), send: vi.fn() };
});
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const inst = (id: string, sessionId: string, extra: Partial<Instance> = {}): Instance => ({
  id, sessionId, project: 'p', status: 'idle', displayStatus: 'idle', mode: 'bypassPermissions', temp: true, ...extra,
});

const TAIL: UiEvent[] = [
  { kind: 'user_echo', text: 'do the work', userIndex: 0, _seq: 5 },
  { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'TAIL-REPLY', _seq: 6 },
  { kind: 'text_end', msgId: 'm1', blockIdx: 0, _seq: 7 },
];
const OLDER: UiEvent[] = [
  { kind: 'user_echo', text: 'OLDER-PROMPT', userIndex: 0, _seq: 3 },
];

type Held = ReturnType<typeof held<RouteAnswer>>;
let stop: (() => void) | null = null;

/**
 * A fresh controller over a mocked socket, the real SessionView (header,
 * ConversationView, Composer) mounted on it, and A selected with a snapshot
 * whose tail starts above seq 0, so scroll-back has more to load.
 */
async function boot(lineage: (url: string) => RouteAnswer | Promise<RouteAnswer>) {
  stop?.();
  vi.resetModules();
  const ws = (await import('@shared/ws')) as unknown as { bus: EventTarget };
  const reads: Held[] = [];
  const calls = routeFetch({
    'GET /api/instances/': (_b, url) => (url.includes('/lineage-events') ? lineage(url) : { json: {} }),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'DELETE /api/instances/': () => ({ json: { ok: true } }),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
    'GET /api/conductors/projects': () => ({ json: {} }),
    'GET /api/sessions/': (_b, url) => lineage(url),
    'GET /api/': () => ({ json: {} }),
    'POST /api/sessions/': () => ({ json: {} }),
  });
  const c = await import('@/app/controller');
  const actions = await import('@/app/sessionActions');
  const { appStore } = await import('@/state/app');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { SessionView } = await import('./SessionView');
  c.startController();
  stop = c.stopController;
  const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const frame = async (t: string, detail: object = {}) => {
    await act(async () => { ws.bus.dispatchEvent(new CustomEvent(t, { detail })); });
    await flush();
  };
  const land = async (n: number, list: Instance[]) => { await act(async () => { reads[n - 1].release({ json: list }); }); await flush(); };
  const A = inst('iA', 's-a');
  const B = inst('iB', 's-b');
  await frame('open');
  await land(1, [A, B]);
  await act(async () => { c.selectInstance('iA'); });
  render(<TooltipProvider><SessionView /></TooltipProvider>);
  await frame('snapshot', { id: 'iA', events: TAIL, tailStartSeq: 5 });
  const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const conv = () => document.querySelector('[data-conversation]');
  /** The server kills A: its status flips, then the list lands without it. */
  const killA = async (rest: Instance[] = [B]) => {
    await frame('status', { id: 'iA', status: 'exited', mode: A.mode, model: null, sessionId: 's-a' });
    await frame('instances');
    await land(reads.length, rest);
  };
  return { c, actions, appStore, calls, reads, flush, frame, land, box, conv, killA, A, B };
}

beforeEach(() => { history.replaceState(null, '', '/'); });
afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); });

const lineageCalls = (calls: { url: string }[]) => calls.filter((x) => x.url.includes('/lineage-events'));

describe('the ended pane', () => {
  it('a killed session\'s pane stays mounted in place: same transcript node, its text, the composer disabled with the draft, and the ended banner', async () => {
    const b = await boot(() => ({ json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }));
    // Positive control: the live pane renders the tail and an enabled box.
    expect(screen.getByText('TAIL-REPLY')).toBeTruthy();
    expect(b.box().disabled).toBe(false);
    expect(document.querySelector('[data-session-ended]')).toBeNull();
    fireEvent.change(b.box(), { target: { value: 'my unsent draft' } });
    const node = b.conv();
    expect(node).not.toBeNull();

    await b.killA();

    expect(b.conv() === node, 'the same transcript node: nothing remounted').toBe(true);
    expect(screen.getByText('TAIL-REPLY')).toBeTruthy();
    expect(b.box().disabled).toBe(true);
    expect(b.box().value).toBe('my unsent draft');
    const banner = document.querySelector('[data-session-ended]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(b.appStore.get().activeId).toBe('iA');
    expect(location.hash).toBe('#session=s-a');
  });

  it('scroll-back on the ended pane pages the killed instance\'s lineage and prepends it; a 404 then stops it silently', async () => {
    let answer: RouteAnswer = { json: { events: OLDER, hasMore: true, segment: null, nextBefore: 3, pageSegment: 'seg', currentSegmentId: 'seg' } };
    const b = await boot(() => answer);
    await b.killA();
    expect(document.querySelector('[data-session-ended]'), 'fixture check: the pane ended').not.toBeNull();
    const before = lineageCalls(b.calls).length;

    await act(async () => { await b.c.lazyHistory.loadEarlier(); });
    const sent = lineageCalls(b.calls).slice(before);
    expect(sent.map((x) => x.url)).toEqual(['/api/instances/iA/lineage-events?limit=200&before=5']);
    expect(screen.getByText('OLDER-PROMPT')).toBeTruthy();
    expect(screen.getByText('TAIL-REPLY')).toBeTruthy();
    expect(b.c.lazyHistory.state().hasMore).toBe(true);

    // The server forgot the retired pager (evicted, or restarted): no warning, no more pages.
    answer = { status: 404, json: { error: 'instance not found' } };
    await act(async () => { await b.c.lazyHistory.loadEarlier(); });
    expect(b.c.lazyHistory.state().hasMore).toBe(false);
  });

  it('selecting another session drops the ended pane, and the UI\'s Stop of a live session still leaves the empty state', async () => {
    const b = await boot(() => ({ json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }));
    await b.killA();
    expect(document.querySelector('[data-session-ended]'), 'fixture check: the pane ended').not.toBeNull();

    await act(async () => { b.c.selectInstance('iB', { userGesture: true }); });
    await b.flush();
    expect(document.querySelector('[data-session-ended]')).toBeNull();
    expect(b.appStore.get().ended).toBeNull();
    expect(b.box().disabled).toBe(false);

    const stopped = b.actions.stopSession({ projectName: 'p', instanceId: 'iB', sessionId: 's-b', status: 'idle' });
    await b.flush();
    // The stop's refresh reads the list without B (answering a read twice is a no-op).
    for (const r of b.reads) await act(async () => { r.release({ json: [] }); });
    await act(async () => { await stopped; });
    await b.flush();
    expect(b.appStore.get().activeId).toBeNull();
    expect(document.querySelector('[data-session-ended]')).toBeNull();
    expect(document.querySelector('[data-empty-state]')).not.toBeNull();
  });

  // Invariant: a routine instance-list refresh leaves an ended pane alone — the
  // same ended entry (source, worktree), still mounted — whether it ended in
  // place or was reopened from disk.
  it('a later instance-list refresh keeps the ended pane, after a kill and after a reopen', async () => {
    const b = await boot(() => ({ json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }));
    await b.killA();
    const ended = b.appStore.get().ended;
    expect(ended?.ended, 'fixture check: ended in place').toEqual({ source: 'instance', worktreeName: null });
    const node = b.conv();
    await b.frame('instances');
    await b.land(b.reads.length, [b.B]);
    expect(b.appStore.get().ended).toBe(ended);
    expect(b.appStore.get().activeId).toBe('iA');
    expect(b.conv() === node, 'still mounted').toBe(true);
    expect(document.querySelector('[data-session-ended]')).not.toBeNull();

    await act(async () => { await b.c.openEndedSession({ sessionId: 's-old', project: 'p', worktreeName: 'wt-old' }); });
    const reopened = b.appStore.get().ended;
    expect(reopened?.ended, 'fixture check: reopened').toEqual({ source: 'session', worktreeName: 'wt-old' });
    await b.frame('instances');
    await b.land(b.reads.length, [b.B]);
    expect(b.appStore.get().ended).toBe(reopened);
    expect(b.appStore.get().activeId).toBe('ended:s-old');
    expect(document.querySelector('[data-session-ended]')).not.toBeNull();
  });
});

