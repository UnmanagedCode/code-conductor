import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import {
  A, ALPHA, BRAVO, C, COLOUR, FLEET_UI, NO_BAR, barOf, conductor, disk, fleet, headOf, labelOf, openOf, proj, projectRowOf, rowOf,
  seed, seedFleet, worker, wt,
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

describe('Projects-lens ownership colour', () => {
  it("a single-conductor worktree head carries its conductor's bar and names it, and its session rows, hand-spawned included, carry none", async () => {
    // Invariant: single ownership draws the bar and the name on the head only, and a hand session leaves the ownership single.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(barOf(headOf('solo-a'))).toEqual({ bar: true, color: COLOUR.A });
    expect(headOf('solo-a').getAttribute('title')).toBe('conductor: Alpha');
    expect(barOf(rowOf('wa-solo1'))).toEqual(NO_BAR);
    expect(openOf('wa-solo1').title).not.toContain('conductor:');
    expect(barOf(rowOf('wa-solo2'))).toEqual(NO_BAR);
    expect(openOf('wa-solo2').title).not.toContain('conductor:');
    expect(barOf(rowOf('h-solo'))).toEqual(NO_BAR);
    expect(openOf('h-solo').title).not.toContain('conductor:');
    expect(barOf(headOf('mix')).bar).toBe(false);
  });

  it("a mixed worktree head stays plain, each live conducted row carries its own conductor's bar and names it, and a hand-spawned row carries none", async () => {
    // Invariant: two owners move the bar off the head onto each owned row, coloured and named by that row's own owner.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(barOf(headOf('mix'))).toEqual(NO_BAR);
    expect(headOf('mix').hasAttribute('title')).toBe(false);
    expect(barOf(rowOf('wa-mix'))).toEqual({ bar: true, color: COLOUR.A });
    expect(openOf('wa-mix').title).toMatch(/\nconductor: Alpha$/);
    expect(barOf(rowOf('wb-mix'))).toEqual({ bar: true, color: COLOUR.B });
    expect(openOf('wb-mix').title.endsWith(`\nconductor: ${BRAVO}`)).toBe(true);
    expect(barOf(rowOf('h-mix'))).toEqual(NO_BAR);
  });

  it('main-checkout conducted rows carry their own bar per conductor, and no project row is ever coloured', async () => {
    // Invariant: a main-checkout row always shows its own owner's bar, and a project row never draws one.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(barOf(rowOf('wa-main1'))).toEqual({ bar: true, color: COLOUR.A });
    expect(barOf(rowOf('wa-main2'))).toEqual({ bar: true, color: COLOUR.A });
    expect(barOf(rowOf('wb-main'))).toEqual({ bar: true, color: COLOUR.B });
    expect(barOf(projectRowOf('main'))).toEqual(NO_BAR);
    expect(barOf(projectRowOf('solo'))).toEqual(NO_BAR);
  });

  it('a disk-only conducted row and an exited instance carry no bar beside a live owned row', async () => {
    // Invariant: only a live owner draws a bar; a conducted flag alone does not.
    const f = fleet();
    f.projects = f.projects.map((p) => (p.name === 'mixed' ? { ...p, worktrees: [wt('mix', { sessions: { count: 1, lastActivity: 5 } })] } : p));
    f.instances.push(worker('ex', A, 'mixed', 'mix', { status: 'exited', ownerSessionId: null }));
    loadSessions.mockImplementation(async (_p: string, w: string | null) =>
      (w === 'mix' ? [disk('disk-c', 'old conducted', { conducted: true, lastActivity: 5 })] : []));
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(rowOf('disk-c')).not.toBeNull();
    expect(barOf(rowOf('disk-c'))).toEqual(NO_BAR);
    expect(barOf(rowOf('ex'))).toEqual(NO_BAR);
    expect(barOf(rowOf('wa-mix'))).toEqual({ bar: true, color: COLOUR.A });
  });

  it('a worktree with no live conducted session is plain, even one another worktree builds on, while the worktree holding a worker is coloured', async () => {
    // Invariant: a place's ownership comes only from live conducted sessions in that place, never from a related worktree.
    const f = fleet();
    f.projects.push(proj('agg', {
      worktrees: [wt('old', { sessions: { count: 1, lastActivity: 5 } }), wt('feature'), wt('child', { baseBranch: 'cc/feature' })],
    }));
    f.instances.push(worker('wa-child', A, 'agg', 'child'));
    sidebarStore.set({ expandedWorktrees: [...FLEET_UI.expandedWorktrees, 'agg'] });
    loadSessions.mockImplementation(async (_p: string, w: string | null) =>
      (w === 'old' ? [disk('disk-old', 'old run', { conducted: true, lastActivity: 5 })] : []));
    seedFleet(f);
    renderSidebar();
    await settle();
    expect(rowOf('disk-old')).not.toBeNull();
    expect(barOf(headOf('old'))).toEqual(NO_BAR);
    expect(barOf(headOf('feature'))).toEqual(NO_BAR);
    expect(barOf(headOf('child'))).toEqual({ bar: true, color: COLOUR.A });
  });

  it("a row's bar clears in place when its worker dies, and the other owned rows keep theirs", async () => {
    // Invariant: a dead worker's bar clears on the same row node, and no other row's bar changes.
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    const before = rowOf('wa-main1');
    expect(barOf(before)).toEqual({ bar: true, color: COLOUR.A });
    act(() => appStore.set({
      instances: f.instances.map((i) => (i.sessionId === 'wa-main1' ? { ...i, status: 'exited', ownerSessionId: null } : i)),
    }));
    await settle();
    expect(rowOf('wa-main1') === before).toBe(true);
    expect(barOf(before)).toEqual(NO_BAR);
    expect(barOf(rowOf('wa-main2'))).toEqual({ bar: true, color: COLOUR.A });
    expect(barOf(rowOf('wb-main'))).toEqual({ bar: true, color: COLOUR.B });
  });

  it("a live owned session that also has a disk row keeps its owner's bar and names it", async () => {
    // Invariant: the live overlay of a disk row carries the instance's owner onto that row.
    const f = fleet();
    f.projects = f.projects.map((p) => (p.name === 'main' ? { ...p, sessions: { count: 1, archivedCount: 0, handCount: 0, lastActivity: 5 } } : p));
    f.instances = f.instances.map((i) => (i.sessionId === 'wa-main1' ? { ...i, temp: false } : i));
    loadSessions.mockImplementation(async (p: string, w: string | null) =>
      (p === 'main' && w === null ? [disk('wa-main1', 'resumed worker', { conducted: true, lastActivity: 5 })] : []));
    seedFleet(f);
    renderSidebar();
    await settle();
    // The disk row's prompt, not the instance's: the overlay branch, not the synthetic row.
    expect(labelOf('wa-main1').textContent).toBe('resumed worker');
    expect(barOf(rowOf('wa-main1'))).toEqual({ bar: true, color: COLOUR.A });
    expect(openOf('wa-main1').title).toMatch(/\nconductor: Alpha$/);
  });

  it('a single-owner worktree head keeps its bar while an owned worker remains, and loses it and its tooltip in place when the last one goes', async () => {
    // Invariant: the head's bar and tooltip follow the place's live owner set on the same node, leaving only with the last owned worker.
    const f = fleet();
    seedFleet(f);
    renderSidebar();
    await settle();
    const head = headOf('solo-a');
    expect(barOf(head)).toEqual({ bar: true, color: COLOUR.A });
    expect(head.getAttribute('title')).toBe('conductor: Alpha');
    act(() => appStore.set({ instances: f.instances.filter((i) => i.sessionId !== 'wa-solo1') }));
    await settle();
    expect(headOf('solo-a') === head).toBe(true);
    expect(barOf(head)).toEqual({ bar: true, color: COLOUR.A });
    expect(head.getAttribute('title')).toBe('conductor: Alpha');
    act(() => appStore.set({ instances: f.instances.filter((i) => i.sessionId !== 'wa-solo1' && i.sessionId !== 'wa-solo2') }));
    await settle();
    expect(headOf('solo-a') === head).toBe(true);
    expect(barOf(head)).toEqual(NO_BAR);
    expect(head.hasAttribute('title')).toBe(false);
    expect(rowOf('h-solo')).not.toBeNull();
  });

  it('the Projects lens lists no .conduct row while conductors are live and .conduct has disk rows', async () => {
    // Invariant: the Projects lens lists exactly the registered projects; live conductors and conduct rows add none.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect([...document.querySelectorAll('[data-project-row]')].map((e) => e.getAttribute('data-project-row')))
      .toEqual(['solo', 'mixed', 'main', 'hand', 'idle']);
    expect(document.querySelector('[data-project=".conduct"]')).toBeNull();
  });

  it('No projects yet shows while a conductor is live', async () => {
    // Invariant: the empty state depends only on registered projects, not on live conductors.
    seed({ instances: [conductor(A, { title: ALPHA })], conductSessions: [{ sessionId: C, lastActivity: 1 }] });
    renderSidebar();
    await settle();
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(document.querySelector('[data-project-list]')).toBeNull();
    act(() => uiStore.set({ lens: 'conductors' }));
    expect(document.querySelector(`[data-conductor="${A}"]`)).not.toBeNull();
  });

  it("hand-spawn controls stay in the Projects tree beside a conductor's workers", async () => {
    // Invariant: ownership never removes a project's or an owned worktree's spawn and removal controls.
    seedFleet(fleet());
    renderSidebar();
    await settle();
    expect(within(projectRowOf('solo')).getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(within(projectRowOf('solo')).getByRole('button', { name: 'Delete project' })).toBeTruthy();
    expect(within(headOf('solo-a')).getByRole('button', { name: 'New session in this worktree' })).toBeTruthy();
    expect(within(headOf('solo-a')).getByRole('button', { name: 'Remove worktree' })).toBeTruthy();
  });
});

describe('selected session row', () => {
  it('a selected session row is marked active independently of its unread pill and keeps its owner colour', async () => {
    // Invariant: selection marks exactly one session row and never swallows its unread pill, so selected stays distinct from unread; the owner colour survives selection.
    const f = fleet();
    const seqs: Record<string, { turnEndSeq: number; viewedSeq: number }> = {
      'wa-main1': { turnEndSeq: 3, viewedSeq: 1 },
      'wa-main2': { turnEndSeq: 2, viewedSeq: 1 },
      'wb-main': { turnEndSeq: 1, viewedSeq: 1 },
    };
    f.instances = f.instances.map((i) => ({ ...i, ...seqs[i.sessionId] }));
    seedFleet(f, { activeId: 'i-wa-main1' });
    renderSidebar();
    await settle();
    const pill = (sid: string) => rowOf(sid).querySelector('[data-unread]')?.textContent ?? null;
    expect(rowOf('wa-main1').getAttribute('data-active')).toBe('true');
    expect(pill('wa-main1')).toBe('2');
    expect(barOf(rowOf('wa-main1'))).toEqual({ bar: true, color: COLOUR.A });
    expect(rowOf('wa-main2').hasAttribute('data-active')).toBe(false);
    expect(pill('wa-main2')).toBe('1');
    expect(rowOf('wb-main').hasAttribute('data-active')).toBe(false);
    expect(pill('wb-main')).toBeNull();
    act(() => appStore.set({ activeId: 'i-wb-main' }));
    expect(rowOf('wb-main').getAttribute('data-active')).toBe('true');
    expect(rowOf('wa-main1').hasAttribute('data-active')).toBe(false);
    expect(pill('wa-main1')).toBe('2');
  });
});
