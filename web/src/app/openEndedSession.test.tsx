// Reopening a session that has no instance: openEndedSession shows it read-only
// in the session view, paging its transcript from disk by session id (newest
// page first, then each older page on the same route), with the anchor naming it.
import '@/test/browserHash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { routeFetch } from '@/test/routeFetch';
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
});
