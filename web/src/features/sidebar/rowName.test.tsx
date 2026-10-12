import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { conductor, conductorOpenOf, hand, openOf, proj, rowOf, seed, worker } from '@/test/sidebarFleet';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions, agoTick } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** The buttons whose accessible name is exactly `name`. */
const named = (name: string) => screen.queryAllByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  seed();
});
afterEach(() => vi.restoreAllMocks());

describe("a sidebar row's open button", () => {
  it('is named by its label, status and unread count, and keeps that name while its ago label ticks', async () => {
    // Invariant: the name carries what identifies and qualifies the row, never the relative time, so it is stable minute to minute.
    uiStore.set({ lens: 'projects' });
    const now = Date.now();
    seed({ projects: [proj('names')], instances: [hand('h-named', 'names', null, { title: 'Tidy the docs', lastResponseAt: now - 5_000, turnEndSeq: 3, viewedSeq: 0 })] });
    renderSidebar();
    await settle();
    expect(named('Tidy the docs, idle, 3 unread')).toEqual([openOf('h-named')]);
    const ago = rowOf('h-named').querySelector('[data-ago]')!.textContent;
    vi.spyOn(Date, 'now').mockReturnValue(now + 125_000);
    act(() => agoTick.bump());
    expect(rowOf('h-named').querySelector('[data-ago]')!.textContent, 'positive control: the ago label moved').not.toBe(ago);
    expect(named('Tidy the docs, idle, 3 unread')).toEqual([openOf('h-named')]);
  });

  it("names a read row by its label and status alone, and a worker's by its stage too", async () => {
    // Invariant: no unread part without unread turns; a bound worker's playbook · stage is in its name as it is on screen.
    uiStore.set({ lens: 'conductors' });
    sidebarStore.set({ expandedConductors: ['cond-n'] });
    seed({
      projects: [proj('names')],
      instances: [
        conductor('cond-n', { title: 'Alpha', temp: false, status: 'turn' }),
        worker('w-staged', 'cond-n', 'names', null, { playbook: 'pb', stage: 'build' }),
      ],
    });
    renderSidebar();
    await settle();
    expect(named('Alpha, running')).toEqual([conductorOpenOf('cond-n')]);
    expect(named('w-staged prompt, idle, pb · build')).toEqual([openOf('w-staged')]);
  });

  it('names a conductor row with its unread count', async () => {
    uiStore.set({ lens: 'conductors' });
    seed({ instances: [conductor('cond-u', { title: 'Bravo', temp: false, turnEndSeq: 2, viewedSeq: 0 })] });
    renderSidebar();
    await settle();
    expect(named('Bravo, idle, 2 unread')).toEqual([conductorOpenOf('cond-u')]);
  });

  it("keeps the status one field when the dot's own words carry a dash", async () => {
    // Invariant: the fields are comma-separated, so a status like 'idle — waiting on a worker' reads as one field.
    uiStore.set({ lens: 'projects' });
    seed({ projects: [proj('names')], instances: [hand('h-wake', 'names', null, { title: 'Tidy the docs', awaitingWake: true, turnEndSeq: 3, viewedSeq: 0 })] });
    renderSidebar();
    await settle();
    expect(named('Tidy the docs, idle — waiting on a worker, 3 unread')).toEqual([openOf('h-wake')]);
  });
});
