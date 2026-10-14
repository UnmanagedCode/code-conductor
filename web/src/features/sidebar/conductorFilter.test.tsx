// The Projects lens's conductor filter on the seeded fleet: selecting an owner,
// Hand-spawned only, clearing it, falling back to All, and the idle-chip and
// spawn-history owners it offers.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { chooseOption, selectOptions } from '@/test/radixSelect';
import {
  A, ALPHA, B, BRAVO, C, COLOUR, FLEET_UI, NO_BAR, barOf, el, fleet, hand, headOf, proj, rowOf, seed, seedFleet, worker, wt,
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
const { sidebarStore, invalidateSessions } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** C's label: its first prompt on disk. */
const CHARLIE = 'charlie: an old run';
const trigger = () => screen.getByRole('combobox', { name: 'Filter by conductor' });
/** Picks a filter option by its label and lets the lists it shows load. */
async function pick(label: string) {
  chooseOption(trigger(), label);
  await settle();
}
/** The option labels the filter offers, in order; leaves the menu closed. */
function offered(): string[] {
  const labels = selectOptions(trigger());
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  return labels;
}
const filterRoot = () => el('[data-filter]');
const projectNames = () => [...document.querySelectorAll('[data-project-list] [data-project-row]')].map((e) => e.getAttribute('data-project-row'));
const workspaceNames = () => [...document.querySelectorAll('section[data-workspace]')].map((e) => e.getAttribute('data-workspace')).filter((w) => w);
const worktreeNames = (project: string) =>
  [...document.querySelectorAll(`[data-worktrees="${project}"] [data-worktree-row]`)].map((e) => e.getAttribute('data-worktree-row'));
const toggleOf = (project: string) => el(`[data-worktrees="${project}"] > button`);
/** A place's session rows, in order. */
const rowIds = (key: string) =>
  [...document.querySelectorAll(`ul[data-sessions="${key}"] > li[data-session-row]`)].map((e) => e.getAttribute('data-session-row'));
/** A place's list items in order: rows by session id, anything else as `sep:<text>`. */
const listItems = (key: string) =>
  [...document.querySelectorAll(`ul[data-sessions="${key}"] > li`)].map((e) => e.getAttribute('data-session-row') ?? `sep:${e.textContent}`);
/** What a listed project's entry holds below its row. */
function parts(project: string) {
  const li = el(`li[data-project="${project}"]`);
  return {
    sessions: li.querySelector(`[data-sessions="${project}"]`) !== null,
    worktrees: li.querySelector(`[data-worktrees="${project}"]`) !== null,
    rows: li.querySelectorAll('[data-session-row]').length,
    hint: (li.textContent ?? '').includes('No sessions yet'),
  };
}
/** A project row listed alone: no Sessions subnode, no Worktrees group, no rows, no hint. */
const BARE = { sessions: false, worktrees: false, rows: 0, hint: false };
/** The fleet's instances with each of B's workers exited (the server clears a dead instance's owner). */
const withoutB = (f: Fleet) => f.instances.map((i) => (i.ownerSessionId === B ? { ...i, status: 'exited', ownerSessionId: null } : i));
/** The fleet plus a worktree `solo-b` holding only B's worker, so `solo` lists a worktree A does not hold. */
function splitSolo(): Fleet {
  const f = fleet();
  f.projects = f.projects.map((p) => (p.name === 'solo' ? { ...p, worktrees: [wt('solo-a'), wt('solo-b')] } : p));
  f.instances.push(worker('wb-solo', B, 'solo', 'solo-b'));
  return f;
}
/**
 * The fleet with `main` (all conducted) in workspace Ops, an empty workspace,
 * `wt-disk-hand` (a conducted main checkout; a hand session on disk only in its
 * worktree `w`) and `disk-hand` (a hand session on disk in its main checkout;
 * only conducted sessions in its worktrees, one on disk and one live).
 */
function handWorld(): Fleet {
  const f = fleet();
  f.projects = f.projects.map((p) => (p.name === 'main' ? { ...p, workspace: 'Ops' } : p));
  f.workspaces = ['Acme', 'Empty', 'Ops'];
  f.projects.push(
    proj('wt-disk-hand', {
      isGitRepo: true,
      sessions: { count: 1, archivedCount: 0, handCount: 0, lastActivity: 5 },
      worktrees: [wt('w', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 5 } })],
    }),
    proj('disk-hand', {
      isGitRepo: true,
      sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 5 },
      worktrees: [wt('disk-conducted', { sessions: { count: 1, archivedCount: 0, handCount: 0, lastActivity: 5 } }), wt('live-conducted')],
    }),
  );
  f.instances.push(worker('wa-live', A, 'disk-hand', 'live-conducted'));
  return f;
}
const HP_UI = { expandedWorkspaces: ['Acme', 'Empty', 'Ops'], expandedWorktrees: ['solo', 'mixed', 'wt-disk-hand', 'disk-hand'] };
const ALL_HP = ['solo', 'mixed', 'main', 'hand', 'idle', 'wt-disk-hand', 'disk-hand'];
const HAND_HP = ['solo', 'mixed', 'hand', 'wt-disk-hand', 'disk-hand'];

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  promoteSession.mockReset();
  loadSessions.mockReset().mockResolvedValue([]);
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '', ...FLEET_UI });
  uiStore.set({ lens: 'projects' });
  seed();
});

describe('selecting an owner', () => {
  it('filtering to a conductor lists only the projects and workspaces holding its chips, force-opens their Worktrees groups without recording it, and lists only its worktrees and rows', async () => {
    // Invariant: an owner filter narrows projects, workspaces, worktrees and rows to that owner's, opens Worktrees without writing the user's record, and follows the owner chosen.
    const f = splitSolo();
    f.projects = f.projects.map((p) => (p.name === 'hand' ? { ...p, workspace: 'Ops' } : p));
    f.workspaces = ['Acme', 'Ops'];
    sidebarStore.set({ expandedWorkspaces: ['Acme', 'Ops'], expandedWorktrees: [] });
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(projectNames()).toEqual(['solo', 'mixed', 'hand', 'main', 'idle']);
    expect(workspaceNames()).toEqual(['Acme', 'Ops']);
    expect(toggleOf('solo').getAttribute('aria-expanded')).toBe('false');
    await pick(ALPHA);
    expect(projectNames()).toEqual(['solo', 'mixed', 'main', 'idle']);
    expect(workspaceNames()).toEqual(['Acme']);
    expect(toggleOf('solo').getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf('mixed').getAttribute('aria-expanded')).toBe('true');
    expect(sidebarStore.get().expandedWorktrees).toEqual([]);
    expect(worktreeNames('solo')).toEqual(['solo-a']);
    expect(rowIds('solo:solo-a')).toEqual(['wa-solo1', 'wa-solo2']);
    expect(rowIds('mixed:mix')).toEqual(['wa-mix']);
    expect(rowIds('main')).toEqual(['wa-main1', 'wa-main2']);
    await pick(BRAVO);
    expect(projectNames()).toEqual(['solo', 'mixed', 'main']);
    expect(worktreeNames('solo')).toEqual(['solo-b']);
    expect(rowIds('mixed:mix')).toEqual(['wb-mix']);
    expect(rowIds('main')).toEqual(['wb-main']);
  });

  it("under a conductor filter a mixed worktree stays listed with its head plain, and only that conductor's rows carry its bar", async () => {
    // Invariant: ownership is classified from every live instance, never the filtered view: a mixed worktree's head stays plain under either owner's filter.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    await pick(ALPHA);
    expect(headOf('mix')).not.toBeNull();
    expect(barOf(headOf('mix'))).toEqual(NO_BAR);
    expect(headOf('mix').hasAttribute('title')).toBe(false);
    expect(barOf(rowOf('wa-mix'))).toEqual({ bar: true, color: COLOUR.A });
    expect(rowOf('wb-mix')).toBeNull();
    expect(rowOf('h-mix')).toBeNull();
    expect(barOf(headOf('solo-a'))).toEqual({ bar: true, color: COLOUR.A });
    await pick(BRAVO);
    expect(barOf(headOf('mix'))).toEqual(NO_BAR);
    expect(barOf(rowOf('wb-mix'))).toEqual({ bar: true, color: COLOUR.B });
    expect(rowOf('wa-mix')).toBeNull();
  });

  it("the filter root carries the selected conductor's colour, and none for All or Hand-spawned", async () => {
    // Invariant: the root's bar and colour follow the selected owner, and only an owner draws one.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(filterRoot().getAttribute('data-filter')).toBe('all');
    expect(barOf(filterRoot())).toEqual(NO_BAR);
    await pick(BRAVO);
    expect(filterRoot().getAttribute('data-filter')).toBe(B);
    expect(barOf(filterRoot())).toEqual({ bar: true, color: COLOUR.B });
    await pick(ALPHA);
    expect(barOf(filterRoot())).toEqual({ bar: true, color: COLOUR.A });
    await pick('Hand-spawned only');
    expect(filterRoot().getAttribute('data-filter')).toBe('hand');
    expect(barOf(filterRoot())).toEqual(NO_BAR);
    await pick('All sessions');
    expect(filterRoot().getAttribute('data-filter')).toBe('all');
    expect(barOf(filterRoot())).toEqual(NO_BAR);
  });

  it('a conductor filter that leaves one group names it in the summary and keeps the count whole', async () => {
    // Invariant: which groups a place shows is judged on the filtered rows, so a filter leaving only conducted rows drops the label and names the group in the summary, while the total stays the place's whole count.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const summary = () => el('[data-sessions-summary="mixed:mix"]').textContent;
    expect(summary()).toBe('Sessions (3) · 3 live');
    await pick(ALPHA);
    expect(listItems('mixed:mix')).toEqual(['wa-mix']);
    expect(summary()).toBe('Conducted sessions (3) · 3 live');
  });

  it('a chosen filter survives the sidebar unmounting and mounting again, as the phone drawer does', async () => {
    // Invariant: the filter is module state, not component state.
    seedFleet(fleet());
    const first = renderSidebar();
    await settle();
    await pick(BRAVO);
    first.unmount();
    renderSidebar();
    await settle();
    expect(filterRoot().getAttribute('data-filter')).toBe(B);
    expect(projectNames()).toEqual(['mixed', 'main']);
  });
});

describe('Hand-spawned only', () => {
  it('Hand-spawned only drops conducted rows and the Conducted label, and hides a project whose sessions are all conducted', async () => {
    // Invariant: Hand-spawned only keeps exactly the non-conducted rows, the label leaves with the conducted rows, and an all-conducted project leaves the tree.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(listItems('mixed:mix')).toEqual(['h-mix', 'sep:Conducted · 2', 'wa-mix', 'wb-mix']);
    expect(projectNames()).toEqual(['solo', 'mixed', 'main', 'hand', 'idle']);
    await pick('Hand-spawned only');
    expect(listItems('mixed:mix')).toEqual(['h-mix']);
    expect(listItems('solo:solo-a')).toEqual(['h-solo']);
    expect(rowIds('hand')).toEqual(['h-hand']);
    expect(projectNames()).toEqual(['solo', 'mixed', 'hand']);
  });

  it('Hand-spawned only lists only the worktrees and Sessions subnodes holding a hand-spawned session, force-opens nothing, and keeps the counts whole', async () => {
    // Invariant: inside a shown project Hand-spawned only narrows worktrees and subnodes, never opens a group or writes the record, and leaves the counts unfiltered.
    const f = splitSolo();
    f.instances.push(worker('wa-solo-main', A, 'solo'));
    sidebarStore.set({ expandedWorktrees: [] });
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(document.querySelector('[data-sessions="solo"]')).not.toBeNull();
    await pick('Hand-spawned only');
    expect(toggleOf('solo').getAttribute('aria-expanded')).toBe('false');
    expect(sidebarStore.get().expandedWorktrees).toEqual([]);
    expect(document.querySelector('[data-sessions="solo"]')).toBeNull();
    expect(document.querySelector('[data-sessions="hand"]')).not.toBeNull();
    fireEvent.click(toggleOf('solo'));
    await settle();
    expect(worktreeNames('solo')).toEqual(['solo-a']);
    expect(toggleOf('solo').textContent).toBe('Worktrees (2)');
    expect(rowIds('solo:solo-a')).toEqual(['h-solo']);
    expect(el('[data-sessions-summary="solo:solo-a"]').textContent).toBe('Sessions (3) · 3 live');
    await pick('All sessions');
    expect(worktreeNames('solo')).toEqual(['solo-a', 'solo-b']);
    expect(document.querySelector('[data-sessions="solo"]')).not.toBeNull();
  });
});

describe('Hand-spawned only hides places with no hand-spawned session', () => {
  it('a project with no sessions at all is hidden, beside one shown for its hand session', async () => {
    // Invariant: a zero-session project is hidden under Hand-spawned only while a hand-holding one stays.
    sidebarStore.set(HP_UI);
    seedFleet(handWorld());
    renderSidebar();
    await settle();
    expect(projectNames()).toEqual(ALL_HP);
    await pick('Hand-spawned only');
    expect(projectNames()).not.toContain('idle');
    expect(projectNames()).toContain('hand');
  });

  it('an on-disk hand-spawned session in a worktree shows a project whose main checkout holds only conducted sessions', async () => {
    // Invariant: a worktree's on-disk handCount alone keeps its project, and that worktree, listed.
    sidebarStore.set(HP_UI);
    seedFleet(handWorld());
    renderSidebar();
    await settle();
    await pick('Hand-spawned only');
    expect(projectNames()).toContain('wt-disk-hand');
    expect(projectNames()).not.toContain('main');
    expect(worktreeNames('wt-disk-hand')).toEqual(['w']);
  });

  it('a main checkout holding only conducted sessions loses its Sessions subnode', async () => {
    // Invariant: under Hand-spawned only a main checkout's subnode shows only with a hand session.
    sidebarStore.set(HP_UI);
    seedFleet(handWorld());
    renderSidebar();
    await settle();
    expect(parts('wt-disk-hand').sessions).toBe(true);
    await pick('Hand-spawned only');
    expect(parts('wt-disk-hand').sessions).toBe(false);
    expect(parts('disk-hand').sessions).toBe(true);
  });

  it('a shown project whose worktrees hold only conducted sessions has no Worktrees group', async () => {
    // Invariant: the Worktrees group shows only when a worktree holds a hand session, on disk or live.
    sidebarStore.set(HP_UI);
    seedFleet(handWorld());
    renderSidebar();
    await settle();
    expect(parts('disk-hand').worktrees).toBe(true);
    await pick('Hand-spawned only');
    expect(projectNames()).toContain('disk-hand');
    expect(parts('disk-hand').worktrees).toBe(false);
    expect(parts('wt-disk-hand').worktrees).toBe(true);
  });

  it('switching back to All restores every project, workspace, Sessions subnode and Worktrees group', async () => {
    // Invariant: Hand-spawned only lists exactly the hand-holding projects and their workspaces, and All restores the whole tree.
    sidebarStore.set(HP_UI);
    seedFleet(handWorld());
    renderSidebar();
    await settle();
    await pick('Hand-spawned only');
    expect(projectNames()).toEqual(HAND_HP);
    expect(workspaceNames()).toEqual(['Acme']);
    await pick('All sessions');
    expect(projectNames()).toEqual(ALL_HP);
    expect(workspaceNames()).toEqual(['Acme', 'Empty', 'Ops']);
    expect(parts('wt-disk-hand').sessions).toBe(true);
    expect(parts('disk-hand').worktrees).toBe(true);
  });
});

describe('clearing and falling back', () => {
  it("clearing a conductor filter restores the user's own Worktrees expansion on the same nodes, and a click on a forced-open group records nothing", async () => {
    // Invariant: the force-open is never recorded, so clearing returns each group to the user's own state, closed or open.
    sidebarStore.set({ expandedWorktrees: ['mixed'] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const solo = toggleOf('solo');
    expect(solo.getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf('mixed').getAttribute('aria-expanded')).toBe('true');
    await pick(ALPHA);
    expect(toggleOf('solo').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggleOf('mixed'));
    expect(sidebarStore.get().expandedWorktrees).toEqual(['mixed']);
    await pick('All sessions');
    expect(toggleOf('solo') === solo).toBe(true);
    expect(solo.getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf('mixed').getAttribute('aria-expanded')).toBe('true');
    expect(sidebarStore.get().expandedWorktrees).toEqual(['mixed']);
  });

  it("the filter falls back to All when its conductor's last live worker exits and it has no idle chip", async () => {
    // Invariant: an owner no longer offered drops out of the options and its filter returns to All with the whole tree.
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(offered()).toEqual(['All sessions', 'Hand-spawned only', ALPHA, BRAVO, CHARLIE]);
    await pick(BRAVO);
    expect(projectNames()).toEqual(['mixed', 'main']);
    act(() => appStore.set({ instances: withoutB(f) }));
    await settle();
    expect(sidebarStore.get().filter).toBe('');
    expect(filterRoot().getAttribute('data-filter')).toBe('all');
    expect(projectNames()).toEqual(['solo', 'mixed', 'main', 'hand', 'idle']);
    expect(offered()).toEqual(['All sessions', 'Hand-spawned only', ALPHA, CHARLIE]);
  });

  it('the filter falls back to All while the Conductors lens shows, without waiting for the Projects lens', async () => {
    // Invariant: the fallback follows the data in either lens (docs/features.md states it unconditionally).
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    await pick(BRAVO);
    expect(sidebarStore.get().filter).toBe(B);
    act(() => uiStore.set({ lens: 'conductors' }));
    expect(document.querySelector('[data-filter]')).toBeNull();
    act(() => appStore.set({ instances: withoutB(f) }));
    await settle();
    expect(sidebarStore.get().filter).toBe('');
    act(() => uiStore.set({ lens: 'projects' }));
    await settle();
    expect(filterRoot().getAttribute('data-filter')).toBe('all');
  });

  it('a conductor keeps its filter entry after its last live worker exits while it has an idle chip, and lists those projects as bare rows', async () => {
    // Invariant: a registered idle chip keeps the owner offered and selected, its projects listed bare.
    const f = fleet();
    f.conductorSpawns[B] = [{ project: 'mixed', lastSpawnAt: '2026-01-03T00:00:00Z', worktrees: ['mix'] }, { project: 'hand', lastSpawnAt: '2026-01-02T00:00:00Z', worktrees: [] }];
    seedFleet(f);
    renderSidebar();
    await settle();
    await pick(BRAVO);
    expect(projectNames()).toEqual(['mixed', 'main', 'hand']);
    act(() => appStore.set({ instances: withoutB(f) }));
    await settle();
    expect(sidebarStore.get().filter).toBe(B);
    expect(filterRoot().getAttribute('data-filter')).toBe(B);
    expect(projectNames()).toEqual(['mixed', 'hand']);
    expect(parts('mixed')).toEqual(BARE);
    expect(parts('hand')).toEqual(BARE);
    expect(offered()).toContain(BRAVO);
  });

  it('a conductor whose recorded projects are all unregistered is not offered, and a filter set to it falls back to All', async () => {
    // Invariant: an unregistered spawn project is no chip; a filter set to an owner nothing offers returns to All.
    const f = fleet();
    f.conductorSpawns[C] = [{ project: 'removed', lastSpawnAt: '2026-01-01T00:00:00Z', worktrees: [] }];
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(offered()).toEqual(['All sessions', 'Hand-spawned only', ALPHA, BRAVO]);
    act(() => sidebarStore.set({ filter: C }));
    await settle();
    expect(sidebarStore.get().filter).toBe('');
    expect(filterRoot().getAttribute('data-filter')).toBe('all');
    expect(projectNames()).toEqual(['solo', 'mixed', 'main', 'hand', 'idle']);
  });
});

describe('idle chips and spawn history', () => {
  it('a conductor with only idle chips is offered after the live conductors and before other owners, and selecting it lists its idle projects as bare rows', async () => {
    // Invariant: an inactive conductor with a registered idle chip is offered in the conductor block, and its filter lists those projects bare, even ones holding other owners' sessions.
    const f = fleet();
    f.conductorSpawns[C] = [{ project: 'solo', lastSpawnAt: '2026-01-02T00:00:00Z', worktrees: ['solo-a'] }, { project: 'idle', lastSpawnAt: '2026-01-01T00:00:00Z', worktrees: [] }];
    f.instances.push(hand('own-h', 'hand', null, { title: 'hand owner' }), worker('wh', 'own-h', 'hand'));
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(offered()).toEqual(['All sessions', 'Hand-spawned only', ALPHA, BRAVO, CHARLIE, 'hand owner']);
    await pick(CHARLIE);
    expect(projectNames()).toEqual(['solo', 'idle']);
    expect(workspaceNames()).toEqual(['Acme']);
    expect(parts('solo')).toEqual(BARE);
    expect(parts('idle')).toEqual(BARE);
    act(() => appStore.set({ instances: [...f.instances] }));
    await settle();
    expect(sidebarStore.get().filter).toBe(C);
  });

  it("a live conductor's selection adds its idle projects as bare rows beside its live ones", async () => {
    // Invariant: a live owner's filter lists its live places in full and its idle chips bare, with no empty-project hint.
    sidebarStore.set({ expandedWorktrees: [] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(parts('idle').hint).toBe(true);
    await pick(ALPHA);
    expect(projectNames()).toEqual(['solo', 'mixed', 'main', 'idle']);
    expect(parts('idle')).toEqual(BARE);
    expect(parts('main')).toEqual({ sessions: true, worktrees: false, rows: 2, hint: false });
    expect(rowIds('main')).toEqual(['wa-main1', 'wa-main2']);
    expect(toggleOf('solo').getAttribute('aria-expanded')).toBe('true');
    expect(rowIds('mixed:mix')).toEqual(['wa-mix']);
  });

  it('a root with only spawn history that is not a conductor is not offered, while an inactive conductor with the same history is', async () => {
    // Invariant: spawn history offers a conductor, never a root that is neither a conductor nor a live owner.
    const f = fleet();
    f.conductorSpawns['root-x'] = [{ project: 'idle', lastSpawnAt: '2026-01-03T00:00:00Z', worktrees: [] }];
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(offered()).toEqual(['All sessions', 'Hand-spawned only', ALPHA, BRAVO, CHARLIE]);
  });

  it("a live non-conductor owner's selection lists its spawn-history projects as bare rows beside its live ones", async () => {
    // Invariant: any live owner's filter reads its spawn history for idle projects, and lists only its own rows.
    const f = fleet();
    f.instances.push(hand('own-h', 'hand', null, { title: 'hand owner' }), worker('wh', 'own-h', 'hand'));
    f.conductorSpawns['own-h'] = [{ project: 'solo', lastSpawnAt: '2026-01-01T00:00:00Z', worktrees: [] }];
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(rowIds('hand')).toContain('h-hand');
    await pick('hand owner');
    expect(projectNames()).toEqual(['solo', 'hand']);
    expect(parts('solo')).toEqual(BARE);
    expect(rowIds('hand')).toEqual(['wh']);
  });
});
