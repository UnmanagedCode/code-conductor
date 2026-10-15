import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
const { sessionWidthStore } = await import('@/app/sessionWidth');

beforeEach(() => {
  localStorage.clear();
  sessionWidthStore.set({ width: 768, full: false });
  uiStore.set({ lens: 'conductors' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

const footer = () => document.querySelector('[data-sidebar-footer]') as HTMLElement;

describe('the session width control', () => {
  it('the trigger name follows the store, so the mode is readable without opening the popover', () => {
    // Invariant: the mode is readable without opening the popover.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const names: [Partial<{ width: number; full: boolean }>, string][] = [
      [{}, 'Normal'], [{ width: 1024 }, 'Wide'], [{ width: 896 }, '896 px'], [{ full: true }, 'Full'],
    ];
    for (const [patch, name] of names) {
      act(() => sessionWidthStore.set(patch));
      expect(within(footer()).queryByRole('button', { name: `Session width: ${name}` }), name).not.toBeNull();
    }
  });

  const openPopover = () => {
    fireEvent.click(within(footer()).getByRole('button', { name: /^Session width:/ }));
    return screen.getByRole('slider');
  };
  const closePopover = () => { fireEvent.keyDown(screen.getByRole('slider'), { key: 'Escape' }); };

  it('the slider is keyboard-operable and keyboard steps never snap', () => {
    // Invariant: keyboard operates the slider, and a step off a snap point does not snap back.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const slider = openPopover();
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(sessionWidthStore.get().width).toBe(784);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(sessionWidthStore.get().width).toBe(1600);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(sessionWidthStore.get().width).toBe(480);
    closePopover();
  });

  it('a pointer drag snaps near Normal/Wide and updates the column while dragging, not on release', () => {
    // Invariant: drags snap within the radius and update live, before the pointer is released.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const slider = openPopover();
    const root = document.querySelector('[data-slot=slider]') as HTMLElement;
    // 1 client px = 1 width px: the track spans MAX - MIN px from x = 0.
    root.getBoundingClientRect = () => ({ left: 0, right: 1120, width: 1120, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 1040 - 480, button: 0 });
    expect(sessionWidthStore.get().width).toBe(1024);
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 900 - 480 });
    expect(sessionWidthStore.get().width).toBe(896);
    fireEvent.pointerUp(root, { pointerId: 1 });
    expect(sessionWidthStore.get().width).toBe(896);
    expect(slider.getAttribute('aria-valuenow')).toBe('896');
    closePopover();
  });

  it('after a pointer drag, a keyboard step still does not snap', () => {
    // Invariant: a drag does not leave the slider in snapping mode; the next keyboard step from Normal sticks at 784.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const slider = openPopover();
    const root = document.querySelector('[data-slot=slider]') as HTMLElement;
    root.getBoundingClientRect = () => ({ left: 0, right: 1120, width: 1120, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 900 - 480, button: 0 });
    fireEvent.pointerUp(root, { pointerId: 1 });
    act(() => sessionWidthStore.set({ width: 768 }));
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(sessionWidthStore.get().width).toBe(784);
    closePopover();
  });

  it('Escape closes the popover', () => {
    // Invariant: the popover is dismissed by Escape.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    openPopover();
    expect(document.querySelector('[data-session-width-popover]')).not.toBeNull();
    closePopover();
    expect(document.querySelector('[data-session-width-popover]')).toBeNull();
  });

  it('Full greys the slider and keeps the custom width', () => {
    // Invariant: Full disables the slider without touching width; turning it off restores a live slider at that width.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    act(() => sessionWidthStore.set({ width: 896 }));
    openPopover();
    const sw = screen.getByRole('switch', { name: 'Full width' });
    fireEvent.click(sw);
    expect(sw.getAttribute('data-state')).toBe('checked');
    expect(document.querySelector('[data-slot=slider]')!.hasAttribute('data-disabled')).toBe(true);
    expect(sessionWidthStore.get()).toEqual({ width: 896, full: true });
    fireEvent.click(sw);
    expect(document.querySelector('[data-slot=slider]')!.hasAttribute('data-disabled')).toBe(false);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('896');
    closePopover();
  });

  it('the ticks jump to their snap, and a double-click on the slider resets to the default', () => {
    // Invariant: the ticks jump to their snap and the reset affordances return to the default.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Wide' }));
    expect(sessionWidthStore.get().width).toBe(1024);
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }));
    expect(sessionWidthStore.get().width).toBe(768);
    act(() => sessionWidthStore.set({ width: 896 }));
    fireEvent.doubleClick(document.querySelector('[data-slot=slider]')!);
    expect(sessionWidthStore.get().width).toBe(768);
    closePopover();
  });

  it('with Full on, the ticks are disabled', () => {
    // Invariant: a tick cannot move the greyed slider.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    act(() => sessionWidthStore.set({ full: true }));
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Wide' }));
    expect(sessionWidthStore.get().width).toBe(768);
    closePopover();
  });

  it('the drawer sidebar has no width control', () => {
    // Invariant: the phone drawer offers the theme toggle but no width control.
    render(<TooltipProvider><AppSidebar mobile /></TooltipProvider>);
    expect(screen.getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Session width/ })).toBeNull();
  });
});
