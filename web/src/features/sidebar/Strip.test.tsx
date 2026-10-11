import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { A, ALPHA, B, BRAVO, COLOUR, FLEET_UI, barOf, conductor, hand, proj, seed, stripEntryOf } from '@/test/sidebarFleet';

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

/** Three live idle sessions, all Finished: A selected and unread, B unread, h read. */
const seedStrip = () => seed({
  projects: [proj('p')],
  instances: [
    conductor(A, { title: ALPHA, turnEndSeq: 2, viewedSeq: 1 }),
    conductor(B, { temp: false, firstPrompt: BRAVO, turnEndSeq: 1, viewedSeq: 0 }),
    hand('h', 'p'),
  ],
  activeId: `i-${A}`,
});

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

describe('selected strip entry', () => {
  it('a selected strip entry reads bold, outranking the unread weight', async () => {
    // Invariant: selection bolds the strip entry and outranks the unread weight, both ways across a selection change.
    seedStrip();
    renderSidebar();
    await settle();
    expect(stripEntryOf(A).getAttribute('data-active')).toBe('true');
    expect(stripEntryOf(A).getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf(A).classList.contains('font-bold')).toBe(true);
    expect(stripEntryOf(A).classList.contains('font-semibold')).toBe(false);
    expect(stripEntryOf(B).classList.contains('font-semibold')).toBe(true);
    expect(stripEntryOf(B).classList.contains('font-bold')).toBe(false);
    expect(stripEntryOf('h').classList.contains('font-bold')).toBe(false);
    expect(stripEntryOf('h').classList.contains('font-semibold')).toBe(false);
    act(() => appStore.set({ activeId: 'i-h' }));
    expect(stripEntryOf('h').classList.contains('font-bold')).toBe(true);
    expect(stripEntryOf(A).classList.contains('font-semibold')).toBe(true);
    expect(stripEntryOf(A).classList.contains('font-bold')).toBe(false);
    expect(stripEntryOf(A).hasAttribute('data-active')).toBe(false);
  });

  it('a selected strip entry draws the selection frame and keeps its owner bar, and only it is framed', async () => {
    // Invariant: exactly the selected strip entry is framed, and the frame composes with the owner bar.
    seedStrip();
    renderSidebar();
    await settle();
    expect(stripEntryOf(A).getAttribute('data-active')).toBe('true');
    expect(stripEntryOf(A).classList.contains('ring-1')).toBe(true);
    expect(stripEntryOf(A).classList.contains('ring-border')).toBe(true);
    expect(barOf(stripEntryOf(A))).toEqual({ bar: true, color: COLOUR.A });
    expect(stripEntryOf(B).classList.contains('ring-1')).toBe(false);
    expect(stripEntryOf('h').classList.contains('ring-1')).toBe(false);
    act(() => appStore.set({ activeId: 'i-h' }));
    expect(stripEntryOf('h').classList.contains('ring-1')).toBe(true);
    expect(stripEntryOf(A).classList.contains('ring-1')).toBe(false);
    expect(barOf(stripEntryOf(A))).toEqual({ bar: true, color: COLOUR.A });
  });
});
