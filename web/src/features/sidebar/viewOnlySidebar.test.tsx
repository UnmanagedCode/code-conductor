// View-only: the sidebar offers neither Settings nor Conduct. Flag off: both present.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setViewOnly } from '@shared/viewOnly';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(), adoptInstance: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({ loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), persistSession: vi.fn(), removeWorktree: vi.fn() }));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: ({ fallback }: { fallback: React.ReactNode }) => <>{fallback}</> }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');

beforeEach(() => {
  localStorage.clear();
  appStore.set({ connection: 'open', everDropped: false, activeId: null, sidebarStatus: null, staleLists: [], projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [] });
});
afterEach(() => { cleanup(); setViewOnly(false); });

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);

describe('view-only sidebar', () => {
  it('hides Settings and Conduct', () => {
    // Invariant: neither the Settings header button nor the Conduct button is in the DOM.
    setViewOnly(true);
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(document.querySelector('[data-conduct]')).toBeNull();
  });

  it('normal mode keeps both', () => {
    // Invariant (control): flag off → both present.
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(document.querySelector('[data-conduct]')).not.toBeNull();
  });
});
