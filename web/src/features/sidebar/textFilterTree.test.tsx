// The text filter on the rendered Projects tab: what shows, what the filter opens without touching the
// user's own open/closed state, the filtered counts, highlighting, scope AND, the empty state, and reveal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { chooseOption } from '@/test/radixSelect';
import { routeFetch } from '@/test/routeFetch';
import { A, ALPHA, conductor, el, hand, openOf, proj, seed, worker, wt } from '@/test/sidebarFleet';
import {
  bandOf, filterInput, isOpen, marksIn, rowIds, rowsRoute, sessionsToggleOf, settleSearch, shownProjects, typeFilter,
  worktreesToggleOf,
} from '@/test/textFilter';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn() }));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
const { resetTextFilter } = await import('./textFilterState');
const { resetSessionSearch, SESSION_SEARCH_DEBOUNCE_MS } = await import('./sessionSearch');
const { dotTitle } = await import('./rows');

const disk = (sessionId: string, firstPrompt: string, lastActivity = 1) => ({ sessionId, firstPrompt, lastActivity });
const summary = (count: number, lastActivity = 1) => ({ count, archivedCount: 0, handCount: count, lastActivity });

/**
 * Acme (user-open) holds `shop`. Ops (user-closed) holds `api` (Sessions group collapsed; rows `fix login bug`,
 * `docs pass`) and `web` (Worktrees group closed; worktree `feat-x`, Sessions group collapsed, row `login page`).
 * `tools` is unassigned with one live hand session. Every group's state differs from its default.
 */
function world(extraInstances: any[] = []) {
  seed({
    projects: [
      proj('shop', { workspace: 'Acme', sessions: summary(1, 3) }),
      proj('api', { workspace: 'Ops', sessions: summary(2, 5) }),
      proj('web', { workspace: 'Ops', isGitRepo: true, worktrees: [wt('feat-x', { sessions: summary(1, 4) })] }),
      proj('tools'),
    ],
    workspaces: ['Acme', 'Ops'],
    instances: [hand('h-lint', 'tools', null, { firstPrompt: 'lint sweep' }), ...extraInstances],
  });
  sidebarStore.set({
    collapsedSessions: ['api', 'web:feat-x'], expandedWorktrees: [], expandedWorkspaces: ['Acme'],
    expandedConductors: [], inactiveOpen: false, filter: '',
  });
}
const calls = () => routeFetch({
  'GET /api/projects/shop/sessions': rowsRoute([disk('d-ship', 'ship cart', 3)]),
  'GET /api/projects/api/sessions': rowsRoute([disk('d-fix', 'fix login bug', 2), disk('d-docs', 'docs pass', 1)]),
  'GET /api/projects/web/worktrees/feat-x/sessions': rowsRoute([disk('d-login', 'login page', 4)]),
});

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Types a query and lets the search load every list it needs. */
const search = async (q: string) => { await typeFilter(q); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS); };
const trigger = () => screen.getByRole('combobox', { name: 'Filter by conductor' });
const summaryOf = (key: string) => el(`[data-sessions-summary="${key}"]`).textContent ?? '';
const clearFromEmptyState = () => act(async () => { fireEvent.click(within(el('[data-filter-empty]')).getByRole('button', { name: 'Clear filter' })); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  invalidateSessions();
  resetTextFilter();
  resetSessionSearch();
  uiStore.set({ lens: 'projects' });
});
afterEach(() => { vi.useRealTimers(); });

describe('what a query shows and opens', () => {
  it('a session hit under collapsed ancestors opens them, lists only the matching rows, and writes none of the user state', async () => {
    // Pins: auto-expansion is transient (no sidebarStore or localStorage write) and the tree narrows to matching rows and their ancestors.
    world(); calls();
    renderSidebar();
    const before = sidebarStore.get();
    const setItem = vi.spyOn(localStorage, 'setItem');
    await search('login');
    expect(shownProjects()).toEqual(['api', 'web']);
    expect(isOpen(bandOf('Ops'))).toBe(true);
    expect(isOpen(worktreesToggleOf('web'))).toBe(true);
    expect(isOpen(sessionsToggleOf('api'))).toBe(true);
    expect(rowIds('api')).toEqual(['d-fix']);
    expect(rowIds('web:feat-x')).toEqual(['d-login']);
    expect(document.querySelector('[data-workspace="Acme"]')).toBeNull();
    expect(sidebarStore.get()).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('tokens match across fields: a workspace token plus a session token narrows, and a missing token empties', async () => {
    // Pins: AND across tokens over the path (workspace, project, label), not per-field.
    world(); calls();
    renderSidebar();
    await search('ops docs');
    expect(shownProjects()).toEqual(['api']);
    expect(rowIds('api')).toEqual(['d-docs']);
    await search('acme docs');
    expect(el('[data-filter-empty]')).toBeTruthy();
  });

  it('a project-name hit shows its normal contents in the user collapse state and opens only its workspace', async () => {
    // Pins: a name hit is not a session hit: it opens its workspace but never force-opens the groups under it.
    world(); calls();
    renderSidebar();
    await search('api');
    expect(shownProjects()).toEqual(['api']);
    expect(isOpen(bandOf('Ops'))).toBe(true);
    expect(isOpen(sessionsToggleOf('api'))).toBe(false);
  });

  it('a workspace-name hit is not forced open: it keeps the user state, and its members keep theirs', async () => {
    // Pins: a workspace hit leaves the workspace's open state to the user (closed hides members; opened shows them whole).
    world(); calls();
    renderSidebar();
    await search('ops');
    expect(isOpen(bandOf('Ops'))).toBe(false);
    expect(shownProjects()).toEqual([]);
    await act(async () => { fireEvent.click(bandOf('Ops')!); });
    expect(shownProjects()).toEqual(['api', 'web']);
    expect(isOpen(sessionsToggleOf('api'))).toBe(false);
    expect(isOpen(worktreesToggleOf('web'))).toBe(false);
  });

  it('the workspace and Worktrees counts follow the filter, and a Sessions summary counts only matching rows', async () => {
    // Pins: while filtering, (N) and Sessions (N) count what is listed; unfiltered they count everything.
    world(); calls();
    sidebarStore.set({ expandedWorkspaces: ['Acme', 'Ops'], collapsedSessions: ['web:feat-x'] });
    renderSidebar();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(summaryOf('api')).toContain('Sessions (2)');
    await search('login');
    expect(bandOf('Ops')!.textContent).toContain('(2)');
    expect(worktreesToggleOf('web')!.textContent).toContain('Worktrees (1)');
    await search('fix');
    expect(summaryOf('api')).toContain('Sessions (1)');
  });

  it('every token occurrence in a row label is marked while the accessible name stays the row name', async () => {
    // Pins: highlighting is presentation only: marks cover each token hit, the button's accessible name is untouched.
    world(); calls();
    renderSidebar();
    await search('LOG');
    expect(marksIn(el('[data-session-row="d-fix"]'))).toEqual(['log']);
    expect(openOf('d-fix').getAttribute('aria-label')).toBe(`fix login bug, ${dotTitle({ status: 'offline' })}`);
  });
});

describe('clearing restores the user state', () => {
  it('collapsing a filter-opened group is transient, an explicit toggle of an unforced group persists, and Clear filter restores the rest', async () => {
    // Pins: only an explicit toggle of a non-forced group writes sidebarStore; filter-opened groups and their collapses leave no trace.
    world(); calls();
    renderSidebar();
    const snapshot = sidebarStore.get();
    await search('acme');
    await act(async () => { fireEvent.click(sessionsToggleOf('shop')!); }); // not forced: an explicit user toggle
    await search('login');
    expect(isOpen(bandOf('Ops'))).toBe(true);
    await act(async () => { fireEvent.click(bandOf('Ops')!); }); // forced: transient
    expect(isOpen(bandOf('Ops'))).toBe(false);
    expect(sidebarStore.get().expandedWorkspaces).toEqual(snapshot.expandedWorkspaces);
    await act(async () => { fireEvent.click(within(screen.getByRole('textbox', { name: 'Filter projects' }).parentElement!).getByRole('button', { name: 'Clear filter' })); });
    expect(filterInput().value).toBe('');
    expect(sidebarStore.get()).toEqual({ ...snapshot, collapsedSessions: [...snapshot.collapsedSessions, 'shop'] });
    expect(isOpen(bandOf('Ops'))).toBe(false);
    expect(isOpen(bandOf('Acme'))).toBe(true);
  });
});

describe('the conductor scope', () => {
  it('ANDs with the query: Hand finds a hand row, an owner scope hides it, and Hand drops a conducted row', async () => {
    // Pins: the scope and the text are conjunctive; a row the scope hides never matches.
    world([conductor(A, { title: ALPHA }), worker('wa-w', A, 'shop')]);
    calls();
    renderSidebar();
    await search('lint');
    expect(shownProjects()).toEqual(['tools']);
    chooseOption(trigger(), 'Hand-spawned only');
    await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(shownProjects()).toEqual(['tools']);
    await search('wa-w');
    expect(el('[data-filter-empty]')).toBeTruthy(); // Hand: the conducted row is not listed
    chooseOption(trigger(), 'All sessions');
    await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(shownProjects()).toEqual(['shop']);
    await search('lint');
    chooseOption(trigger(), ALPHA);
    await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(el('[data-filter-empty]')).toBeTruthy(); // A owns nothing named lint
  });
});

describe('the empty state', () => {
  it('names the query, and Clear filter restores the whole tree and empties the input', async () => {
    // Pins: a query nothing matches shows the empty state with a way out that resets both input and list.
    world(); calls();
    renderSidebar();
    await search('zzz');
    expect(el('[data-filter-empty]').textContent).toContain("'zzz'");
    expect(shownProjects()).toEqual([]);
    await clearFromEmptyState();
    expect(filterInput().value).toBe('');
    expect(shownProjects()).toEqual(['shop', 'tools']);
  });
});

describe('reveal while filtering', () => {
  it('a selection still records the user expand state and survives clearing, and never touches the query', async () => {
    // Pins (a decision): reveal-on-select writes the user's state even while filtering, and the selection never clears or rewrites the query text.
    world([hand('h-login', 'web', 'feat-x', { firstPrompt: 'login page', sessionId: 'd-login' })]);
    calls();
    renderSidebar();
    await search('login');
    await act(async () => { appStore.set({ activeId: 'i-d-login' }); });
    expect(sidebarStore.get().expandedWorkspaces).toEqual(['Acme', 'Ops']);
    expect(filterInput().value).toBe('login');
    await act(async () => { fireEvent.click(within(filterInput().parentElement!).getByRole('button', { name: 'Clear filter' })); });
    expect(isOpen(bandOf('Ops'))).toBe(true);
    expect(sidebarStore.get().expandedWorkspaces).toEqual(['Acme', 'Ops']);
  });
});
