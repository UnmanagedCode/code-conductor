// A conductor New conductor just started is pristine: the tab that started it
// shows it, and the sidebar lists it nowhere — no Conductors-lens row, no strip
// entry, no conductor-filter option — beside a listed conductor that has all
// it qualifies for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import { selectOptions } from '@/test/radixSelect';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(async () => {}),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const { startController, stopController } = await import('@/app/controller');
const { appStore } = await import('@/state/app');
const { uiStore } = await import('@/app/ui');
const { sidebarStore } = await import('./state');
const { AppSidebar } = await import('./AppSidebar');
const { startConducting } = await import('@/features/dialogs/conduct');

const conductor = (id: string, sessionId: string, extra: Record<string, unknown> = {}) => ({
  id, sessionId, project: '.conduct', status: 'idle', mode: 'bypassPermissions', temp: true, ...extra,
});
const Q = conductor('iQ', 's-q', { firstPrompt: 'plan the release' });
const P = conductor('iP', 's-p', { pristine: true });

const row = (sid: string) => document.querySelector(`[data-conductor="${sid}"]`);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

let reads: ReturnType<typeof held<RouteAnswer>>[];

beforeEach(() => {
  localStorage.clear();
  reads = [];
  routeFetch({
    'POST /api/instances': () => ({ status: 201, json: P }),
    'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
    'GET /api/projects/.conduct/sessions': () => ({ json: [] }),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [Q as any],
  });
  uiStore.set({ lens: 'conductors' });
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: true, filter: '' });
  startController();
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
});
afterEach(() => { stopController(); vi.unstubAllGlobals(); });

describe('a pristine conductor in the sidebar', () => {
  it('has no Conductors-lens row, strip entry or filter option, while the conductor it is started beside keeps its row', async () => {
    await act(async () => { await startConducting(); });
    expect(appStore.get().activeId, 'fixture check: the started conductor is selected').toBe('iP');
    expect(row('s-q'), 'control: the listed conductor has its row').not.toBeNull();
    expect(row('s-p')).toBeNull();
    expect(document.querySelector('[data-strip-entry="s-p"]')).toBeNull();
    // The list read the create started lands without it, as the server answers.
    for (const h of reads) h.release({ json: [Q] });
    await settle();
    expect(row('s-p')).toBeNull();
    act(() => { uiStore.set({ lens: 'projects' }); });
    const offered = selectOptions(screen.getByRole('combobox', { name: 'Filter by conductor' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(offered.some((label) => label.includes('s-p'))).toBe(false);
  });
});
