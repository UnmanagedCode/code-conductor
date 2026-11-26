// The UI modes in the sidebar: `view` and `interact` offer neither Settings nor
// Conduct; `full` offers both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setUiMode } from '@shared/viewOnly';
import { setFocus } from '@shared/focus';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(), adoptInstance: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({ loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), persistSession: vi.fn(), removeWorktree: vi.fn() }));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: ({ fallback }: { fallback: React.ReactNode }) => <>{fallback}</> }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');

beforeEach(() => {
  localStorage.clear();
  appStore.set({ connection: 'open', everDropped: false, activeId: null, sidebarStatus: null, staleLists: [], projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [] });
});
afterEach(() => { cleanup(); setUiMode('full'); setFocus(null); });

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);

describe('view-only sidebar', () => {
  it('hides Settings and Conduct', () => {
    // Invariant: neither the Settings header button nor the Conduct button is in the DOM.
    setUiMode('view');
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(document.querySelector('[data-conduct]')).toBeNull();
  });

  it('interact hides both too', () => {
    // Invariant: Settings and Conduct are app-wide controls, hidden under
    // interact even with a focused session.
    setFocus({ sessionId: 'root-sid' });
    setUiMode('interact');
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(document.querySelector('[data-conduct]')).toBeNull();
  });

  it('normal mode keeps both', () => {
    // Invariant (control): `full` → both present.
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(document.querySelector('[data-conduct]')).not.toBeNull();
  });
});
