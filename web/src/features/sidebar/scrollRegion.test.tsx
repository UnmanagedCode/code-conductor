// Which part of the sidebar scrolls: the list alone. The needs-you strip, the
// lens tabs and the Projects filter row sit outside the scroller; the strip is
// a bounded scroller of its own; and a remount still opens onto a selected
// strip entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { emit } from '@/app/events';
import { el, fleet, seedFleet, seed, FLEET_UI } from '@/test/sidebarFleet';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn((..._a: any[]): Promise<any[]> => Promise.resolve([])),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions, resetLensScroll } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function select(id: string | null) {
  act(() => {
    appStore.set({ activeId: id });
    emit('select', { id, sessionId: appStore.get().instances.find((i) => i.id === id)?.sessionId ?? null, userGesture: true });
  });
}

beforeEach(() => {
  localStorage.clear();
  invalidateSessions();
  resetLensScroll();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '', ...FLEET_UI });
  seed();
});

describe('the sidebar scroll region', () => {
  it('the strip, the tab bar and the filter row sit outside the sidebar\'s scroller, and the list inside it', async () => {
    // Invariant: only the list is scroll content; the chrome above it stays put.
    uiStore.set({ lens: 'projects' });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const body = document.querySelectorAll('[data-sidebar-body]');
    expect(body.length).toBe(1);
    const scroller = body[0];
    const strip = el('[data-strip]');
    expect(strip).not.toBeNull();
    expect(scroller.contains(strip)).toBe(false);
    expect(scroller.contains(screen.getByRole('tablist'))).toBe(false);
    expect(scroller.contains(screen.getByRole('button', { name: 'Project actions' }))).toBe(false);
    expect(scroller.contains(screen.getByRole('combobox', { name: 'Filter by conductor' }))).toBe(false);
    expect(scroller.contains(el('[data-project-list]'))).toBe(true);
    act(() => uiStore.set({ lens: 'conductors' }));
    expect(scroller.contains(el('[data-conductor-list]'))).toBe(true);
  });

  it('the scroller is the list\'s body, and the strip is its own bounded scroller', async () => {
    // Invariant: the list's body is the one scroll container above the list, and the strip scrolls within itself.
    uiStore.set({ lens: 'conductors' });
    seedFleet(fleet());
    renderSidebar();
    await settle();
    const body = el('[data-sidebar-body]');
    expect(el('[data-strip]')).not.toBeNull();
    expect(body.classList.contains('overflow-y-auto')).toBe(true);
    for (let n = body.parentElement; n && !n.hasAttribute('data-sidebar'); n = n.parentElement) {
      expect(n.classList.contains('overflow-y-auto')).toBe(false);
    }
    expect(el('[data-strip]').classList.contains('overflow-y-auto')).toBe(true);
  });

  describe('on remount', () => {
    let scroll: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { scroll = vi.spyOn(Element.prototype, 'scrollIntoView'); });
    afterEach(() => { scroll.mockRestore(); });

    it('a sidebar mounting with a selected strip entry scrolls that entry into view', async () => {
      // Invariant: the mount reveal reaches the strip, wherever the strip sits in the sidebar.
      uiStore.set({ lens: 'conductors' });
      seedFleet(fleet());
      const first = renderSidebar();
      await settle();
      select('i-h-hand');
      first.unmount();
      scroll.mockClear();
      renderSidebar();
      const entry = el('[data-strip] [data-active="true"]');
      expect(entry).not.toBeNull();
      expect(scroll.mock.contexts.some((c: unknown) => c === entry)).toBe(true);
    });
  });
});
