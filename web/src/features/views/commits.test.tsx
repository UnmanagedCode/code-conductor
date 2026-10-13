import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { commitsApiBase, commitsStats, dividerIndex, type Commit, type CommitsPayload } from './commitsModel';
import { CommitList, CommitsView } from './CommitsView';
import { viewStore } from './api';
import * as actions from '@/app/sessionActions';

const sha = (c: string) => c.repeat(40);
function commit(name: string, parents: string[], ahead?: boolean): Commit {
  return { sha: sha(name[0]), shortSha: name[0].repeat(7), subject: name, author: 'x', relativeDate: '1 hour ago', parents: parents.map((p) => sha(p[0])), ahead };
}
function payload(over: Partial<CommitsPayload> = {}): CommitsPayload {
  return {
    branch: 'feature', truncated: false, limit: 100, hasUncommitted: false, aheadCount: 2, aheadOf: 'main',
    commits: [commit('e', ['d'], true), commit('d', ['c'], true), commit('c', ['b'], false), commit('b', ['a'], false), commit('a', [], false)],
    ...over,
  };
}

describe('dividerIndex / stats', () => {
  it('sits above the first already-merged row when ahead rows are a prefix', () => {
    expect(dividerIndex(payload())).toBe(2);
  });
  it('is absent when the ahead rows are not a contiguous prefix', () => {
    const p = payload({ commits: [commit('e', ['d'], true), commit('d', ['c'], false), commit('c', ['b'], true)] });
    expect(dividerIndex(p)).toBe(-1);
  });
  it('a single ahead commit still gets a divider', () => {
    expect(dividerIndex(payload({ commits: [commit('e', ['d'], true), commit('d', [], false)] }))).toBe(1);
  });
  it('none when a base is named but no row is ahead, or the window is all ahead, or nothing is ahead', () => {
    expect(dividerIndex(payload({ commits: [commit('e', [], false)] }))).toBe(-1);
    expect(dividerIndex(payload({ commits: [commit('e', ['d'], true), commit('d', [], true)] }))).toBe(-1);
    expect(dividerIndex(payload({ aheadOf: null }))).toBe(-1);
  });
  it('summarises count, truncation and ahead state', () => {
    expect(commitsStats(payload({ truncated: true }))).toBe('5 commits (showing latest 100) · 2 ahead of main');
  });
  it('spells the API base for a project and for a worktree checkout', () => {
    expect(commitsApiBase('my proj')).toBe('/api/projects/my%20proj');
    expect(commitsApiBase('p', 'wt 1')).toBe('/api/projects/p/worktrees/wt%201');
  });
});

describe('CommitList', () => {
  const wrap = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

  it('classes rows by their own ahead flag and draws the divider above the first merged row', () => {
    wrap(<CommitList data={payload()} apiBase="/api/projects/demo" onOpen={() => {}} />);
    const rows = document.querySelectorAll('[data-commit-row]');
    expect([...rows].map((r) => r.getAttribute('data-ahead'))).toEqual(['true', 'true', null, null, null]);
    const divider = document.querySelector('[data-ahead-divider]')!;
    expect(divider.textContent).toContain('Already in main');
    expect(divider.nextElementSibling?.getAttribute('data-commit-row')).toBe(sha('c'));
  });

  it('hands each row a diff URL on the base the list was fetched from', () => {
    const onOpen = vi.fn();
    wrap(<CommitList data={payload()} apiBase="/api/projects/p/worktrees/wt" onOpen={onOpen} />);
    fireEvent.click(document.querySelector(`[data-commit-row="${sha('d')}"]`)!);
    expect(onOpen.mock.calls[0][0].diffUrl).toBe(`/api/projects/p/worktrees/wt/commits/${sha('d')}/diff`);
  });

  it('an empty history renders one working-tree row and the empty notice', () => {
    const onOpen = vi.fn();
    wrap(<CommitList data={payload({ commits: [], hasUncommitted: true })} apiBase="/api/projects/demo" onOpen={onOpen} />);
    expect(screen.getByText('No commits')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-commit-row="uncommitted"]')!);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ sha: null, diffUrl: '/api/projects/demo/commits/uncommitted/diff' });
  });
});

describe('CommitsView actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(payload({ locked: false })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    viewStore.set({ commits: null });
  });
  const mount = () => render(<TooltipProvider><CommitsView /></TooltipProvider>);

  it('fetches the worktree-scoped list and hides the actions for a project\'s own tree', async () => {
    act(() => viewStore.set({ commits: { project: 'p', worktree: null } }));
    const { unmount } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/p/commits', expect.anything()));
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    unmount();
    act(() => viewStore.set({ commits: { project: 'p', worktree: 'wt' } }));
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/p/worktrees/wt/commits', expect.anything()));
    expect(screen.getByRole('button', { name: /Merge/ })).toBeTruthy();
  });

  it('passes the viewed target to Sync and re-fetches only on an ok result', async () => {
    const sync = vi.spyOn(actions, 'syncWorktree').mockResolvedValueOnce({ ok: true } as any).mockResolvedValueOnce({ ok: false } as any);
    act(() => viewStore.set({ commits: { project: 'p', worktree: 'wt' } }));
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Sync/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sync).toHaveBeenCalledWith({ project: 'p', worktree: 'wt' });
    fireEvent.click(screen.getByRole('button', { name: /Sync/ }));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Lock follows the payload, requests the toggled state and shows the server\'s answer; Merge is disabled while locked', async () => {
    const lock = vi.spyOn(actions, 'setWorktreeLock').mockResolvedValue({ ok: true, locked: true } as any);
    act(() => viewStore.set({ commits: { project: 'p', worktree: 'wt' } }));
    mount();
    const lockBtn = await screen.findByRole('button', { name: /Lock/ });
    await waitFor(() => expect((lockBtn as HTMLButtonElement).disabled).toBe(false));
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lockBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: /Locked/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(lock).toHaveBeenCalledWith({ project: 'p', worktree: 'wt' }, true);
    expect((screen.getByRole('button', { name: /Merge/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
