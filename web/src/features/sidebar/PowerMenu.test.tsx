import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { bus } from '@shared/ws';
import { mockFetch } from '@/features/settings/test/fetchMock';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), persistSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { powerStore, STOPPED_STATUS } = await import('./restart');

let reload: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  powerStore.set({ inProgress: false, stopped: false });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
  reload = vi.fn<() => void>();
  vi.spyOn(location, 'reload').mockImplementation(reload);
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
});
afterEach(() => {
  // Fire any reload a shutdown left armed, so it cannot reach the next test.
  bus.dispatchEvent(new CustomEvent('open'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const footer = () => document.querySelector('[data-sidebar-footer]') as HTMLElement;
const trigger = () => within(footer()).getByRole('button', { name: 'Power' }) as HTMLButtonElement;
async function openMenu() {
  await act(async () => { fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false }); });
  return screen.getByRole('menu');
}
const item = (menu: HTMLElement, name: string) => within(menu).getByRole('menuitem', { name });

describe('the power menu', () => {
  it('offers exactly Restart and Shut down', async () => {
    // Invariant: the footer's power menu has two items, Restart and Shut down, and nothing else.
    const menu = await openMenu();
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual(['Restart', 'Shut down']);
  });

  it('Restart posts /api/admin/restart without autoContinue', async () => {
    // Invariant: the menu's Restart is gated — its body carries no autoContinue — then reloads once the replacement answers.
    let boot = 'old';
    const calls = mockFetch({
      'GET /api/health': () => ({ ok: true, bootId: boot }),
      'POST /api/admin/restart': () => { boot = 'new'; return { ok: true }; },
    });
    fireEvent.click(item(await openMenu(), 'Restart'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/admin/restart']);
    expect(posts[0].body).toEqual({});
  });

  it('Shut down posts /api/admin/shutdown, shows the stopped state, never polls health, and reloads only when the WebSocket reopens', async () => {
    // Invariant: after a shutdown the footer reads the stopped status, /api/health is never fetched, and the page reloads exactly when the WS opens again.
    const calls = mockFetch({ 'POST /api/admin/shutdown': () => ({ ok: true }) });
    fireEvent.click(item(await openMenu(), 'Shut down'));
    const status = () => footer().querySelector('[data-sidebar-status]')?.textContent ?? '';
    await waitFor(() => expect(status()).toContain(STOPPED_STATUS));
    act(() => appStore.set({ connection: 'reconnecting', everDropped: true }));
    expect(status()).toContain(STOPPED_STATUS);
    expect(status()).not.toContain('Reconnecting');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/admin/shutdown']);
    expect(reload).not.toHaveBeenCalled();
    act(() => { bus.dispatchEvent(new CustomEvent('open')); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a restart or shutdown is in progress', () => {
    // Invariant: an in-progress power action disables the trigger; it re-arms when the action ends.
    act(() => powerStore.set({ inProgress: true }));
    expect(trigger().disabled).toBe(true);
    act(() => powerStore.set({ inProgress: false }));
    expect(trigger().disabled).toBe(false);
  });
});
