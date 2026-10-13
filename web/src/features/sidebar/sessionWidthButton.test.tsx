import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  sessionWidthStore.set({ preset: 'normal' });
  uiStore.set({ lens: 'conductors' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

describe('the session width button', () => {
  it("the desktop footer's width button names the current preset and each click advances it", () => {
    // Invariant: the footer button's name is the current preset, and a click cycles Normal → Wide → Full → Normal with the store in step.
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const footer = document.querySelector('[data-sidebar-footer]') as HTMLElement;
    for (const [name, preset] of [['Normal', 'normal'], ['Wide', 'wide'], ['Full', 'full'], ['Normal', 'normal']] as const) {
      const btn = within(footer).getByRole('button', { name: `Session width: ${name}` });
      expect(sessionWidthStore.get().preset).toBe(preset);
      fireEvent.click(btn);
    }
    expect(sessionWidthStore.get().preset).toBe('wide');
  });

  it('the drawer sidebar has no width button', () => {
    // Invariant: the phone drawer offers the theme toggle but no width control.
    render(<TooltipProvider><AppSidebar mobile /></TooltipProvider>);
    expect(screen.getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Session width/ })).toBeNull();
  });
});
