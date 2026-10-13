import '@/test/browserHash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { routeStore, syncRoute } from '@/state/route';
import { uiStore } from '@/app/ui';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');

beforeEach(() => {
  localStorage.clear();
  uiStore.set({ lens: 'projects', sidebarOpen: false });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
  history.replaceState(null, '', location.pathname);
  syncRoute();
});

describe.each([{ mobile: false }, { mobile: true }])('sidebar entry points (mobile: $mobile)', ({ mobile }) => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const trigger = () => screen.getByRole('button', { name: 'Project actions' });
  const open = async () => {
    await settle();
    await act(async () => { trigger().focus(); fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); });
    await settle();
    expect(screen.queryAllByRole('menu').length, 'menu opened').toBe(1);
  };
  const mount = () => {
    if (mobile) uiStore.set({ sidebarOpen: true });
    return render(<TooltipProvider><AppSidebar mobile={mobile} /></TooltipProvider>);
  };

  it('the ≡ menu keeps New project and its other items, and has no Settings item', async () => {
    // Invariant: Settings has a single entry point (the header ⚙); the ≡ menu lists exactly its other items, in order.
    mount();
    await open();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent!.trim()))
      .toEqual(['New project', 'Add existing directory', 'New workspace', 'Costs']);
    expect(screen.queryByRole('menuitem', { name: /settings/i })).toBeNull();
  });

  it('Costs in the ≡ menu opens the cost dashboard', async () => {
    // Invariant: the ≡ menu's Costs item is the Cost dashboard's entry point and closes the phone drawer.
    mount();
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Costs/ })); });
    expect(routeStore.get().route.view).toBe('costs');
    expect(location.hash).toBe('#costs');
    if (mobile) expect(uiStore.get().sidebarOpen).toBe(false);
  });

  it('the header ⚙ Settings button opens Settings', async () => {
    // Invariant: the header ⚙ is Settings' entry point and closes the phone drawer.
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })); });
    expect(routeStore.get().route.view).toBe('settings');
    expect(location.hash).toBe('#settings');
    if (mobile) expect(uiStore.get().sidebarOpen).toBe(false);
  });
});
