import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';

const selectInstance = vi.fn();
vi.mock('@/app/controller', () => ({
  selectInstance: (...a: unknown[]) => selectInstance(...a),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
const loadSessions = vi.fn(async () => [] as any[]);
const closeSession = vi.fn();
const resumeSession = vi.fn();
const removeWorktree = vi.fn();
vi.mock('@/app/sessionActions', () => ({
  loadSessions: (...a: unknown[]) => loadSessions(...(a as [])),
  closeSession: (...a: unknown[]) => closeSession(...a),
  resumeSession: (...a: unknown[]) => resumeSession(...a),
  promoteSession: vi.fn(),
  removeWorktree: (...a: unknown[]) => removeWorktree(...a),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore } = await import('./state');
const { closeDialog, dialogStore } = await import('@/features/dialogs/api');

const inst = (o: Record<string, any>) => ({ id: `i-${o.sessionId}`, status: 'idle', mode: 'plan', ...o });

function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
    ...over,
  });
}

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
const farRow = () => document.querySelector('[data-project-row="far"]') as HTMLElement;
const LOCAL = { name: 'far', path: '/p/far', workspace: null, system: 'local', remoteId: null, systemUnreachable: null, isGitRepo: true, worktrees: [] };

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  loadSessions.mockReset().mockResolvedValue([]);
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'conductors' });
  seed();
});

describe('AppSidebar', () => {
  it('shows the empty conductor state, and the lens switch persists the choice', () => {
    renderSidebar();
    expect(screen.getByText(/No conductors yet/)).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Projects' }));
    expect(uiStore.get().lens).toBe('projects');
    expect(localStorage.getItem('code-conductor:sidebar-lens')).toBe('projects');
  });

  it('groups the needs-you strip and opens the session an entry names', () => {
    seed({
      instances: [
        inst({ sessionId: 'ask', project: 'api', firstPrompt: 'Need a decision', awaitingUser: 'question', awaitingUserSource: 'tool' }),
        inst({ sessionId: 'done', project: 'api', firstPrompt: 'All finished', turnEndSeq: 2, viewedSeq: 1 }),
      ] as any,
    });
    renderSidebar();
    const strip = document.querySelector('[data-strip]') as HTMLElement;
    expect(within(strip).getByText('Waiting on you (1)')).toBeTruthy();
    expect(within(strip).getByText('Finished (1 · 1 new)')).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: /Need a decision/ }));
    expect(selectInstance).toHaveBeenCalledWith('i-ask', { userGesture: true });
  });

  it('a strip group header folds its entries, and the fold survives a remount', () => {
    seed({
      instances: [
        inst({ sessionId: 'ask', project: 'api', firstPrompt: 'Need a decision', awaitingUser: 'question', awaitingUserSource: 'tool' }),
        inst({ sessionId: 'done', project: 'api', firstPrompt: 'All finished' }),
      ] as any,
    });
    const { unmount } = renderSidebar();
    const finished = () => document.querySelector('[data-strip-group="finished"]') as HTMLElement;
    const header = () => within(finished()).getByRole('button', { name: /Finished \(1\)/ });
    expect(header().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header());
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect((finished().querySelector('ul') as HTMLElement).hidden).toBe(true);
    // The other group stays open.
    expect((document.querySelector('[data-strip-group="waiting"] ul') as HTMLElement).hidden).toBe(false);
    unmount();
    renderSidebar();
    expect(header().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header());
    expect((finished().querySelector('ul') as HTMLElement).hidden).toBe(false);
  });

  it('a live conductor row opens its session; an inactive one resumes in .conduct and can be archived', () => {
    seed({
      instances: [inst({ sessionId: 'live-c', project: '.conduct', firstPrompt: 'Orchestrate' })] as any,
      conductSessions: [{ sessionId: 'dead-c', title: 'Old run', lastActivity: 5 }] as any,
    });
    renderSidebar();
    const list = () => document.querySelector('[data-conductor-list]') as HTMLElement;
    fireEvent.click(within(list()).getByText('Orchestrate'));
    expect(selectInstance).toHaveBeenCalledWith('i-live-c', { userGesture: true });
    fireEvent.click(within(list()).getByText('Inactive (1)'));
    fireEvent.click(within(list()).getByText('Old run'));
    expect(resumeSession).toHaveBeenCalledWith({ projectName: '.conduct', worktreeName: null, sessionId: 'dead-c' });
    fireEvent.click(within(list()).getByRole('button', { name: 'Archive session (keeps history)' }));
    expect(closeSession).toHaveBeenCalledWith(expect.objectContaining({ projectName: '.conduct', sessionId: 'dead-c' }));
  });

  it('lists workspaces and projects, loads a place\'s sessions lazily, and the + opens the spawn dialog', async () => {
    uiStore.set({ lens: 'projects' });
    loadSessions.mockResolvedValue([{ sessionId: 'disk1', firstPrompt: 'From disk', lastActivity: Date.now() }]);
    seed({
      workspaces: ['Acme'],
      projects: [
        { name: 'api', path: '/p/api', workspace: 'Acme', system: 'local', remoteId: null, worktrees: [], sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } },
        { name: 'web', path: '/p/web', workspace: null, system: 'local', remoteId: null, worktrees: [], sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 } },
      ] as any,
    });
    renderSidebar();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('Acme'));
    await act(async () => { await Promise.resolve(); });
    expect(loadSessions).toHaveBeenCalledWith('api', null);
    expect(await screen.findByText('From disk')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New session' })[0]);
    expect(dialogStore.get().spawn).toEqual({ project: 'api', opts: {} });
  });

  it('Hand-spawned only hides conducted rows', async () => {
    uiStore.set({ lens: 'projects' });
    sidebarStore.set({ filter: 'hand' });
    seed({
      projects: [{ name: 'api', path: '/p', workspace: null, system: 'local', remoteId: null, worktrees: [], sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 } }] as any,
      instances: [
        inst({ sessionId: 'mine', project: 'api', firstPrompt: 'By hand' }),
        inst({ sessionId: 'theirs', project: 'api', firstPrompt: 'By a conductor', conducted: true }),
      ] as any,
    });
    renderSidebar();
    const list = document.querySelector('[data-project-list]') as HTMLElement;
    expect(await within(list).findByText('By hand')).toBeTruthy();
    expect(within(list).queryByText('By a conductor')).toBeNull();
  });

  it('an unreachable system shows its reason and hides the + that would fail, keeping delete', () => {
    uiStore.set({ lens: 'projects' });
    seed({
      projects: [{ name: 'far', path: '/x', workspace: null, system: 'box', remoteId: null, systemUnreachable: 'box is down', worktrees: [] }] as any,
    });
    renderSidebar();
    const row = document.querySelector('[data-project-row="far"]') as HTMLElement;
    expect(within(row).getByText('box')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'New session' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Delete project' })).toBeTruthy();
    // The reason is the title of the pill that names the system.
    const pill = within(row).getByTitle('box is down');
    expect(pill.textContent).toContain('box');
    expect(within(row).queryByRole('button', { name: 'Commit history' })).toBeNull();
  });

  it('a reachable remote project\'s system pill opens the change-target dialog', () => {
    uiStore.set({ lens: 'projects' });
    const project = { name: 'far', path: '/x', workspace: null, system: 'box', remoteId: 'c1', worktrees: [] };
    seed({ projects: [project] as any });
    renderSidebar();
    fireEvent.click(screen.getByText('box/c1'));
    expect(dialogStore.get().projectRemote?.project.name).toBe('far');
  });

  it('a local project shows no system pill and keeps commit history, + and delete', () => {
    uiStore.set({ lens: 'projects' });
    seed({ projects: [LOCAL] as any });
    renderSidebar();
    const row = farRow();
    expect(row.querySelector('[data-system-pill]')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Commit history' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Delete project' })).toBeTruthy();
  });

  it('a reachable remote project keeps commit history, + and delete, and its pill tooltip names the system and its path', async () => {
    uiStore.set({ lens: 'projects' });
    seed({ projects: [{ name: 'far', path: '/app', workspace: null, system: 'box', remoteId: null, isGitRepo: true, worktrees: [] }] as any });
    renderSidebar();
    const row = farRow();
    const pill = row.querySelector('[data-system-pill]') as HTMLElement;
    expect(pill.tagName).toBe('BUTTON');
    expect(pill.textContent).toBe('box');
    expect(within(row).getByRole('button', { name: 'Commit history' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Delete project' })).toBeTruthy();
    await act(async () => { fireEvent.focus(pill); });
    const tip = (await screen.findByRole('tooltip')).textContent;
    expect(tip).toContain("system 'box' at /app");
    expect(tip).toContain('Click to change which target it is on.');
  });

  it('an unreachable system\'s pill is a reason, not a control: clicking it opens no change-target dialog', () => {
    closeDialog('projectRemote');
    uiStore.set({ lens: 'projects' });
    seed({ projects: [{ name: 'far', path: '/x', workspace: null, system: 'box', remoteId: 'c1', systemUnreachable: 'down', worktrees: [] }] as any });
    renderSidebar();
    const row = farRow();
    expect(within(row).queryByRole('button', { name: /box\/c1/ })).toBeNull();
    fireEvent.click(row.querySelector('[data-system-pill]') as HTMLElement);
    expect(dialogStore.get().projectRemote).toBeNull();
  });

  it('a system coming back clears the pill and restores the + on the same row element', () => {
    uiStore.set({ lens: 'projects' });
    seed({ projects: [{ name: 'far', path: '/p/far', workspace: null, system: 'box', remoteId: null, systemUnreachable: 'down', worktrees: [] }] as any });
    renderSidebar();
    const before = farRow();
    act(() => appStore.set({ projects: [LOCAL] as any }));
    expect(document.querySelector('[data-project-row="far"]') === before).toBe(true);
    expect(before.querySelector('[data-system-pill]')).toBeNull();
    expect(within(before).getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('a git ownership refusal shows its own pill carrying the refusal, keeps the +, and conjures no system pill', () => {
    uiStore.set({ lens: 'projects' });
    const refusal = "git on system 'local' refused the repository at '/p/far': detected dubious ownership";
    const same = { name: 'far', path: '/p/far', workspace: null, system: 'local', remoteId: null, systemUnreachable: null, gitRefusal: refusal, worktrees: [] };
    seed({ projects: [same] as any });
    renderSidebar();
    const row = farRow();
    expect(within(row).getByText('dubious ownership').getAttribute('title')).toBe(refusal);
    expect(within(row).getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Commit history' })).toBeNull();
    expect(row.querySelector('[data-system-pill]')).toBeNull();
    act(() => appStore.set({ projects: [{ ...same, gitRefusal: null }] as any }));
    expect(within(farRow()).queryByText('dubious ownership')).toBeNull();
  });

  it('a worktree\'s × removes that worktree', () => {
    uiStore.set({ lens: 'projects' });
    sidebarStore.set({ expandedWorktrees: ['api'] });
    seed({ projects: [{ name: 'api', path: '/p/api', workspace: null, system: 'local', remoteId: null, worktrees: [{ worktreeName: 'wt1', baseBranch: 'main' }] }] as any });
    renderSidebar();
    const wtRow = document.querySelector('[data-worktree-row="wt1"]') as HTMLElement;
    fireEvent.click(within(wtRow).getByRole('button', { name: 'Remove worktree' }));
    expect(removeWorktree).toHaveBeenCalledWith('api', 'wt1');
  });

  it('the Conduct button ensures .conduct, POSTs exactly {project, role, temp, mode} and selects the new conductor with a gesture', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      const body = url === '/api/instances' ? { id: 'c-new' } : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    }));
    try {
      renderSidebar();
      fireEvent.click(document.querySelector('[data-conduct]') as HTMLElement);
      await waitFor(() => expect(selectInstance).toHaveBeenCalledWith('c-new', { userGesture: true }));
      expect(calls.filter((c) => c.method === 'POST')).toEqual([
        { url: '/api/projects/.conduct/ensure', method: 'POST', body: undefined },
        { url: '/api/instances', method: 'POST', body: { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the ≡ menu\'s Add existing directory opens the add-project dialog', async () => {
    closeDialog('adoptProject');
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Project actions' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20)); // let a previous close settle
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Add existing directory/ }));
    expect(dialogStore.get().adoptProject).toBe(true);
  });

  it('reveal on select opens the session\'s workspace and switches a filter that hides it to its owner', () => {
    uiStore.set({ lens: 'projects' });
    sidebarStore.set({ filter: 'hand' });
    seed({
      workspaces: ['Acme'],
      projects: [{ name: 'api', path: '/p', workspace: 'Acme', system: 'local', remoteId: null, worktrees: [] }] as any,
      instances: [
        inst({ sessionId: 'cond', project: '.conduct' }),
        inst({ sessionId: 's', project: 'api', conducted: true, ownerSessionId: 'cond' }),
      ] as any,
    });
    renderSidebar();
    act(() => appStore.set({ activeId: 'i-s' }));
    expect(sidebarStore.get().expandedWorkspaces).toContain('Acme');
    expect(sidebarStore.get().filter).toBe('cond');
    expect(sidebarStore.get().expandedConductors).toContain('cond');
  });

  it('the footer links to the classic UI at /legacy/', () => {
    renderSidebar();
    const footer = document.querySelector('[data-sidebar-footer]') as HTMLElement;
    const link = within(footer).getByRole('link', { name: 'Classic UI' });
    expect(link.getAttribute('href')).toBe('/legacy/');
  });

  it('shows Reconnecting… after the socket dropped', () => {
    seed({ connection: 'reconnecting', everDropped: true });
    renderSidebar();
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });
});
