import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import {
  A, ALPHA, B, BRAVO, COLOUR, FLEET_UI, NO_BAR, barOf, blockOf, conductor, conductorDotOf, conductorRowOf, el, fleet,
  proj, seed, seedFleet, stripEntryOf, worker,
} from '@/test/sidebarFleet';
import { conductorColor } from '@/lib/core/conductorColor.js';
import { formatAutoResumeTime } from '@/lib/core/usage.js';

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
const { sidebarStore, invalidateSessions, agoTick } = await import('./state');

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
  uiStore.set({ lens: 'conductors' });
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Conductors-lens conductor rows', () => {
  it('a row click selects a live conductor with a gesture, opens a dead one by its instance and resumes a disk-only one in .conduct, and a caret click does none of these', async () => {
    // Invariant: a live conductor selects with a gesture, a dead instance opens by its instanceId, a disk-only conductor resumes in .conduct, and the caret only expands.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      instances: [conductor('ca', { title: 'Live A' }), conductor('cx', { status: 'crashed', title: 'Crashed X' })],
      conductSessions: [{ sessionId: 'cd', title: 'Disk D', lastActivity: 1 }],
    });
    renderSidebar();
    await settle();
    fireEvent.click(conductorRowOf('ca'));
    expect(selectInstance.mock.calls).toEqual([['i-ca', { userGesture: true }]]);
    fireEvent.click(conductorRowOf('cd'));
    expect(resumeSession.mock.calls).toEqual([[{ projectName: '.conduct', worktreeName: null, sessionId: 'cd' }]]);
    fireEvent.click(conductorRowOf('cx'));
    expect(selectInstance.mock.calls[1]).toEqual(['i-cx', { userGesture: true }]);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    const caret = within(blockOf('ca')).getByRole('button', { name: 'Show workers' });
    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(selectInstance).toHaveBeenCalledTimes(2);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("a conductor block carries its own conductor's colour", async () => {
    // Invariant: each block, active or inactive, is coloured by its own sid, so the three colours are pairwise distinct.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      instances: [conductor(A, { title: ALPHA }), conductor(B, { temp: false, firstPrompt: BRAVO })],
      conductSessions: [{ sessionId: 'cd', title: 'Disk D', lastActivity: 1 }],
    });
    renderSidebar();
    await settle();
    expect(blockOf(A).style.getPropertyValue('--owner-color')).toBe(COLOUR.A);
    expect(blockOf(B).style.getPropertyValue('--owner-color')).toBe(COLOUR.B);
    expect(blockOf('cd').style.getPropertyValue('--owner-color')).toBe(conductorColor('cd'));
    expect(new Set([COLOUR.A, COLOUR.B, conductorColor('cd')]).size).toBe(3);
  });

  it('worker rows in an expanded conductor tree carry no owner bar, though the same worker carries one in the Projects lens', async () => {
    // Invariant: the conductor tree never draws the owner bar on its rows; the same instance draws one in the Projects lens.
    sidebarStore.set({ expandedConductors: [A] });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const rows = [...blockOf(A).querySelectorAll('[data-session-row] > [role="button"]')] as HTMLElement[];
    expect(rows.length).toBe(5);
    expect(rows.map(barOf)).toEqual([NO_BAR, NO_BAR, NO_BAR, NO_BAR, NO_BAR]);
    act(() => uiStore.set({ lens: 'projects' }));
    await settle();
    expect(barOf(el('[data-project="main"] [data-session-row="wa-main1"] > [role="button"]'))).toEqual({ bar: true, color: COLOUR.A });
  });

  it("a conductor row's dot keeps the running, waiting-on-a-worker, waiting-on-a-job and idle semantics", async () => {
    // Invariant: the dot's state and tooltip follow status, awaitingWake and waitingOnJob, a worker or a job reading as waiting, and an idle wait reads differently from plain idle.
    seed({ instances: [conductor('cw', { awaitingWake: true }), conductor('cr', { status: 'turn' }), conductor('cj', { waitingOnJob: true }), conductor('ci')] });
    renderSidebar();
    await settle();
    const d = conductorDotOf;
    expect(d('cw').getAttribute('data-dot')).toBe('idle');
    expect(d('cw').title).toBe('idle — waiting on a worker');
    expect(d('cj').getAttribute('data-dot')).toBe('idle');
    expect(d('cj').title).toBe('idle — waiting on a background job');
    expect(d('cr').getAttribute('data-dot')).toBe('turn');
    expect(d('cr').title).toBe('running');
    expect(d('ci').getAttribute('data-dot')).toBe('idle');
    expect(d('ci').title).toBe('idle');
  });

  it("a live conductor's dot is marked needs-you and titled by the ask, and an exited or disk-only conductor is never marked", async () => {
    // Invariant: the needs-you mark appears only on a live conductor with an ask, keeps the run-state dot and names the ask.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      instances: [
        conductor('ci', { awaitingUser: 'plan', awaitingUserSource: 'tool' }),
        conductor('ct', { status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' }),
        conductor('cw', { awaitingWake: true, awaitingUser: 'question', awaitingUserSource: 'tool' }),
        conductor('cx', { status: 'exited', awaitingUser: 'question', awaitingUserSource: 'tool' }),
      ],
      conductSessions: [{ sessionId: 'cd', lastActivity: 1, awaitingUser: 'question', awaitingUserSource: 'tool' }],
    });
    renderSidebar();
    await settle();
    const d = conductorDotOf;
    expect(d('ci').getAttribute('data-needs-you')).toBe('true');
    expect(d('ci').title).toBe('waiting on you (plan approval) · idle');
    expect(d('ci').getAttribute('data-dot')).toBe('idle');
    expect(d('ct').title).toBe('waiting on you (asked in text) · running');
    expect(d('ct').getAttribute('data-needs-you')).toBe('true');
    expect(d('ct').getAttribute('data-dot')).toBe('turn');
    expect(d('cw').title).toBe('waiting on you (question) · on a worker');
    expect(d('cw').getAttribute('data-needs-you')).toBe('true');
    expect(d('cw').getAttribute('data-dot')).toBe('idle');
    expect(d('cx').getAttribute('data-dot')).toBe('exited');
    expect(d('cx').hasAttribute('data-needs-you')).toBe(false);
    expect(d('cd').getAttribute('data-dot')).toBe('offline');
    expect(d('cd').hasAttribute('data-needs-you')).toBe(false);
  });

  it('the selected conductor row and the selected worker row in its tree are marked, and only they', async () => {
    // Invariant: the selection marks exactly the selected conductor row or tree worker row.
    sidebarStore.set({ expandedConductors: [A] });
    seedFleet(fleet(), { activeId: `i-${A}` });
    renderSidebar();
    await settle();
    expect(conductorRowOf(A).getAttribute('data-active')).toBe('true');
    expect(conductorRowOf(B).hasAttribute('data-active')).toBe(false);
    act(() => appStore.set({ activeId: 'i-wa-main1' }));
    expect(conductorRowOf(A).hasAttribute('data-active')).toBe(false);
    expect((blockOf(A).querySelector('[data-session-row="wa-main1"] > [role="button"]') as HTMLElement).getAttribute('data-active')).toBe('true');
  });

  it("a conductor row's ago label refreshes on the ago tick, in place", async () => {
    // Invariant: the ago tick alone re-renders the label against the clock; no store changes between the reads.
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.UTC(2026, 0, 1);
    vi.setSystemTime(T0);
    seed({ instances: [conductor('ca', { title: 'A', lastResponseAt: T0 - 5 * 60_000 })] });
    renderSidebar();
    await settle();
    const ago = conductorRowOf('ca').querySelector('[data-ago]') as HTMLElement;
    expect(ago.textContent).toBe('5m ago');
    vi.setSystemTime(T0 + 115 * 60_000);
    act(() => agoTick.bump());
    expect(conductorRowOf('ca').querySelector('[data-ago]') === ago).toBe(true);
    expect(ago.textContent).toBe('2h ago');
  });

  it("a conductor row is labelled by its title, and an untitled one by its first prompt", async () => {
    // Invariant: a titled conductor row shows its title; an untitled one falls back to its first prompt, and neither shows the other's label.
    seed({ instances: [conductor(A, { title: ALPHA }), conductor(B, { temp: false, firstPrompt: BRAVO })] });
    renderSidebar();
    await settle();
    expect(conductorRowOf(A).textContent).toContain(ALPHA);
    expect(conductorRowOf(A).textContent).not.toContain(BRAVO);
    expect(conductorRowOf(B).textContent).toContain(BRAVO);
    expect(conductorRowOf(B).textContent).not.toContain(ALPHA);
  });

  it('a conductor row pills its unread turn marks from a live instance or its .conduct row, and a read conductor has no pill', async () => {
    // Invariant: the pill shows turnEndSeq − viewedSeq, from the instance when live and from the .conduct row when not.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      instances: [conductor('ca', { turnEndSeq: 2, viewedSeq: 0 }), conductor('cb', { turnEndSeq: 1, viewedSeq: 1 })],
      conductSessions: [
        { sessionId: 'cd', lastActivity: 1, turnEndSeq: 4, viewedSeq: 1 },
        { sessionId: 'cr', lastActivity: 2, turnEndSeq: 2, viewedSeq: 2 },
      ],
    });
    renderSidebar();
    await settle();
    const pill = (s: string) => conductorRowOf(s).querySelector('[data-unread]');
    expect(pill('ca')?.textContent).toBe('2');
    expect(pill('cd')?.textContent).toBe('3');
    expect(pill('cb')).toBeNull();
    expect(pill('cr')).toBeNull();
  });

  it("an armed conductor's auto-resume badge shows on its strip entry and on no Conductors-lens row, its worker's included", async () => {
    // Invariant: the armed badge lives on the strip entry only.
    const T = 1_900_000_000;
    sidebarStore.set({ expandedConductors: ['ca'] });
    seed({
      projects: [proj('p')],
      instances: [
        conductor('ca', { title: 'Armed A', autoResumeAt: T, queuedCount: 2 }),
        worker('w', 'ca', 'p', null, { autoResumeAt: T, queuedCount: 1 }),
      ],
    });
    renderSidebar();
    await settle();
    expect(blockOf('ca').querySelector('[data-session-row="w"]')).not.toBeNull();
    const clock = formatAutoResumeTime(T)!.replace(/^resumes at /, '');
    // Invariant: the badge is found by its tooltip, which leads with the full resume time; the strip has one and the conductor list none.
    const badge = `[title^="${formatAutoResumeTime(T)}"]`;
    const inStrip = stripEntryOf('ca').querySelector(badge) as HTMLElement;
    expect(inStrip.textContent).toMatch(/^2 ·/);
    expect(inStrip.textContent).toContain(clock);
    expect(el('[data-conductor-list]').querySelector(badge)).toBeNull();
  });
});

describe('selected conductor row', () => {
  it('a selected conductor row is marked data-active whether titled or untitled and keeps its unread pill, and the mark follows a selection change', async () => {
    // Invariant: selection marks exactly one conductor row, titled or untitled, and never swallows its unread pill, so selected stays distinct from unread.
    seed({
      instances: [conductor(A, { title: ALPHA, turnEndSeq: 2, viewedSeq: 1 }), conductor(B, { temp: false, firstPrompt: BRAVO })],
      activeId: `i-${A}`,
    });
    renderSidebar();
    await settle();
    const pill = (s: string) => conductorRowOf(s).querySelector('[data-unread]');
    expect(conductorRowOf(A).getAttribute('data-active')).toBe('true');
    expect(pill(A)?.textContent).toBe('1');
    expect(conductorRowOf(B).hasAttribute('data-active')).toBe(false);
    expect(pill(B)).toBeNull();
    act(() => appStore.set({ activeId: `i-${B}` }));
    expect(conductorRowOf(B).getAttribute('data-active')).toBe('true');
    expect(conductorRowOf(A).hasAttribute('data-active')).toBe(false);
    expect(pill(A)?.textContent).toBe('1');
  });
});
