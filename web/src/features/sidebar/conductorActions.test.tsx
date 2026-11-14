import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { CLOSE_TITLES } from '@shared/closeAction';
import { blockOf, conductor, conductorRowOf, el, inactiveGroup, proj, seed, treeOf, worker, wt } from '@/test/sidebarFleet';
import { settle } from '@/test/settle';

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
const persistSession = vi.fn();
vi.mock('@/app/sessionActions', () => ({
  loadSessions: (...a: unknown[]) => loadSessions(...a),
  closeSession: (...a: unknown[]) => closeSession(...a),
  resumeSession: (...a: unknown[]) => resumeSession(...a),
  persistSession: (...a: unknown[]) => persistSession(...a),
  removeWorktree: (...a: unknown[]) => removeWorktree(...a),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
/** The sidebar state a fresh page starts from, read before any test writes it. */
const FRESH = sidebarStore.get();

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);

/** The Inactive group's disclosure button. */
const inactiveToggle = () => inactiveGroup()?.querySelector(':scope > button[aria-expanded]') as HTMLElement | null;
/** The sids of the conductor blocks under the Inactive group, in order. */
const inactiveSids = () => [...inactiveGroup()!.querySelectorAll('[data-conductor]')].map((b) => b.getAttribute('data-conductor'));
const PERSIST = 'Make persistent';
const persistOf = (row: HTMLElement) => within(row).queryAllByRole('button', { name: PERSIST });
const closeOf = (row: HTMLElement) => [CLOSE_TITLES.stop, CLOSE_TITLES.archive].flatMap((name) => within(row).queryAllByRole('button', { name }));
const archiveOf = (row: HTMLElement) => within(row).queryAllByRole('button', { name: CLOSE_TITLES.archive });
const unreadOf = (row: HTMLElement) => row.querySelector('[data-unread]');
const expand = (sid: string) => { fireEvent.click(within(blockOf(sid)).getByRole('button', { name: 'Show workers' })); return treeOf(sid)!; };
const treeRowOf = (tree: HTMLElement, sid: string) => tree.querySelector(`[data-session-row="${sid}"] > [data-row]`) as HTMLElement | null;

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  persistSession.mockReset();
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
      conductSessions: [{ sessionId: 'T', title: 'Archived one', archived: true, lastActivity: 5 }, { sessionId: 'D', title: 'Kept', lastActivity: 1 }],
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
      instances: [conductor('A', { turnEndSeq: 2 }), worker('w', 'A', 'proj', null, { persistent: true }), conductor('X', { status: 'exited' })],
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
    // Invariant: each × hands closeSession its own conductor's place, instance, status, persistent flag, shown label and whether a transcript is listed.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      conductSessions: [{ sessionId: 'D', title: 'Disk', lastActivity: 3 }, { sessionId: 'B', lastActivity: 1 }],
      instances: [
        conductor('A', { title: 'Alpha', status: 'exited', lastResponseAt: 2 }),
        conductor('B', { firstPrompt: 'plan the work', status: 'crashed', persistent: true }),
      ],
    });
    renderSidebar();
    await settle();
    for (const sid of ['D', 'A', 'B']) fireEvent.click(archiveOf(conductorRowOf(sid))[0]);
    expect(closeSession.mock.calls).toEqual([
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'D', instanceId: null, status: null, persistent: false, preview: 'Disk', synthetic: false }],
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'A', instanceId: 'i-A', status: 'exited', persistent: false, preview: 'Alpha', synthetic: true }],
      [{ projectName: '.conduct', worktreeName: null, sessionId: 'B', instanceId: 'i-B', status: 'crashed', persistent: true, preview: 'plan the work', synthetic: false }],
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
  /** A's tree: live normal workers in the main checkout and a worktree, and a persistent one. */
  const workers = () => ({
    projects: [proj('proj', { worktrees: [wt('wt1')] })],
    instances: [
      conductor('A', { persistent: true }),
      worker('t', 'A', 'proj', null, { firstPrompt: 'do the work', createdAt: 3 }),
      worker('tw', 'A', 'proj', 'wt1', { firstPrompt: 'do more', createdAt: 2 }),
      worker('n', 'A', 'proj', null, { persistent: true, createdAt: 1 }),
    ],
  });

  it('a live normal worker row has one ↑ and no close action, and a persistent worker has neither', async () => {
    // Invariant: ↑ appears once on each live normal worker row, wherever it runs, and on no other; the tree has no close.
    seed(workers());
    renderSidebar();
    await settle();
    const tree = expand('A');
    for (const sid of ['t', 'tw']) {
      expect(persistOf(treeRowOf(tree, sid)!).length, sid).toBe(1);
      expect(closeOf(treeRowOf(tree, sid)!), sid).toEqual([]);
    }
    expect(persistOf(treeRowOf(tree, 'n')!)).toEqual([]);
    expect(closeOf(treeRowOf(tree, 'n')!)).toEqual([]);
  });

  it('an exited or crashed normal worker keeps its tree row without the ↑', async () => {
    // Invariant: only a live normal worker can be made persistent; a dead one still lists.
    seed({
      projects: [proj('proj')],
      instances: [
        conductor('A', { persistent: true }),
        worker('t', 'A', 'proj', null, {}),
        worker('xe', 'A', 'proj', null, { status: 'exited' }),
        worker('xc', 'A', 'proj', null, { status: 'crashed' }),
      ],
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    expect(persistOf(treeRowOf(tree, 't')!).length).toBe(1);
    for (const sid of ['xe', 'xc']) {
      expect(treeRowOf(tree, sid), sid).not.toBeNull();
      expect(persistOf(treeRowOf(tree, sid)!), sid).toEqual([]);
    }
  });

  it("a worker's ↑ persists it through persistSession with its project, instance id and label, in the main checkout and in a worktree, and never selects or resumes", async () => {
    // Invariant: each ↑ sends its own worker's project, instance and shown label, and the click stops at the button.
    seed(workers());
    renderSidebar();
    await settle();
    const tree = expand('A');
    fireEvent.click(persistOf(treeRowOf(tree, 'tw')!)[0]);
    fireEvent.click(persistOf(treeRowOf(tree, 't')!)[0]);
    expect(persistSession.mock.calls).toEqual([
      [{ projectName: 'proj', instanceId: 'i-tw', preview: 'do more' }],
      [{ projectName: 'proj', instanceId: 'i-t', preview: 'do the work' }],
    ]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("a worker's ↑ reads the freshest instance after a re-render, on the same button", async () => {
    // Invariant: the ↑ survives a re-render and persists the instance the worker has at click time.
    seed({ projects: [proj('proj')], instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const tree = expand('A');
    const before = persistOf(treeRowOf(tree, 't')!)[0];
    act(() => appStore.set({ instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj', null, { id: 'i-t2' })] }));
    const after = persistOf(treeRowOf(treeOf('A')!, 't')!)[0];
    expect(after === before).toBe(true);
    fireEvent.click(after);
    expect(persistSession.mock.calls.map(([a]) => a.instanceId)).toEqual(['i-t2']);
  });

  it('making a worker persistent drops its ↑ in place, and the worker stays in the tree', async () => {
    // Invariant: the live persistent flag alone decides the ↑; the row survives the flip.
    seed({ projects: [proj('proj')], instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const row = treeRowOf(expand('A'), 't')!;
    expect(persistOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj', null, { persistent: true })] }));
    expect(treeRowOf(treeOf('A')!, 't') === row).toBe(true);
    expect(persistOf(row)).toEqual([]);
  });

  it('a worker dying drops its ↑ in place', async () => {
    // Invariant: the row survives its worker's exit and loses the ↑.
    seed({ projects: [proj('proj')], instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj')] });
    renderSidebar();
    await settle();
    const row = treeRowOf(expand('A'), 't')!;
    expect(persistOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { persistent: true }), worker('t', 'A', 'proj', null, { status: 'exited' })] }));
    expect(treeRowOf(treeOf('A')!, 't') === row).toBe(true);
    expect(persistOf(row)).toEqual([]);
  });
});

describe('↑ Make persistent on a conductor row', () => {
  it('a live normal conductor row has one ↑ and no close action, and keeps its unread pill beside it', async () => {
    // Invariant: a live normal conductor row offers exactly one ↑ and no close, with or without unread turns.
    seed({ instances: [conductor('A'), conductor('U', { turnEndSeq: 3 })] });
    renderSidebar();
    await settle();
    for (const sid of ['A', 'U']) {
      expect(persistOf(conductorRowOf(sid)).length, sid).toBe(1);
      expect(closeOf(conductorRowOf(sid)), sid).toEqual([]);
    }
    expect(unreadOf(conductorRowOf('A'))).toBeNull();
    expect(unreadOf(conductorRowOf('U'))?.textContent).toBe('3');
  });

  it('no ↑ on a live persistent, exited, crashed or disk-only conductor row, and only the not-live ones carry the archive action', async () => {
    // Invariant: ↑ needs live and normal together; a close appears exactly on the rows that are not live.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      conductSessions: [{ sessionId: 'D', lastActivity: 1 }],
      instances: [conductor('T'), conductor('P', { persistent: true }), conductor('E', { status: 'exited' }), conductor('C', { status: 'crashed' })],
    });
    renderSidebar();
    await settle();
    expect(persistOf(conductorRowOf('T')).length).toBe(1);
    for (const sid of ['P', 'E', 'C', 'D']) expect(persistOf(conductorRowOf(sid)), sid).toEqual([]);
    expect(closeOf(conductorRowOf('P'))).toEqual([]);
    for (const sid of ['E', 'C', 'D']) expect(archiveOf(conductorRowOf(sid)).length, sid).toBe(1);
  });

  it('the ↑ follows liveness, not kind: of two normal conductors only the live one has it, and the dead one archives instead', async () => {
    // Invariant: ↑ is offered on a live normal conductor; a normal conductor whose instance exited is not live, so it gets no ↑ and its row's close is the archive.
    sidebarStore.set({ inactiveOpen: true });
    seed({ instances: [conductor('L', {}), conductor('X', { status: 'exited' })] });
    renderSidebar();
    await settle();
    expect(persistOf(conductorRowOf('L')).length).toBe(1);
    expect(persistOf(conductorRowOf('X'))).toEqual([]);
    expect(archiveOf(conductorRowOf('X')).length).toBe(1);
  });

  it("a conductor's ↑ persists it through persistSession with its instance id and shown label, titled or untitled, and never selects or resumes", async () => {
    // Invariant: the ↑ sends .conduct, the conductor's instance and the label the row renders: its title, else its normalised first prompt.
    seed({ instances: [conductor('A', { title: 'Alpha' }), conductor('B', { firstPrompt: 'plan   the\nwork' })] });
    renderSidebar();
    await settle();
    expect(conductorRowOf('B').textContent).toContain('plan the work');
    fireEvent.click(persistOf(conductorRowOf('B'))[0]);
    fireEvent.click(persistOf(conductorRowOf('A'))[0]);
    expect(persistSession.mock.calls).toEqual([
      [{ projectName: '.conduct', instanceId: 'i-B', preview: 'plan the work' }],
      [{ projectName: '.conduct', instanceId: 'i-A', preview: 'Alpha' }],
    ]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("a conductor's ↑ reads the freshest instance after a re-render, on the same button", async () => {
    // Invariant: the ↑ survives a re-render and persists the conductor's instance and label at click time.
    seed({ instances: [conductor('A')] });
    renderSidebar();
    await settle();
    const before = persistOf(conductorRowOf('A'))[0];
    act(() => appStore.set({ instances: [conductor('A', { id: 'i-A2', title: 'Renamed' })] }));
    const after = persistOf(conductorRowOf('A'))[0];
    expect(after === before).toBe(true);
    fireEvent.click(after);
    expect(persistSession.mock.calls).toEqual([[{ projectName: '.conduct', instanceId: 'i-A2', preview: 'Renamed' }]]);
  });

  it('making a conductor persistent drops its ↑ in place, and a later disk row for it adds no second row', async () => {
    // Invariant: the conductor row survives the persist and the disk row's arrival, stays live, and never gains a close.
    seed({ instances: [conductor('A', { title: 'Alpha' })] });
    renderSidebar();
    await settle();
    const row = conductorRowOf('A');
    expect(persistOf(row).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { title: 'Alpha', persistent: true })] }));
    expect(conductorRowOf('A') === row).toBe(true);
    expect(persistOf(row)).toEqual([]);
    act(() => appStore.set({ conductSessions: [{ sessionId: 'A', lastActivity: 1 }] }));
    expect(document.querySelectorAll('[data-conductor="A"]').length).toBe(1);
    expect(conductorRowOf('A') === row).toBe(true);
    expect(inactiveGroup()).toBeNull();
    expect(closeOf(row)).toEqual([]);
  });

  it('a normal conductor dying loses its ↑ as it moves to Inactive', async () => {
    // Invariant: an exited normal conductor sits under Inactive with the archive and no ↑.
    sidebarStore.set({ inactiveOpen: true });
    seed({ instances: [conductor('A')] });
    renderSidebar();
    await settle();
    expect(persistOf(conductorRowOf('A')).length).toBe(1);
    act(() => appStore.set({ instances: [conductor('A', { status: 'exited' })] }));
    expect(inactiveSids()).toEqual(['A']);
    expect(persistOf(conductorRowOf('A'))).toEqual([]);
    expect(archiveOf(conductorRowOf('A')).length).toBe(1);
  });
});
