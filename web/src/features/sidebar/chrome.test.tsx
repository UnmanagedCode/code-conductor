import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
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
const { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } = await import('./derive');
const { closeDialog, dialogStore } = await import('@/features/dialogs/api');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
const column = () => document.querySelector('aside[data-sidebar], [data-sidebar]') as HTMLElement;
const widthPx = () => parseInt(column().style.width, 10);

beforeEach(() => {
  localStorage.clear();
  closeDialog('adoptProject');
  uiStore.set({ lens: 'conductors' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

describe('the sidebar column width at startup', () => {
  it('applies an in-range stored width and clamps an out-of-range one to the limits', () => {
    // Invariant: a stored width is honoured inside the allowed range and pulled to the nearest limit outside it.
    const inRange = Math.round((SIDEBAR_MIN_WIDTH + SIDEBAR_MAX_WIDTH) / 2) + 7;
    const seen: number[] = [];
    for (const stored of [String(inRange), String(SIDEBAR_MAX_WIDTH + 400), '1']) {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, stored);
      const r = renderSidebar();
      seen.push(widthPx());
      r.unmount();
    }
    expect(seen).toEqual([inRange, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH]);
  });

  it('falls back to the same default for garbage storage as for no storage', () => {
    // Invariant: an unusable stored width never produces a broken column; it behaves as if nothing was stored.
    let r = renderSidebar();
    const none = widthPx();
    r.unmount();
    expect(none).toBe(SIDEBAR_DEFAULT_WIDTH);
    for (const garbage of ['abc', 'NaN', 'Infinity']) {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, garbage);
      r = renderSidebar();
      expect(widthPx(), garbage).toBe(none);
      r.unmount();
    }
  });
});

describe('the ≡ project-actions menu', () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const trigger = () => screen.getByRole('button', { name: 'Project actions' });
  const open = async () => {
    await settle();
    await act(async () => { trigger().focus(); fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); });
    await settle();
    expect(screen.queryAllByRole('menu').length, 'menu opened').toBe(1);
  };
  const isOpen = () => screen.queryAllByRole('menu').length === 1;

  it('opens from its trigger and reports it through aria-expanded, and the trigger closes it again', async () => {
    // Invariant: the trigger toggles the menu and aria-expanded tracks it.
    renderSidebar();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    await act(async () => { fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false }); });
    expect(isOpen()).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a press outside and on Escape', async () => {
    // Invariant: an outside pointerdown and Escape each dismiss the menu.
    renderSidebar();
    await open();
    await act(async () => { fireEvent.pointerDown(document.body); });
    expect(isOpen(), 'a press outside').toBe(false);

    await open();
    await act(async () => { fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); });
    expect(isOpen(), 'Escape').toBe(false);
  });

  it('closes after an item is picked, and a press on the menu itself does not close it', async () => {
    // Invariant: choosing an item runs it and dismisses the menu; a press inside the panel keeps it open.
    renderSidebar();
    await open();
    await act(async () => { fireEvent.pointerDown(screen.getByRole('menu')); });
    expect(isOpen(), 'a press inside').toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Add existing directory/ })); });
    expect(isOpen(), 'an item pick').toBe(false);
    expect(dialogStore.get().adoptProject).toBe(true);
  });

  it('is dismissed by switching to the Conductors lens', async () => {
    // Invariant: switching lens while the ≡ menu is open leaves no menu behind.
    uiStore.set({ lens: 'projects' });
    renderSidebar();
    await open();
    const tab = screen.getByRole('tab', { name: 'Conductors' });
    await act(async () => { fireEvent.pointerDown(tab); fireEvent.mouseDown(tab); });
    expect(uiStore.get().lens).toBe('conductors');
    expect(isOpen()).toBe(false);
  });
});

describe("the phone drawer's close", () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  it("is the drawer's one close, the header row's control right after ⚙, and closes the drawer", async () => {
    // Invariant: the drawer's single close × lives in the sidebar header row with the other header controls, so it shares their line and right edge.
    uiStore.set({ sidebarOpen: true });
    render(
      <TooltipProvider>
        <Sheet open onOpenChange={(o) => uiStore.set({ sidebarOpen: o })}>
          <SheetContent side="left"><SheetTitle>Navigation</SheetTitle><AppSidebar mobile /></SheetContent>
        </Sheet>
      </TooltipProvider>,
    );
    await settle();
    const closes = within(screen.getByRole('dialog')).queryAllByRole('button', { name: 'Close' });
    expect(closes).toHaveLength(1);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(closes[0].parentElement === settings.parentElement, 'in the header row').toBe(true);
    expect(settings.nextElementSibling === closes[0], 'right after ⚙').toBe(true);
    fireEvent.click(closes[0]);
    expect(uiStore.get().sidebarOpen).toBe(false);
  });

  it('the desktop column has no close', () => {
    // Invariant: the desktop column renders no close control.
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
