// The Projects lens under the `projects` hint: every hint re-reads the project
// list and the sidebar shows exactly what the read returned — a created project
// gains a row, a deleted one loses it, a workspace move or rename regroups, a
// workspace with no members shows while it is registered —
// while any other message re-reads nothing, and a burst of hints reads once in
// flight plus once trailing, ending on the trailing read's list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

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

const { bus } = await import('@shared/ws');
const { startController, stopController } = await import('@/app/controller');
const { appStore } = await import('@/state/app');
const { uiStore } = await import('@/app/ui');
const { sidebarStore } = await import('./state');
const { AppSidebar } = await import('./AppSidebar');

type Row = { name: string; workspace: string | null };
/** What the server answers: GET /api/projects reads `projects`, GET /api/workspaces reads `workspaces`. */
let server: { projects: Row[]; workspaces: string[] };
/** When set, each GET /api/projects waits on its own deferred instead of answering at once. */
let held: { resolve: (rows: Row[]) => void }[] | null;
let projectReads = 0;

const proj = (name: string, workspace: string | null = null) => ({
  name, path: `/p/${name}`, workspace, system: 'local', remoteId: null, isGitRepo: false, worktrees: [],
  sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 },
});
const body = (rows: Row[]) => rows.map((r) => proj(r.name, r.workspace));

const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/projects') {
    projectReads++;
    if (held) {
      const queue = held;
      return { ok: true, json: () => new Promise((resolve) => { queue.push({ resolve: (rows) => resolve(body(rows)) }); }) };
    }
    const rows = server.projects;
    return { ok: true, json: async () => body(rows) };
  }
  if (url === '/api/workspaces') {
    const names = server.workspaces;
    return { ok: true, json: async () => names.map((name) => ({ name, projectCount: 0 })) };
  }
  if (url === '/api/instances') return { ok: true, json: async () => [] };
  return { ok: true, json: async () => (url.includes('conductors') ? {} : []) };
});

/** Delivers one server message to the controller, as the socket does. */
const hint = (t: string, detail: Record<string, unknown> = {}) => act(() => { bus.dispatchEvent(new CustomEvent(t, { detail })); });
/** Lets pending reads resolve and React re-render. */
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); });

const rows = () => [...document.querySelectorAll('[data-project-row]')].map((e) => e.getAttribute('data-project-row')).sort();
const groups = () => [...document.querySelectorAll('section[data-workspace]')].map((e) => e.getAttribute('data-workspace')).sort();
const groupOf = (name: string) => document.querySelector(`[data-project-row="${name}"]`)?.closest('section')?.getAttribute('data-workspace') ?? null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  held = null;
  projectReads = 0;
  server = { projects: [{ name: 'alpha', workspace: null }], workspaces: [] };
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: body(server.projects) as any, workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
  uiStore.set({ lens: 'projects' });
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: ['Team', 'Crew'], expandedConductors: [], inactiveOpen: false, filter: '' });
  startController();
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
});
afterEach(() => { stopController(); });

describe('the projects hint in the Projects lens', () => {
  it('a hint shows a project created after load, drops a deleted one, and shows it again once re-created; two created together both show', async () => {
    // Invariant: after each hint the rows are exactly the server's list, in both directions.
    expect(rows()).toEqual(['alpha']);
    server.projects = [{ name: 'alpha', workspace: null }, { name: 'beta', workspace: null }];
    await hint('projects');
    await waitFor(() => expect(rows()).toEqual(['alpha', 'beta']));
    server.projects = [{ name: 'alpha', workspace: null }];
    await hint('projects');
    await waitFor(() => expect(rows()).toEqual(['alpha']));
    server.projects = [{ name: 'alpha', workspace: null }, { name: 'beta', workspace: null }, { name: 'gamma', workspace: null }];
    await hint('projects');
    await waitFor(() => expect(rows()).toEqual(['alpha', 'beta', 'gamma']));
  });

  it('a hint moves a project into its new workspace, and a renamed workspace shows under its new name and not the old', async () => {
    // Invariant: the groups and each row's group are the server's, never a merge with what was shown.
    server = { projects: [{ name: 'alpha', workspace: 'Team' }, { name: 'beta', workspace: null }], workspaces: ['Team'] };
    await hint('projects');
    await waitFor(() => expect(groupOf('alpha')).toBe('Team'));
    expect(groups()).toEqual(['', 'Team']);
    server = { projects: [{ name: 'alpha', workspace: 'Crew' }, { name: 'beta', workspace: null }], workspaces: ['Crew'] };
    await hint('projects');
    await waitFor(() => expect(groupOf('alpha')).toBe('Crew'));
    expect(groups()).toEqual(['', 'Crew']);
    expect(rows()).toEqual(['alpha', 'beta']);
  });

  it('a hint shows a workspace with no members once it is registered, and drops it once it is not', async () => {
    // Invariant: the sections are the server's workspace registry, not only the workspaces the projects name.
    expect(groups()).toEqual(['']);
    server = { projects: [{ name: 'alpha', workspace: 'Team' }, { name: 'beta', workspace: null }], workspaces: ['Team', 'Empty'] };
    await hint('projects');
    await waitFor(() => expect(groups()).toEqual(['', 'Empty', 'Team']));
    expect(document.querySelector('section[data-workspace="Empty"] [data-project-row]')).toBe(null);
    expect(groupOf('alpha')).toBe('Team');
    server = { projects: [{ name: 'alpha', workspace: 'Team' }, { name: 'beta', workspace: null }], workspaces: ['Team'] };
    await hint('projects');
    await waitFor(() => expect(groups()).toEqual(['', 'Team']));
    expect(groupOf('alpha')).toBe('Team');
  });

  it('a message other than projects re-reads nothing and changes no row', async () => {
    // Invariant: only the projects hint re-reads the list.
    server.projects = [{ name: 'alpha', workspace: null }, { name: 'beta', workspace: null }];
    await hint('instances');
    await hint('status', { id: 'nobody', status: 'idle', mode: 'plan', sessionId: null });
    await settle();
    expect(projectReads).toBe(0);
    expect(rows()).toEqual(['alpha']);
    // Positive control: the projects hint does re-read.
    await hint('projects');
    await waitFor(() => expect(rows()).toEqual(['alpha', 'beta']));
    expect(projectReads).toBe(1);
  });

  it('two hints in a burst read once in flight and once trailing, never two at once', async () => {
    // Invariant: the second hint's read starts only when the first has landed, so the reads cannot answer out of order.
    const reads: { resolve: (rows: Row[]) => void }[] = [];
    held = reads;
    await hint('projects');
    await hint('projects');
    await settle();
    expect(reads).toHaveLength(1);
    reads[0].resolve([{ name: 'alpha', workspace: null }]);
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve([{ name: 'alpha', workspace: null }]);
    await settle();
    expect(reads).toHaveLength(2);
  });

  it('the in-flight read\'s list is applied when it lands, and the trailing read\'s list lands over it', async () => {
    // Invariant: the burst ends on the trailing (newest) read's list, with the older list shown meanwhile.
    const reads: { resolve: (rows: Row[]) => void }[] = [];
    held = reads;
    await hint('projects');
    await hint('projects');
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve([{ name: 'alpha', workspace: null }, { name: 'beta', workspace: null }]);
    await waitFor(() => expect(rows()).toEqual(['alpha', 'beta']));
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve([{ name: 'alpha', workspace: null }, { name: 'gamma', workspace: null }]);
    await waitFor(() => expect(rows()).toEqual(['alpha', 'gamma']));
  });
});
