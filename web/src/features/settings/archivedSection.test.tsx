// Settings → Archived: Open shows a session read-only; Restore un-archives and
// resumes it; a session of a worktree the project no longer has offers Open and
// Delete but no Restore, since it cannot resume.
import '@/test/browserHash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { routeFetch } from '@/test/routeFetch';
import type { Project } from '@/state/types';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const P: Project = { name: 'p', path: '/p', system: 'local', remoteId: null, worktrees: [{ worktreeName: 'wt' }] };
const GROUPS = [{ project: 'p', sessions: [
  { sessionId: 's-live-wt', title: 'In a worktree', worktreeName: 'wt', lastActivity: 2 },
  { sessionId: 's-gone-wt', title: 'In a deleted worktree', worktreeName: 'gone', lastActivity: 1 },
] }];

async function mount() {
  vi.resetModules();
  history.replaceState(null, '', '/#settings/archived');
  const resumedInst = { id: 'iR', project: 'p', sessionId: 's-live-wt', status: 'idle', mode: 'plan' };
  const calls = routeFetch({
    'GET /api/archived': () => ({ json: { groups: GROUPS } }),
    'POST /api/projects/p/worktrees/wt/sessions/s-live-wt/restore': () => ({ json: { ok: true } }),
    'POST /api/instances': () => ({ json: resumedInst }),
    'DELETE /api/projects/p/worktrees/gone/sessions/s-gone-wt': () => ({ json: { ok: true } }),
    'GET /api/instances': () => ({ json: [resumedInst] }),
    'GET /api/sessions/': () => ({ json: { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null } }),
    'GET /api/projects': () => ({ json: [P] }),
    'GET /api/': () => ({ json: [] }),
  });
  const { appStore } = await import('@/state/app');
  const { routeStore } = await import('@/state/route');
  const { ArchivedSection } = await import('./ArchivedSection');
  appStore.set({ projects: [P], instances: [], activeId: null, ended: null });
  render(<ArchivedSection />);
  fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
  const row = (sid: string) => document.querySelector(`[data-session="${sid}"]`) as HTMLElement;
  const buttons = (sid: string) => within(row(sid)).queryAllByRole('button').map((b) => b.textContent?.trim());
  const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
  return { appStore, routeStore, calls, row, buttons, settle };
}

afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

describe('ArchivedSection', () => {
  it('a row whose worktree exists offers Open, Restore and Delete; one whose worktree is gone offers Open and Delete, marked removed', async () => {
    const b = await mount();
    expect(b.buttons('s-live-wt')).toEqual(['Open', 'Restore', 'Delete']);
    expect(b.buttons('s-gone-wt')).toEqual(['Open', 'Delete']);
    expect(b.row('s-gone-wt').querySelector('[data-worktree-removed]')).not.toBeNull();
    expect(b.row('s-live-wt').querySelector('[data-worktree-removed]')).toBeNull();
  });

  it('Open shows the removed worktree\'s session read-only, by session id', async () => {
    const b = await mount();
    expect(b.routeStore.get().route.view, 'fixture check: Settings is showing').toBe('settings');
    await act(async () => { fireEvent.click(within(b.row('s-gone-wt')).getByRole('button', { name: 'Open' })); });
    await b.settle();
    expect(b.appStore.get().ended).toMatchObject({
      sessionId: 's-gone-wt', project: 'p', title: 'In a deleted worktree', ended: { source: 'session', worktreeName: 'gone' },
    });
    expect(b.appStore.get().activeId).toBe('ended:s-gone-wt');
    expect(location.hash).toBe('#session=s-gone-wt');
    expect(b.routeStore.get().route.view, 'Open leaves Settings for the session view').toBe('session');
    expect(b.calls.some((x) => x.url === '/api/sessions/s-gone-wt/lineage-events?limit=200')).toBe(true);
  });

  it('Restore un-archives, then resumes at its worktree and selects it', async () => {
    const b = await mount();
    await act(async () => { fireEvent.click(within(b.row('s-live-wt')).getByRole('button', { name: 'Restore' })); });
    await b.settle();
    const posts = b.calls.filter((x) => x.method === 'POST');
    expect(posts.map((x) => x.url)).toEqual(['/api/projects/p/worktrees/wt/sessions/s-live-wt/restore', '/api/instances']);
    expect(posts[1].body).toEqual({ project: 'p', resume: 's-live-wt', worktree: 'wt' });
    expect(b.appStore.get().activeId).toBe('iR');
  });

  it('Delete on a removed worktree\'s row deletes at that worktree\'s session route', async () => {
    const b = await mount();
    await act(async () => { fireEvent.click(within(b.row('s-gone-wt')).getByRole('button', { name: 'Delete' })); });
    await b.settle();
    expect(b.calls.filter((x) => x.method === 'DELETE').map((x) => x.url)).toEqual(['/api/projects/p/worktrees/gone/sessions/s-gone-wt']);
  });
});
