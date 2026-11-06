// The ended pane's banner offers Resume exactly while the session's place
// exists: the project is listed and, for a worktree session, still has that
// worktree. Resume un-archives, then resumes at that place.
import '@/test/browserHash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { routeFetch } from '@/test/routeFetch';
import type { Instance, Project } from '@/state/types';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const project = (worktrees: string[]): Project => ({
  name: 'p', path: '/p', system: 'local', remoteId: null, worktrees: worktrees.map((worktreeName) => ({ worktreeName })),
});
const ended: Instance = {
  id: 'iA', project: 'p', sessionId: 's-a', status: 'exited', displayStatus: 'exited', mode: 'plan',
  ended: { source: 'instance', worktreeName: 'wt' },
};

async function mount(projects: Project[], listed: Instance[] = []) {
  vi.resetModules();
  const resumedInst = { id: 'iA2', project: 'p', sessionId: 's-a', status: 'idle', mode: 'plan' };
  const calls = routeFetch({
    'POST /api/projects/p/worktrees/wt/sessions/s-a/restore': () => ({ json: { ok: true } }),
    'POST /api/instances': () => ({ json: resumedInst }),
    'GET /api/instances': () => ({ json: [resumedInst] }),
    'GET /api/projects': () => ({ json: projects }),
    'GET /api/workspaces': () => ({ json: [] }),
    'GET /api/conductors/projects': () => ({ json: {} }),
  });
  const { appStore } = await import('@/state/app');
  const { EndedBanner } = await import('./EndedBanner');
  appStore.set({ projects, instances: listed, ended, activeId: 'iA' });
  render(<EndedBanner inst={ended} />);
  return { appStore, calls };
}
const resume = () => screen.queryByRole('button', { name: /Resume/ });

afterEach(() => { vi.restoreAllMocks(); });

describe('EndedBanner', () => {
  it('shows Resume while the worktree is listed; a click restores, then resumes at that worktree', async () => {
    const { calls, appStore } = await mount([project(['wt'])]);
    expect(screen.getByRole('status').hasAttribute('data-session-ended')).toBe(true);
    expect(resume()).not.toBeNull();
    await act(async () => { fireEvent.click(resume()!); });
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
    const posts = calls.filter((x) => x.method === 'POST');
    expect(posts.map((x) => x.url)).toEqual(['/api/projects/p/worktrees/wt/sessions/s-a/restore', '/api/instances']);
    expect(posts[1].body).toEqual({ project: 'p', resume: 's-a', worktree: 'wt' });
    expect(appStore.get().activeId).toBe('iA2');
    expect(appStore.get().ended).toBeNull();
  });

  it('Resume of a session already live again under another instance selects that instance and posts nothing', async () => {
    const again: Instance = { id: 'iA3', project: 'p', sessionId: 's-a', status: 'idle', mode: 'plan' };
    const { calls, appStore } = await mount([project(['wt'])], [again]);
    await act(async () => { fireEvent.click(resume()!); });
    expect(calls.filter((x) => x.method === 'POST')).toEqual([]);
    expect(appStore.get().activeId).toBe('iA3');
    expect(appStore.get().ended).toBeNull();
  });

  it('hides Resume once a projects refresh no longer lists the worktree, and never offers it for an unlisted project', async () => {
    const { appStore } = await mount([project(['wt'])]);
    expect(resume(), 'control: listed worktree').not.toBeNull();
    act(() => appStore.set({ projects: [project(['other'])] }));
    expect(resume()).toBeNull();
    act(() => appStore.set({ projects: [] }));
    expect(resume()).toBeNull();
  });
});
