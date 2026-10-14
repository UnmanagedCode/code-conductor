// Reveal on select on the seeded fleet: a selection opens its owner's bubble in
// the Conductors lens and every collapsed group on its path in the Projects
// lens, once per selection, a re-selection of the selected session included;
// and the sidebar, remounted as the phone drawer is, keeps each lens's scroll
// offset and opens onto the selected row.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { emit } from '@/app/events';
import { chooseOption } from '@/test/radixSelect';
import {
  A, ALPHA, B, FLEET_UI, blockOf, conductorRowOf, disk, el, fleet, projectRowOf, rowOf, seed, seedFleet, worker, wt,
  type Fleet,
} from '@/test/sidebarFleet';

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
const { sidebarStore, invalidateSessions, setSessionsOpen, setWorktreesOpen, resetLensScroll } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Runs every animation frame queued so far: the reveal scrolls in one. */
const nextFrame = () => act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); });

const WS_KEY = 'code-conductor:workspaces-expanded';

/**
 * What `selectInstance` does to the sidebar's inputs (the controller is mocked
 * here): sets the selection, then announces it. A click on the selected row
 * does the same with the same id.
 */
function select(id: string | null) {
  act(() => {
    appStore.set({ activeId: id });
    emit('select', { id, sessionId: appStore.get().instances.find((i) => i.id === id)?.sessionId ?? null, userGesture: true });
  });
}

const caretOf = (sid: string) => el(`[data-conductor="${sid}"] > [data-row] button[aria-label="Show workers"]`);
/** `sid`'s row in a conductor's expanded tree, or null. */
const treeRowOf = (conductor: string, sid: string) =>
  blockOf(conductor).querySelector(`[data-session-row="${sid}"] > [data-row]`) as HTMLElement | null;
/** How many session rows a conductor's bubble holds (none while collapsed). */
const treeRows = (conductor: string) => blockOf(conductor).querySelectorAll('[data-session-row]').length;
/** The workspace's open/close toggle (`[aria-expanded]`: the header row also holds the Edit-workspace pencil button). */
const workspaceToggle = (name: string) => el(`section[data-workspace="${name}"] > div > button[aria-expanded]`);
const worktreesToggle = (project: string) => el(`[data-worktrees="${project}"] > button`);
/** The Sessions chevron on a worktree head, given that row's selector. */
const sessionsChevron = (row: string) => el(`${row} > button[aria-label="Sessions"]`);
/** The toggle of a project's main-checkout Sessions group. */
const projectSessionsToggle = (project: string) => el(`[data-project-sessions="${project}"] > button`);
const body = () => el('[data-sidebar-body]');
/** Scrolls the sidebar body as a user does: the offset, then the event. */
const scrollBody = (top: number) => {
  body().scrollTop = top;
  fireEvent.scroll(body());
};
const tab = (name: 'Conductors' | 'Projects') => screen.getByRole('tab', { name });
async function pick(label: string) {
  chooseOption(screen.getByRole('combobox', { name: 'Filter by conductor' }), label);
  await settle();
}

/** On-disk rows by place key: one in `solo-a`, one in `main`'s main checkout. */
const DISK: Record<string, any[]> = {
  'solo:solo-a': [disk('d-solo', 'solo on disk')],
  main: [disk('d-main', 'main on disk')],
};
/**
 * The fleet with a second worktree `solo-b` holding only B's worker, `hand`
 * moved to a second workspace `Ops`, and disk counts matching `DISK`.
 */
function pathWorld(): Fleet {
  const f = fleet();
  f.projects = f.projects.map((p) => {
    if (p.name === 'solo') return { ...p, worktrees: [wt('solo-a', { sessions: { count: 1, lastActivity: 5 } }), wt('solo-b')] };
    if (p.name === 'main') return { ...p, sessions: { count: 1, archivedCount: 0, handCount: 0, lastActivity: 5 } };
    if (p.name === 'hand') return { ...p, workspace: 'Ops' };
    return p;
  });
  f.workspaces = ['Acme', 'Ops'];
  f.instances.push(worker('wb-solo', B, 'solo', 'solo-b'));
  return f;
}

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  promoteSession.mockReset();
  loadSessions.mockReset().mockImplementation((...a: any[]) => Promise.resolve(DISK[a[1] ? `${a[0]}:${a[1]}` : a[0]] ?? []));
  invalidateSessions();
  resetLensScroll();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '', ...FLEET_UI });
  // An empty selection first: the reveal's module memory starts from "nothing selected".
  seed();
});

describe('Conductors lens', () => {
  beforeEach(() => { uiStore.set({ lens: 'conductors' }); });

  it("selecting a worker expands its owning bubble only and highlights its row in that tree, and another conductor's worker opens that one's", async () => {
    // Invariant: a worker's selection opens exactly its owner's bubble and marks only its row there; the reveal never closes a bubble.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
    expect(caretOf(B).getAttribute('aria-expanded')).toBe('false');
    select('i-wa-solo1');
    expect(sidebarStore.get().expandedConductors).toEqual([A]);
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('true');
    expect(treeRowOf(A, 'wa-solo1')?.getAttribute('data-active')).toBe('true');
    expect(treeRowOf(A, 'wa-solo2')?.hasAttribute('data-active')).toBe(false);
    expect(caretOf(B).getAttribute('aria-expanded')).toBe('false');
    expect(treeRows(B)).toBe(0);
    expect(sidebarStore.get().inactiveOpen).toBe(false);
    select('i-wb-main');
    expect(sidebarStore.get().expandedConductors).toEqual([A, B]);
    expect(treeRowOf(B, 'wb-main')?.getAttribute('data-active')).toBe('true');
    expect(treeRowOf(A, 'wa-solo1')?.hasAttribute('data-active')).toBe(false);
  });

  it('a worker spawned by a worker opens the root owner bubble and shows highlighted in its tree', async () => {
    // Invariant: a nested worker (its caller a worker, its owner the root conductor) reveals under the root's bubble only.
    const f = fleet();
    f.instances.push(worker('wa-nested', A, 'solo', 'solo-a', { callerInstanceId: 'i-wa-solo1' }));
    seedFleet(f);
    renderSidebar();
    await settle();
    select('i-wa-nested');
    expect(sidebarStore.get().expandedConductors).toEqual([A]);
    expect(treeRowOf(A, 'wa-nested')?.getAttribute('data-active')).toBe('true');
    expect(caretOf(B).getAttribute('aria-expanded')).toBe('false');
    expect(treeRows(B)).toBe(0);
  });

  it('selecting a live conductor opens no bubble, its own included, and changes no group', async () => {
    // Invariant: a conductor is its own bubble's head: its selection marks its row and writes no sidebar state.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const before = { ...sidebarStore.get() };
    select(`i-${A}`);
    expect(sidebarStore.get()).toEqual(before);
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
    expect(treeRows(A)).toBe(0);
    expect(conductorRowOf(A).getAttribute('data-active')).toBe('true');
    expect(caretOf(B).getAttribute('aria-expanded')).toBe('false');
  });

  it('the reveal fires once per selection: a manual collapse survives re-renders, and selecting another session and back re-opens it', async () => {
    // Invariant: only a selection reveals; a re-render with the same selection leaves the user's collapse alone.
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    select('i-wa-solo1');
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(caretOf(A));
    expect(sidebarStore.get().expandedConductors).toEqual([]);
    act(() => appStore.set({ instances: f.instances.map((i) => ({ ...i })) }));
    act(() => appStore.set({ projects: [...f.projects] }));
    await settle();
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
    select('i-wb-main');
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
    select('i-wa-solo1');
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('true');
  });

  it('selecting the selected session again re-opens what the user collapsed on its path, in both lenses, and only that', async () => {
    // Invariant: every selection reveals, the selected session's re-selection included (a click on the selected row or its strip entry).
    seedFleet(fleet());
    renderSidebar();
    await settle();
    select('i-wa-solo1');
    expect(sidebarStore.get().expandedConductors).toEqual([A]);
    fireEvent.click(caretOf(A));
    act(() => setWorktreesOpen('solo', false));
    act(() => setWorktreesOpen('mixed', false));
    act(() => setSessionsOpen('solo:solo-a', false));
    expect(sidebarStore.get().expandedConductors).toEqual([]);
    expect(sidebarStore.get().expandedWorktrees).toEqual([]);
    select('i-wa-solo1');
    expect(sidebarStore.get().expandedConductors).toEqual([A]);
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('true');
    expect(sidebarStore.get().expandedWorktrees).toEqual(['solo']);
    expect(sidebarStore.get().collapsedSessions).toEqual([]);
  });

  it('a hand-spawned session opens no bubble, and a null selection changes nothing', async () => {
    // Invariant: only an owned session opens a bubble, and clearing the selection reveals nothing, a collapsed bubble included.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    select('i-h-hand');
    expect(sidebarStore.get().expandedConductors).toEqual([]);
    expect(sidebarStore.get().inactiveOpen).toBe(false);
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
    expect(caretOf(B).getAttribute('aria-expanded')).toBe('false');
    select('i-wa-solo1');
    fireEvent.click(caretOf(A));
    const before = { ...sidebarStore.get() };
    select(null);
    expect(sidebarStore.get()).toEqual(before);
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('false');
  });

  it('a selection whose instance is not listed yet is revealed once it appears, and only once', async () => {
    // Invariant: a selection set before its instance lists (a resume in flight) stays pending until the instance appears, then reveals once.
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    act(() => appStore.set({ activeId: 'i-wa-late' }));
    expect(sidebarStore.get().expandedConductors).toEqual([]);
    act(() => appStore.set({ instances: [...f.instances, worker('wa-late', A, 'mixed', 'mix')] }));
    expect(sidebarStore.get().expandedConductors).toEqual([A]);
    fireEvent.click(caretOf(A));
    act(() => appStore.set({ instances: [...appStore.get().instances] }));
    expect(sidebarStore.get().expandedConductors).toEqual([]);
  });
});

describe('Projects lens', () => {
  beforeEach(() => { uiStore.set({ lens: 'projects' }); });

  it('every collapsed group on the path opens (workspace, Worktrees group, Sessions group) and its list loads, and only that path', async () => {
    // Invariant: a selection opens exactly its workspace, its project's Worktrees group and its place's Sessions group, and the place's disk list loads; siblings at each level stay closed.
    sidebarStore.set({ expandedWorkspaces: [], expandedWorktrees: [], collapsedSessions: ['solo:solo-a', 'solo:solo-b', 'mixed:mix'] });
    seedFleet(pathWorld());
    renderSidebar();
    await settle();
    expect(workspaceToggle('Acme').getAttribute('aria-expanded')).toBe('false');
    expect(workspaceToggle('Ops').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-project="solo"]')).toBeNull();
    expect(loadSessions.mock.calls.filter(([p]) => p === 'solo')).toEqual([]);
    loadSessions.mockClear();
    select('i-wa-solo1');
    await settle();
    expect(sidebarStore.get().expandedWorkspaces).toEqual(['Acme']);
    expect(JSON.parse(localStorage.getItem(WS_KEY) ?? 'null')).toEqual(['Acme']);
    expect(workspaceToggle('Acme').getAttribute('aria-expanded')).toBe('true');
    expect(workspaceToggle('Ops').getAttribute('aria-expanded')).toBe('false');
    expect(sidebarStore.get().expandedWorktrees).toEqual(['solo']);
    expect(worktreesToggle('solo').getAttribute('aria-expanded')).toBe('true');
    expect(worktreesToggle('mixed').getAttribute('aria-expanded')).toBe('false');
    expect(sidebarStore.get().collapsedSessions).toEqual(['solo:solo-b', 'mixed:mix']);
    expect(sessionsChevron('[data-worktree-row="solo-a"]').getAttribute('aria-expanded')).toBe('true');
    expect(sessionsChevron('[data-worktree-row="solo-b"]').getAttribute('aria-expanded')).toBe('false');
    expect(rowOf('wa-solo1').getAttribute('data-active')).toBe('true');
    expect(rowOf('d-solo')).not.toBeNull();
    expect(loadSessions.mock.calls).toEqual([['solo', 'solo-a']]);
  });

  it('a collapsed main-checkout Sessions group re-opens on the same project row and its list loads, and another collapsed group stays', async () => {
    // Invariant: the reveal re-opens the group in place (same row and toggle nodes), loads only its list, and leaves another collapsed group collapsed.
    sidebarStore.set({ expandedWorkspaces: ['Acme', 'Ops'], collapsedSessions: ['main', 'hand'] });
    seedFleet(pathWorld());
    renderSidebar();
    await settle();
    const row = projectRowOf('main');
    const chevron = projectSessionsToggle('main');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-sessions="main"]')).toBeNull();
    expect(loadSessions.mock.calls.filter(([p]) => p === 'main')).toEqual([]);
    loadSessions.mockClear();
    select('i-wa-main1');
    await settle();
    expect(projectRowOf('main') === row).toBe(true);
    expect(projectSessionsToggle('main') === chevron).toBe(true);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(loadSessions.mock.calls).toEqual([['main', null]]);
    expect(rowOf('wa-main1').getAttribute('data-active')).toBe('true');
    expect(rowOf('d-main')).not.toBeNull();
    expect(projectSessionsToggle('hand').getAttribute('aria-expanded')).toBe('false');
    expect(sidebarStore.get().collapsedSessions).toEqual(['hand']);
  });

  it('the reveal persists the workspace itself, even when it is already open', async () => {
    // Invariant: the reveal saves the workspace it reveals whatever its state; nothing else had saved it.
    seedFleet(pathWorld());
    renderSidebar();
    await settle();
    expect(workspaceToggle('Acme').getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(WS_KEY)).toBeNull();
    select('i-wa-solo1');
    expect(workspaceToggle('Acme').getAttribute('aria-expanded')).toBe('true');
    expect(JSON.parse(localStorage.getItem(WS_KEY) ?? 'null')).toEqual(['Acme']);
    expect(workspaceToggle('Ops').getAttribute('aria-expanded')).toBe('false');
  });

  it("a Worktrees group revealed under an owner filter stays open once the filter clears, and only that project's", async () => {
    // Invariant: the reveal records the Worktrees group the filter only force-opened, so it outlives the filter; a group only forced returns to closed.
    sidebarStore.set({ expandedWorktrees: [] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(worktreesToggle('solo').getAttribute('aria-expanded')).toBe('false');
    await pick(ALPHA);
    expect(worktreesToggle('solo').getAttribute('aria-expanded')).toBe('true');
    expect(worktreesToggle('mixed').getAttribute('aria-expanded')).toBe('true');
    expect(sidebarStore.get().expandedWorktrees).toEqual([]);
    select('i-wa-solo1');
    expect(sidebarStore.get().expandedWorktrees).toEqual(['solo']);
    await pick('All sessions');
    expect(worktreesToggle('solo').getAttribute('aria-expanded')).toBe('true');
    expect(worktreesToggle('mixed').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Projects-lens filter', () => {
  beforeEach(() => { uiStore.set({ lens: 'projects' }); });

  it('selecting a conductor leaves the filter, every Projects group and the stored expansion unchanged', async () => {
    // Invariant: a conductor has no Projects row, so its selection switches no filter and opens no group, even one the filter hides.
    sidebarStore.set({ collapsedSessions: ['main'] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    await pick(ALPHA);
    const before = { ...sidebarStore.get() };
    const toggles = () => [...document.querySelectorAll('[data-project-list] button[aria-expanded]')].map((b) => b.getAttribute('aria-expanded'));
    const shown = toggles();
    select(`i-${B}`);
    await settle();
    expect(sidebarStore.get()).toEqual(before);
    expect(toggles()).toEqual(shown);
    expect(el('[data-filter]').getAttribute('data-filter')).toBe(A);
    expect(localStorage.getItem(WS_KEY)).toBeNull();
  });
});

describe('the phone drawer', () => {
  let scroll: MockInstance<(arg?: boolean | ScrollIntoViewOptions) => void>;
  beforeEach(() => {
    uiStore.set({ lens: 'projects' });
    scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
  });
  afterEach(() => { scroll.mockRestore(); });

  it('a reveal survives the sidebar unmounting and mounting again, as the phone drawer does on a selection', async () => {
    // Invariant: what a reveal opens is module state, so the drawer's remount shows it in both lenses.
    sidebarStore.set({ expandedWorkspaces: [], expandedWorktrees: [] });
    seedFleet(fleet());
    const first = renderSidebar();
    await settle();
    select('i-wa-solo1');
    first.unmount();
    renderSidebar();
    await settle();
    expect(workspaceToggle('Acme').getAttribute('aria-expanded')).toBe('true');
    expect(worktreesToggle('solo').getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('wa-solo1').getAttribute('data-active')).toBe('true');
    act(() => uiStore.set({ lens: 'conductors' }));
    expect(caretOf(A).getAttribute('aria-expanded')).toBe('true');
  });

  it('the reveal scrolls the selected row into view on the next frame, once the groups it opened have rendered', async () => {
    // Invariant: the scroll waits a frame, so it lands on the row the reveal itself had to open, and on that row only.
    sidebarStore.set({ collapsedSessions: ['main'] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    await nextFrame();
    scroll.mockClear();
    select('i-wa-main1');
    expect(scroll).not.toHaveBeenCalled();
    await nextFrame();
    expect(scroll.mock.contexts.length).toBe(1);
    expect(scroll.mock.contexts[0] === rowOf('wa-main1')).toBe(true);
    expect(scroll.mock.calls[0]).toEqual([{ block: 'nearest' }]);
  });

  it('a sidebar mounting with a selection scrolls its row into view, as the phone drawer does on re-opening, and one mounting with none scrolls nothing', async () => {
    // Invariant: a mount scrolls exactly the selected rows into view, so a re-opened drawer opens onto the selection.
    seedFleet(fleet());
    const first = renderSidebar();
    await settle();
    select('i-wa-main1');
    await nextFrame();
    first.unmount();
    scroll.mockClear();
    const second = renderSidebar();
    expect(scroll.mock.contexts.length).toBe(1);
    expect(scroll.mock.contexts[0] === rowOf('wa-main1')).toBe(true);
    expect(scroll.mock.calls[0]).toEqual([{ block: 'nearest' }]);
    second.unmount();
    select(null);
    await nextFrame();
    scroll.mockClear();
    renderSidebar();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('each lens keeps its own scroll offset across a lens switch and across the sidebar unmounting and mounting again', async () => {
    // Invariant: the body's offset is per-lens module state: a switch restores the lens shown, and a remount restores the lens it opens on.
    seedFleet(fleet());
    const first = renderSidebar();
    await settle();
    scrollBody(120);
    fireEvent.mouseDown(tab('Conductors'));
    expect(uiStore.get().lens).toBe('conductors');
    expect(body().scrollTop).toBe(0);
    scrollBody(40);
    fireEvent.mouseDown(tab('Projects'));
    expect(body().scrollTop).toBe(120);
    first.unmount();
    renderSidebar();
    expect(body().scrollTop).toBe(120);
    fireEvent.mouseDown(tab('Conductors'));
    expect(body().scrollTop).toBe(40);
  });

  it('resetting the lens offsets returns a remounted sidebar to the top of each lens', async () => {
    // Invariant: resetLensScroll (the tests' reset) forgets every lens's recorded offset.
    seedFleet(fleet());
    const first = renderSidebar();
    await settle();
    scrollBody(120);
    first.unmount();
    resetLensScroll();
    renderSidebar();
    expect(body().scrollTop).toBe(0);
  });
});
