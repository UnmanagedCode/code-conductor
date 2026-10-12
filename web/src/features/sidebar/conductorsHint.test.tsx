// The Conductors lens under the `projects` hint: every hint re-reads the
// .conduct session list along with the projects, and the lens shows exactly
// the conductor sessions that read returned — the next read replaces them —
// while a failed .conduct read does not keep the other reads from landing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(async () => {}),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { bus } = await import('@/lib/core/ws.js');
const { startController, stopController } = await import('@/app/controller');
const { appStore } = await import('@/state/app');
const { uiStore } = await import('@/app/ui');
const { sidebarStore } = await import('./state');
const { AppSidebar } = await import('./AppSidebar');

type ConductRow = { sessionId: string; title: string; lastActivity: number };
/** What GET /api/projects/.conduct/sessions answers: a list, a non-ok status or a rejected fetch. */
type Conduct = { rows: ConductRow[] } | 'non-ok' | 'rejected';
/** What the server answers: GET /api/projects lists `projects`, the .conduct listing follows `conduct`. */
let server: { projects: string[]; conduct: Conduct };

const proj = (name: string) => ({
  name, path: `/p/${name}`, workspace: null, system: 'local', remoteId: null, isGitRepo: false, worktrees: [],
  sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 },
});

const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/projects') {
    const names = server.projects;
    return { ok: true, json: async () => names.map(proj) };
  }
  if (url === '/api/projects/.conduct/sessions') {
    const conduct = server.conduct;
    if (conduct === 'rejected') throw new Error('offline');
    if (conduct === 'non-ok') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => conduct.rows };
  }
  if (url === '/api/instances') return { ok: true, json: async () => [] };
  return { ok: true, json: async () => (url.includes('conductors') ? {} : []) };
});

/** Delivers one server message to the controller, as the socket does. */
const hint = (t: string) => act(() => { bus.dispatchEvent(new CustomEvent(t, { detail: {} })); });

const conductors = () => [...document.querySelectorAll('[data-conductor]')].map((e) => e.getAttribute('data-conductor')).sort();
const blockOf = (sid: string) => document.querySelector(`[data-conductor="${sid}"]`) as HTMLElement;
const inactiveToggle = () => document.querySelector('[data-conductors-inactive] > button') as HTMLElement | null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  server = { projects: ['alpha'], conduct: { rows: [] } };
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: server.projects.map(proj) as any, workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
  uiStore.set({ lens: 'conductors' });
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: true, filter: '' });
  startController();
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
});
afterEach(() => { stopController(); });

describe('the projects hint in the Conductors lens', () => {
  it('a projects re-read shows the conductor sessions the server reports, and the next re-read replaces them with the new list', async () => {
    // Invariant: after each re-read the conductor rows are exactly the server's .conduct list; each read's list is distinct and non-empty, so neither an empty nor a stale list passes.
    expect(document.querySelector('[data-conductors-empty]')).not.toBe(null);
    server.conduct = { rows: [{ sessionId: 'A', title: 'Alpha', lastActivity: 2 }, { sessionId: 'B', title: 'Bravo', lastActivity: 1 }] };
    await hint('projects');
    await waitFor(() => expect(conductors()).toEqual(['A', 'B']));
    expect(inactiveToggle()?.textContent).toContain('Inactive (2)');
    within(blockOf('A')).getByText('Alpha');
    within(blockOf('B')).getByText('Bravo');
    server.conduct = { rows: [{ sessionId: 'C', title: 'Charlie', lastActivity: 3 }] };
    await hint('projects');
    await waitFor(() => expect(conductors()).toEqual(['C']));
    within(blockOf('C')).getByText('Charlie');
  });

  it("a failed conduct-sessions read does not stop the other reads, and the next good read shows the server's list", async () => {
    // Invariant: a non-ok or rejected .conduct read still lands the projects read beside it, and the following good read shows exactly the server's new list.
    server.conduct = { rows: [{ sessionId: 'A', title: 'Alpha', lastActivity: 1 }] };
    await hint('projects');
    await waitFor(() => expect(conductors()).toEqual(['A']));

    server = { projects: ['alpha', 'beta'], conduct: 'non-ok' };
    await hint('projects');
    await waitFor(() => expect(appStore.get().projects.map((p) => p.name)).toEqual(['alpha', 'beta']));
    server.conduct = { rows: [{ sessionId: 'B', title: 'Bravo', lastActivity: 2 }] };
    await hint('projects');
    await waitFor(() => expect(conductors()).toEqual(['B']));

    server = { projects: ['alpha', 'beta', 'gamma'], conduct: 'rejected' };
    await hint('projects');
    await waitFor(() => expect(appStore.get().projects.map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma']));
    server.conduct = { rows: [{ sessionId: 'C', title: 'Charlie', lastActivity: 3 }] };
    await hint('projects');
    await waitFor(() => expect(conductors()).toEqual(['C']));
  });
});
