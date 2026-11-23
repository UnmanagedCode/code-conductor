// Reopening a session that has no instance: openEndedSession shows it read-only
// in the session view, paging its transcript from disk by session id (newest
// page first, then each older page on the same route), with the anchor naming it.
import '@/test/browserHash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import { CONDUCT_PROJECT } from '@shared/conductors';
import type { UiEvent } from '@shared/uiEvent';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));

const NEWEST: UiEvent[] = [
  { kind: 'user_echo', text: 'newest prompt', userIndex: 1, _seq: 3 },
  { kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'NEWEST-REPLY', _seq: 4 },
  { kind: 'text_end', msgId: 'm2', blockIdx: 0, _seq: 5 },
];
const OLDER: UiEvent[] = [
  { kind: 'user_echo', text: 'OLDER-PROMPT', userIndex: 0, _seq: 0 },
];

afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

describe('openEndedSession', () => {
  it('pages the session from GET /api/sessions/:sid/lineage-events, renders it read-only, and names it in the anchor', async () => {
    vi.resetModules();
    const calls = routeFetch({
      'GET /api/sessions/s-x/lineage-events?limit=200&before=': () => ({
        json: { events: OLDER, hasMore: false, segment: 'seg-old', nextBefore: 0, pageSegment: 'seg-old', currentSegmentId: 'seg-new' },
      }),
      'GET /api/sessions/s-x/lineage-events?limit=200': () => ({
        json: { events: NEWEST, hasMore: true, segment: 'seg-old', nextBefore: 7, pageSegment: 'seg-new', currentSegmentId: 'seg-new' },
      }),
      'GET /api/': () => ({ json: [] }),
    });
    const c = await import('./controller');
    const ws = (await import('@shared/ws')) as unknown as { send: ReturnType<typeof vi.fn> };
    const { appStore } = await import('@/state/app');
    appStore.set({ instances: [{ id: 'iPrev', project: 'p', sessionId: 's-prev', status: 'idle', mode: 'plan' }] });
    c.selectInstance('iPrev');
    ws.send.mockClear();
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const { SessionView } = await import('@/features/session/SessionView');
    render(<TooltipProvider><SessionView /></TooltipProvider>);

    await act(async () => { await c.openEndedSession({ sessionId: 's-x', project: 'p', worktreeName: null, title: 'Old work' }); });

    expect(ws.send.mock.calls, 'the session shown before is unsubscribed, nothing subscribed').toEqual([['unsubscribe', { id: 'iPrev' }]]);
    const lineage = () => calls.filter((x) => x.url.includes('/lineage-events')).map((x) => x.url);
    expect(lineage()).toEqual(['/api/sessions/s-x/lineage-events?limit=200']);
    expect(screen.getByText('NEWEST-REPLY')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.querySelector('[data-session-ended]')).not.toBeNull();
    expect(location.hash).toBe('#session=s-x');
    expect(appStore.get().ended).toMatchObject({ sessionId: 's-x', title: 'Old work', ended: { source: 'session' } });

    await act(async () => { await c.lazyHistory.loadEarlier(); });
    expect(lineage()).toEqual([
      '/api/sessions/s-x/lineage-events?limit=200',
      '/api/sessions/s-x/lineage-events?limit=200&before=7&segment=seg-old',
    ]);
    expect(screen.getByText('OLDER-PROMPT')).toBeTruthy();
    expect(c.lazyHistory.state().hasMore).toBe(false);
  });

  // Invariant: reopening closes the phone's sidebar drawer, as selectInstance does, so the pane is not left under it.
  it('closes an open sidebar drawer', async () => {
    vi.resetModules();
    routeFetch({ 'GET /api/': () => ({ json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }) });
    const c = await import('./controller');
    const { uiStore } = await import('./ui');
    uiStore.set({ sidebarOpen: true });
    await act(async () => { await c.openEndedSession({ sessionId: 's-y', project: 'p', worktreeName: null }); });
    expect(uiStore.get().sidebarOpen).toBe(false);
  });
});


// The recorded spawn lineage (GET /api/sessions/:sid/spawner) reaches the read-only pane's header.
const EMPTY_PAGE = { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null };
const COND = { id: 'i-cond', project: CONDUCT_PROJECT, sessionId: 'cond-1', status: 'idle', mode: 'plan', title: 'Boss', conducted: false };

async function mountPane(routes: Record<string, () => RouteAnswer | Promise<RouteAnswer>>) {
  vi.resetModules();
  routeFetch({ 'GET /api/sessions/s-x/lineage-events': () => ({ json: EMPTY_PAGE }), 'GET /api/sessions/s-z/lineage-events': () => ({ json: EMPTY_PAGE }), ...routes });
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  appStore.set({ instances: [COND] as any });
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { SessionView } = await import('@/features/session/SessionView');
  render(<TooltipProvider><SessionView /></TooltipProvider>);
  return { c, appStore };
}
const backToBoss = () => screen.queryByRole('button', { name: 'Back to Boss' });

describe('openEndedSession spawner lineage', () => {
  // Invariant: reopening an archived conducted worker adopts its recorded spawner, so the header offers Back to the owner and clicking it selects the owner.
  it('adopts the recorded spawner onto the ended pane and shows Back to the owner', async () => {
    const { c, appStore } = await mountPane({
      'GET /api/sessions/s-x/spawner': () => ({ json: { conducted: true, parentSessionId: 'cond-1', rootSessionId: 'cond-1' } }),
    });
    await act(async () => { await c.openEndedSession({ sessionId: 's-x', project: 'p', worktreeName: null, title: 'Old work' }); });
    expect(appStore.get().ended).toMatchObject({ sessionId: 's-x', conducted: true, parentSessionId: 'cond-1', rootSessionId: 'cond-1' });
    expect(backToBoss()).not.toBeNull();
    fireEvent.click(backToBoss()!);
    expect(appStore.get().activeId).toBe('i-cond');
  });

  // Invariant: a late spawner answer never writes onto a pane that has moved on.
  it('drops a spawner answer that arrives after another session was opened', async () => {
    const h = held<RouteAnswer>();
    const { c, appStore } = await mountPane({ 'GET /api/sessions/s-x/spawner': () => h.answer });
    await act(async () => { await c.openEndedSession({ sessionId: 's-x', project: 'p', worktreeName: null }); });
    await act(async () => { await c.openEndedSession({ sessionId: 's-z', project: 'p', worktreeName: null }); });
    await act(async () => { h.release({ json: { conducted: true, parentSessionId: 'cond-1', rootSessionId: 'cond-1' } }); });
    expect(appStore.get().ended).toMatchObject({ sessionId: 's-z' });
    expect(appStore.get().ended?.conducted).toBeUndefined();
    expect(backToBoss()).toBeNull();
  });

  // Invariant: a session that is not conducted gets no owner chip.
  it('adopts nothing for a session the server reports not conducted', async () => {
    const { c, appStore } = await mountPane({
      'GET /api/sessions/s-x/spawner': () => ({ json: { conducted: false, parentSessionId: null, rootSessionId: null } }),
    });
    await act(async () => { await c.openEndedSession({ sessionId: 's-x', project: 'p', worktreeName: null }); });
    expect(appStore.get().ended?.conducted).toBeUndefined();
    expect(document.querySelector('[data-owner-chip]')).toBeNull();
  });
});
