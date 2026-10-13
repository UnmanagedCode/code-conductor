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
  it('a selected strip entry is marked active independently of unread, both ways across a selection change', async () => {
    // Invariant: selection and unread are separate marks: a selected unread entry carries both, an unselected unread one only unread, and the selection mark follows the change.
    seedStrip();
    renderSidebar();
    await settle();
    expect(stripEntryOf(A).getAttribute('data-active')).toBe('true');
    expect(stripEntryOf(A).getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf(B).hasAttribute('data-active')).toBe(false);
    expect(stripEntryOf(B).getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf('h').hasAttribute('data-active')).toBe(false);
    expect(stripEntryOf('h').hasAttribute('data-unread')).toBe(false);
    act(() => appStore.set({ activeId: 'i-h' }));
    expect(stripEntryOf('h').getAttribute('data-active')).toBe('true');
    expect(stripEntryOf(A).hasAttribute('data-active')).toBe(false);
    expect(stripEntryOf(A).getAttribute('data-unread')).toBe('true');
  });

  it('a selected strip entry is marked active, and only it, and keeps its owner colour', async () => {
    // Invariant: exactly the selected strip entry is marked, and the mark composes with the owner colour.
    seedStrip();
    renderSidebar();
    await settle();
    expect(stripEntryOf(A).getAttribute('data-active')).toBe('true');
    expect(barOf(stripEntryOf(A))).toEqual({ bar: true, color: COLOUR.A });
    expect(stripEntryOf(B).hasAttribute('data-active')).toBe(false);
    expect(stripEntryOf('h').hasAttribute('data-active')).toBe(false);
    act(() => appStore.set({ activeId: 'i-h' }));
    expect(stripEntryOf('h').getAttribute('data-active')).toBe('true');
    expect(stripEntryOf(A).hasAttribute('data-active')).toBe(false);
    expect(barOf(stripEntryOf(A))).toEqual({ bar: true, color: COLOUR.A });
  });
});
