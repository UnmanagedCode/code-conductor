import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { CLOSE_TITLES } from '@/lib/core/closeAction.js';
import { blockOf, conductor, conductorRowOf, el, inactiveGroup, proj, seed, treeOf, worker, wt } from '@/test/sidebarFleet';

const selectInstance = vi.fn();
vi.mock('@/app/controller', () => ({
  selectInstance: (...a: unknown[]) => selectInstance(...a),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
const loadSessions = vi.fn((..._a: any[]): Promise<any[]> => Promise.resolve([]));
const closeSession = vi.fn();
const resumeSession = vi.fn();
const removeWorktree = vi.fn();
const promoteSession = vi.fn();
vi.mock('@/app/sessionActions', () => ({
  loadSessions: (...a: unknown[]) => loadSessions(...a),
  closeSession: (...a: unknown[]) => closeSession(...a),
  resumeSession: (...a: unknown[]) => resumeSession(...a),
  promoteSession: (...a: unknown[]) => promoteSession(...a),
  removeWorktree: (...a: unknown[]) => removeWorktree(...a),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
/** The sidebar state a fresh page starts from, read before any test writes it. */
const FRESH = sidebarStore.get();

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** The Inactive group's disclosure button. */
const inactiveToggle = () => inactiveGroup()?.querySelector(':scope > button[aria-expanded]') as HTMLElement | null;
/** The sids of the conductor blocks under the Inactive group, in order. */
const inactiveSids = () => [...inactiveGroup()!.querySelectorAll('[data-conductor]')].map((b) => b.getAttribute('data-conductor'));
const PROMOTE = 'Make persistent';
const promoteOf = (row: HTMLElement) => within(row).queryAllByRole('button', { name: PROMOTE });
const closeOf = (row: HTMLElement) => [CLOSE_TITLES.stop, CLOSE_TITLES.archive].flatMap((name) => within(row).queryAllByRole('button', { name }));
const archiveOf = (row: HTMLElement) => within(row).queryAllByRole('button', { name: CLOSE_TITLES.archive });
const unreadOf = (row: HTMLElement) => row.querySelector('[data-unread]');
const expand = (sid: string) => { fireEvent.click(within(blockOf(sid)).getByRole('button', { name: 'Show workers' })); return treeOf(sid)!; };
const treeRowOf = (tree: HTMLElement, sid: string) => tree.querySelector(`[data-session-row="${sid}"] > [role="button"]`) as HTMLElement | null;

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  promoteSession.mockReset();
  loadSessions.mockReset().mockResolvedValue([]);
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'conductors' });
  seed();
});

describe('Inactive group', () => {
  it('Inactive (n) is a collapsed group after the live conductors, listing them newest first once opened', async () => {
    // Invariant: every non-live conductor, disk-only or dead instance, sits in one group after the live ones, collapsed until opened (a fresh page starts collapsed), newest activity first.
    expect(FRESH.inactiveOpen).toBe(false);
    seed({
      conductSessions: [{ sessionId: 'old', title: 'Old', lastActivity: 100 }, { sessionId: 'mid', title: 'Mid', lastActivity: 500 }],
      instances: [conductor('X', { title: 'Exited', status: 'exited', createdAt: 300 }), conductor('L', { title: 'Live' })],
    });
    renderSidebar();
    await settle();
    const toggle = inactiveToggle()!;
    expect(toggle.textContent).toMatch(/\(3\)/);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(inactiveSids()).toEqual([]);
    expect(inactiveGroup()!.contains(blockOf('L'))).toBe(false);
    expect(blockOf('L').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(inactiveSids()).toEqual(['mid', 'X', 'old']);
  });

  it('an archived conductor is in no group, and only archived conductors leave no group and the empty state', async () => {
    // Invariant: archived .conduct rows never render; with nothing else, the lens shows its empty state.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      conductSessions: [{ sessionId: 'T', title: 'Temp one', archived: true, lastActivity: 5 }, { sessionId: 'D', title: 'Kept', lastActivity: 1 }],
      instances: [conductor('L', { title: 'Live' })],
    });
    renderSidebar();
    await settle();
    expect(inactiveToggle()!.textContent).toMatch(/\(1\)/);
    expect(inactiveSids()).toEqual(['D']);
    expect(blockOf('T')).toBeNull();
    expect(el('[data-conductors-empty]')).toBeNull();
    act(() => seed({ conductSessions: [{ sessionId: 'T', archived: true, lastActivity: 5 }] }));
    expect(inactiveGroup()).toBeNull();
    expect(blockOf('T')).toBeNull();
    expect(el('[data-conductors-empty]')).not.toBeNull();
  });

  it("the Inactive group keeps the user's open or closed choice across its removal and re-creation, and across a remount", async () => {
    // Invariant: the open state is the user's, held outside the group: it survives the group dropping out while every conductor is live, and the list remounting.
    seed({ conductSessions: [{ sessionId: 'D', lastActivity: 1 }], instances: [conductor('L')] });
    const view = renderSidebar();
    await settle();
    const rebuild = () => {
      act(() => appStore.set({ instances: [conductor('L'), conductor('D')] }));
      expect(inactiveGroup()).toBeNull();
      act(() => appStore.set({ instances: [conductor('L')] }));
      expect(inactiveGroup()).not.toBeNull();
    };
    fireEvent.click(inactiveToggle()!);
    rebuild();
    expect(inactiveToggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(inactiveSids()).toEqual(['D']);
    view.unmount();
    renderSidebar();
    expect(inactiveToggle()!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(inactiveToggle()!);
    rebuild();
    expect(inactiveToggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(inactiveSids()).toEqual([]);
  });

  it('no Inactive group when every conductor is live', async () => {
    // Invariant: the group exists only while some conductor is not live.
    seed({ instances: [conductor('A'), conductor('B')] });
    renderSidebar();
    await settle();
    expect(blockOf('A')).not.toBeNull();
    expect(inactiveGroup()).toBeNull();
  });
});

describe('archive × on an inactive conductor', () => {
  it('a live conductor row has no close action, an inactive one has the archive action beside its unread pill, and the worker tree has none', async () => {
    // Invariant: only a not-live conductor row offers a close, and it is the archive; the unread pill stays either way; the tree offers none.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      projects: [proj('proj')],
      conductSessions: [{ sessionId: 'D', lastActivity: 1, turnEndSeq: 2 }],
      instances: [conductor('A', { turnEndSeq: 2 }), worker('w', 'A', 'proj', null, { temp: false }), conductor('X', { status: 'exited' })],
    });
    renderSidebar();
    await settle();
    expect(closeOf(conductorRowOf('A'))).toEqual([]);
    expect(unreadOf(conductorRowOf('A'))).not.toBeNull();
    for (const sid of ['D', 'X']) {
      expect(closeOf(conductorRowOf(sid)).length, sid).toBe(1);
      expect(archiveOf(conductorRowOf(sid)).length, sid).toBe(1);
    }
    expect(unreadOf(conductorRowOf('D'))).not.toBeNull();
    const tree = expand('A');
    expect(treeRowOf(tree, 'w')).not.toBeNull();
    expect(closeOf(tree)).toEqual([]);
  });

  it("× on an inactive conductor closes it through closeSession with the conductor's facts, and never selects or resumes", async () => {
    // Invariant: each × hands closeSession its own conductor's place, instance, status, temp flag, shown label and whether a transcript is listed.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      conductSessions: [{ sessionId: 'D', title: 'Disk', lastActivity: 3 }, { sessionId: 'B', lastActivity: 1 }],
      instances: [
        conductor('A', { title: 'Alpha', status: 'exited', lastResponseAt: 2 }),
        conductor('B', { firstPrompt: 'plan the work', status: 'crashed', temp: false }),
      ],
    });
    renderSidebar();
    await settle();
    for (const sid of ['D', 'A', 'B']) fireEvent.click(archiveOf(conductorRowOf(sid))[0]);
    expect(closeSession.mock.calls).toEqual([
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'D', instanceId: null, status: null, temp: false, preview: 'Disk', synthetic: false }],
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'A', instanceId: 'i-A', status: 'exited', temp: true, preview: 'Alpha', synthetic: true }],
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'B', instanceId: 'i-B', status: 'crashed', temp: false, preview: 'plan the work', synthetic: false }],
    ]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('the × reads the freshest conductor after a re-render, on the same button', async () => {
    // Invariant: the × button survives a re-render and closes with the conductor as it is at click time.
    sidebarStore.set({ inactiveOpen: true });
    seed({ conductSessions: [{ sessionId: 'A', lastActivity: 1 }] });
    renderSidebar();
    await settle();
    const before = archiveOf(conductorRowOf('A'))[0];
    act(() => appStore.set({ conductSessions: [{ sessionId: 'A', title: 'Renamed', lastActivity: 1 }] }));
    const after = archiveOf(conductorRowOf('A'))[0];
    expect(after === before).toBe(true);
    fireEvent.click(after);
    expect(closeSession.mock.calls.map(([a]) => [a.sessionId, a.preview])).toEqual([['A', 'Renamed']]);
  });

  it('a conductor that dies gains the × under Inactive, and the archive refresh leaves the empty state', async () => {
    // Invariant: death moves the conductor under Inactive with an archive ×; once the archive's refresh lands, nothing is left.
    sidebarStore.set({ inactiveOpen: true });
    seed({ instances: [conductor('A', { title: 'Alpha' })] });
    renderSidebar();
    await settle();
    expect(closeOf(conductorRowOf('A'))).toEqual([]);
    act(() => appStore.set({ instances: [conductor('A', { title: 'Alpha', status: 'exited' })] }));
    expect(inactiveSids()).toEqual(['A']);
    fireEvent.click(archiveOf(conductorRowOf('A'))[0]);
    expect(closeSession.mock.calls.map(([a]) => a.sessionId)).toEqual(['A']);
    act(() => appStore.set({ instances: [], conductSessions: [] }));
    expect(el('[data-conductor]')).toBeNull();
    expect(el('[data-conductors-empty]')).not.toBeNull();
  });
});

describe('↑ Make persistent on a worker row', () => {
  /** A's tree: live temp workers in the main checkout and a worktree, and a non-temp one. */
  const workers = () => ({
    projects: [proj('proj', { worktrees: [wt('wt1')] })],
    instances: [
      conductor('A', { temp: false }),
      worker('t', 'A', 'proj', null, { temp: true, firstPrompt: 'do the work', createdAt: 3 }),
      worker('tw', 'A', 'proj', 'wt1', { temp: true, firstPrompt: 'do more', createdAt: 2 }),
      worker('n', 'A', 'proj', null, { temp: false, createdAt: 1 }),
    ],
  });

  it('a live temp worker row has one ↑ and no close action, and a non-temp worker has neither', async () => {
    // Invariant: ↑ appears once on each live temp worker row, wherever it runs, and on no other; the tree has no close.
    seed(workers());
    renderSidebar();
    await settle();
    const tree = expand('A');
    for (const sid of ['t', 'tw']) {
      expect(promoteOf(treeRowOf(tree, sid)!).length, sid).toBe(1);
      expect(closeOf(treeRowOf(tree, sid)!), sid).toEqual([]);
    }
    expect(promoteOf(treeRowOf(tree, 'n')!)).toEqual([]);
    expect(closeOf(treeRowOf(tree, 'n')!)).toEqual([]);
  });

  it('an exited or crashed temp worker keeps its tree row without the ↑', async () => {
    // Invariant: only a live temp worker is promotable; a dead one still lists.
    seed({
      projects: [proj('proj')],
      instances: [
        conductor('A', { temp: false }),
        worker('t', 'A', 'proj', null, { temp: true }),
        worker('xe', 'A', 'proj', null, { temp: true, status: 'exited' }),
        worker('xc', 'A', 'proj', null, { temp: true, status: 'crashed' }),
      ],
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    expect(promoteOf(treeRowOf(tree, 't')!).length).toBe(1);
    for (const sid of ['xe', 'xc']) {
      expect(treeRowOf(tree, sid), sid).not.toBeNull();
      expect(promoteOf(treeRowOf(tree, sid)!), sid).toEqual([]);
    }
  });

  it("a worker's ↑ promotes it through promoteSession with its project, instance id and label, in the main checkout and in a worktree, and never selects or resumes", async () => {
    // Invariant: each ↑ sends its own worker's project, instance and shown label, and the click stops at the button.
    seed(workers());
    renderSidebar();
    await settle();
    const tree = expand('A');
    fireEvent.click(promoteOf(treeRowOf(tree, 'tw')!)[0]);
    fireEvent.click(promoteOf(treeRowOf(tree, 't')!)[0]);
    expect(promoteSession.mock.calls).toEqual([
      [{ projectName: 'proj', instanceId: 'i-tw', preview: 'do more' }],
      [{ projectName: 'proj', instanceId: 'i-t', preview: 'do the work' }],
    ]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("a worker's ↑ reads the freshest instance after a re-render, on the same button", async () => {
    // Invariant: the ↑ survives a re-render and promotes the instance the worker has at click time.
    seed({ projects: [proj('proj')], instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const tree = expand('A');
    const before = promoteOf(treeRowOf(tree, 't')!)[0];
    act(() => appStore.set({ instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj', null, { id: 'i-t2' })] }));
    const after = promoteOf(treeRowOf(treeOf('A')!, 't')!)[0];
    expect(after === before).toBe(true);
    fireEvent.click(after);
    expect(promoteSession.mock.calls.map(([a]) => a.instanceId)).toEqual(['i-t2']);
  });

  it('promoting a worker drops its ↑ in place, and the worker stays in the tree', async () => {
    // Invariant: the live temp flag alone decides the ↑; the row survives the flip.
    seed({ projects: [proj('proj')], instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const row = treeRowOf(expand('A'), 't')!;
    expect(promoteOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj', null, { temp: false })] }));
    expect(treeRowOf(treeOf('A')!, 't') === row).toBe(true);
    expect(promoteOf(row)).toEqual([]);
  });

  it('a worker dying drops its ↑ in place', async () => {
    // Invariant: the row survives its worker's exit and loses the ↑.
    seed({ projects: [proj('proj')], instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const row = treeRowOf(expand('A'), 't')!;
    expect(promoteOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { temp: false }), worker('t', 'A', 'proj', null, { status: 'exited' })] }));
    expect(treeRowOf(treeOf('A')!, 't') === row).toBe(true);
    expect(promoteOf(row)).toEqual([]);
  });
});

describe('↑ Make persistent on a conductor row', () => {
  it('a live temp conductor row has one ↑ and no close action, and keeps its unread pill beside it', async () => {
    // Invariant: a live temp conductor row offers exactly one ↑ and no close, with or without unread turns.
    seed({ instances: [conductor('A'), conductor('U', { turnEndSeq: 3 })] });
    renderSidebar();
    await settle();
    for (const sid of ['A', 'U']) {
      expect(promoteOf(conductorRowOf(sid)).length, sid).toBe(1);
      expect(closeOf(conductorRowOf(sid)), sid).toEqual([]);
    }
    expect(unreadOf(conductorRowOf('A'))).toBeNull();
    expect(unreadOf(conductorRowOf('U'))?.textContent).toBe('3');
  });

  it('no ↑ on a live non-temp, exited, crashed or disk-only conductor row, and only the not-live ones carry the archive action', async () => {
    // Invariant: ↑ needs live and temp together; a close appears exactly on the rows that are not live.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      conductSessions: [{ sessionId: 'D', lastActivity: 1 }],
      instances: [conductor('T'), conductor('P', { temp: false }), conductor('E', { status: 'exited' }), conductor('C', { status: 'crashed' })],
    });
    renderSidebar();
    await settle();
    expect(promoteOf(conductorRowOf('T')).length).toBe(1);
    for (const sid of ['P', 'E', 'C', 'D']) expect(promoteOf(conductorRowOf(sid)), sid).toEqual([]);
    expect(closeOf(conductorRowOf('P'))).toEqual([]);
    for (const sid of ['E', 'C', 'D']) expect(archiveOf(conductorRowOf(sid)).length, sid).toBe(1);
  });

  it("a conductor's ↑ promotes it through promoteSession with its instance id and shown label, titled or untitled, and never selects or resumes", async () => {
    // Invariant: the ↑ sends .conduct, the conductor's instance and the label the row renders: its title, else its normalised first prompt.
    seed({ instances: [conductor('A', { title: 'Alpha' }), conductor('B', { firstPrompt: 'plan   the\nwork' })] });
    renderSidebar();
    await settle();
    expect(conductorRowOf('B').textContent).toContain('plan the work');
    fireEvent.click(promoteOf(conductorRowOf('B'))[0]);
    fireEvent.click(promoteOf(conductorRowOf('A'))[0]);
    expect(promoteSession.mock.calls).toEqual([
      [{ projectName: '.conduct', instanceId: 'i-B', preview: 'plan the work' }],
      [{ projectName: '.conduct', instanceId: 'i-A', preview: 'Alpha' }],
    ]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("a conductor's ↑ reads the freshest instance after a re-render, on the same button", async () => {
    // Invariant: the ↑ survives a re-render and promotes the conductor's instance and label at click time.
    seed({ instances: [conductor('A')] });
    renderSidebar();
    await settle();
    const before = promoteOf(conductorRowOf('A'))[0];
    act(() => appStore.set({ instances: [conductor('A', { id: 'i-A2', title: 'Renamed' })] }));
    const after = promoteOf(conductorRowOf('A'))[0];
    expect(after === before).toBe(true);
    fireEvent.click(after);
    expect(promoteSession.mock.calls).toEqual([[{ projectName: '.conduct', instanceId: 'i-A2', preview: 'Renamed' }]]);
  });

  it('promoting a conductor drops its ↑ in place, and a later disk row for it adds no second row', async () => {
    // Invariant: the conductor row survives the promote and the disk row's arrival, stays live, and never gains a close.
    seed({ instances: [conductor('A', { title: 'Alpha' })] });
    renderSidebar();
    await settle();
    const row = conductorRowOf('A');
    expect(promoteOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { title: 'Alpha', temp: false })] }));
    expect(conductorRowOf('A') === row).toBe(true);
    expect(promoteOf(row)).toEqual([]);
    act(() => appStore.set({ conductSessions: [{ sessionId: 'A', lastActivity: 1 }] }));
    expect(document.querySelectorAll('[data-conductor="A"]').length).toBe(1);
    expect(conductorRowOf('A') === row).toBe(true);
    expect(inactiveGroup()).toBeNull();
    expect(closeOf(row)).toEqual([]);
  });

  it('a temp conductor dying loses its ↑ as it moves to Inactive', async () => {
    // Invariant: an exited temp conductor sits under Inactive with the archive and no ↑.
    sidebarStore.set({ inactiveOpen: true });
    seed({ instances: [conductor('A')] });
    renderSidebar();
    await settle();
    expect(promoteOf(conductorRowOf('A')).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { status: 'exited' })] }));
    expect(inactiveSids()).toEqual(['A']);
    expect(promoteOf(conductorRowOf('A'))).toEqual([]);
    expect(archiveOf(conductorRowOf('A')).length).toBe(1);
  });
});
