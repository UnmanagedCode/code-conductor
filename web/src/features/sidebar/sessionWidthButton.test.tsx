import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { MoveHorizontalIcon, UnfoldHorizontalIcon } from 'lucide-react';
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
const { setSessionFull, setSessionWidth } = await import('@/app/sessionWidth');

beforeEach(() => {
  localStorage.clear();
  act(() => { setSessionWidth(768); setSessionFull(false); });
  uiStore.set({ lens: 'conductors' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

const footer = () => document.querySelector('[data-sidebar-footer]') as HTMLElement;
const toggle = (name: RegExp | string = /^Session width:/) => within(footer()).queryByRole('button', { name });

describe('the session width control', () => {
  it('the name shows the mode, with px under Resizable', () => {
    // Invariant: the label names Resizable with its px, or Full.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    expect(toggle('Session width: Resizable, 768 px')).not.toBeNull();
    act(() => setSessionWidth(896));
    expect(toggle('Session width: Resizable, 896 px')).not.toBeNull();
    act(() => setSessionFull(true));
    expect(toggle('Session width: Full')).not.toBeNull();
  });

  it('a click toggles Full and Resizable, keeps the width, and opens nothing', () => {
    // Invariant: the control is a toggle, not a popover, and Full never drops the width.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    act(() => setSessionWidth(896));
    expect(toggle('Session width: Resizable, 896 px')).not.toBeNull();
    fireEvent.click(toggle()!);
    expect(toggle('Session width: Full')).not.toBeNull();
    fireEvent.click(toggle()!);
    expect(toggle('Session width: Resizable, 896 px')).not.toBeNull();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(document.querySelector('[role=slider]')).toBeNull();
  });

  it('the icon shows the mode', () => {
    // Invariant: Full and Resizable are told apart by icon identity.
    const standalone = (icon: React.ReactElement) => {
      const { container, unmount } = render(icon);
      const html = container.querySelector('svg')!.innerHTML;
      unmount();
      return html;
    };
    const full = standalone(<MoveHorizontalIcon />);
    const resizable = standalone(<UnfoldHorizontalIcon />);
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    expect(toggle('Session width: Resizable, 768 px')).not.toBeNull();
    expect(toggle('Session width: Resizable, 768 px')!.querySelector('svg')!.innerHTML).toBe(resizable);
    act(() => setSessionFull(true));
    expect(toggle('Session width: Full')!.querySelector('svg')!.innerHTML).toBe(full);
  });

  it('stays a keyboard-operable button', () => {
    // Invariant: the toggle is in the tab order, so the keyboard reaches the setting the handles cannot.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const b = toggle('Session width: Resizable, 768 px')!;
    expect(b).not.toBeNull();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('tabindex')).not.toBe('-1');
    b.focus();
    expect(document.activeElement).toBe(b);
  });

  it('the drawer sidebar has no width control', () => {
    // Invariant: the phone drawer offers the theme toggle but no width control.
    render(<TooltipProvider><AppSidebar mobile /></TooltipProvider>);
    expect(within(document.body).getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeTruthy();
    expect(within(document.body).queryByRole('button', { name: /^Session width/ })).toBeNull();
  });
});
