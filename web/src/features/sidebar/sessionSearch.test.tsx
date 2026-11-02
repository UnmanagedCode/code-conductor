// The text filter's session-list loader on the rendered sidebar: debounced, one load per place per search
// session, capped, refetching only a place whose fingerprint changed, scope-aware, and failure-tolerant.
// Every answer is a routed `fetch`; the debounce is driven with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { emit } from '@/app/events';
import { uiStore } from '@/app/ui';
import { held, routeFetch, type RouteAnswer, type RoutedCall } from '@/test/routeFetch';
import { A, ALPHA, conductor, el, hand, proj, seed, worker } from '@/test/sidebarFleet';
import { rowIds, rowsRoute, sessionGets, settleSearch, typeFilter } from '@/test/textFilter';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn() }));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
const { resetTextFilter } = await import('./textFilterState');
const { resetSessionSearch, SESSION_SEARCH_DEBOUNCE_MS, SESSION_SEARCH_CONCURRENCY } = await import('./sessionSearch');

const summary = (count: number, handCount = count, lastActivity = 1) => ({ count, archivedCount: 0, handCount, lastActivity });
const urls = (calls: RoutedCall[]) => sessionGets(calls).map((c) => c.url);
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const disk = (sessionId: string, firstPrompt: string) => ({ sessionId, firstPrompt, lastActivity: 1 });
const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
const placeNames = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
/**
 * Unassigned projects, each with sessions on disk, plus a per-project override. Each Sessions group starts
 * collapsed, so the only requests before a filter opens a group are the loader's own.
 */
function seedPlaces(names: string[], over: (name: string) => Record<string, any> = () => ({}), instances: any[] = []) {
  seed({ projects: names.map((n) => proj(n, { sessions: summary(1), ...over(n) })), workspaces: [], instances });
  sidebarStore.set({ collapsedSessions: names });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  invalidateSessions();
  resetTextFilter();
  resetSessionSearch();
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'projects' });
});
afterEach(() => { vi.useRealTimers(); });

describe('the session loader', () => {
  it('sends no request while the user is still typing, then exactly one per place with sessions once the debounce elapses', async () => {
    // Pins: loads are debounced (keystrokes inside the window cost nothing) and cover each eligible place once.
    seedPlaces(['p1', 'p2', 'p3', 'empty'], (n) => (n === 'empty' ? { sessions: summary(0) } : {}));
    const calls = routeFetch({ 'GET /api/projects/': rowsRoute([]) });
    renderSidebar();
    for (const q of ['l', 'lo', 'log']) { await typeFilter(q); await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS - 1); }); }
    expect(sessionGets(calls)).toHaveLength(0);
    await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(urls(calls).sort()).toEqual(['/api/projects/p1/sessions', '/api/projects/p2/sessions', '/api/projects/p3/sessions']);
  });

  it('loads each place once per search session: later keystrokes send nothing, and a new session after the cache is wiped loads again', async () => {
    // Pins: attempted places are not refetched while the query stays non-empty, and ending the search forgets them.
    seedPlaces(['p1', 'p2']);
    const calls = routeFetch({ 'GET /api/projects/': rowsRoute([]) });
    renderSidebar();
    await typeFilter('login'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(2);
    for (const q of ['logi', 'login', 'x']) { await typeFilter(q); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS); }
    expect(sessionGets(calls)).toHaveLength(2);
    await typeFilter(''); await flush();
    invalidateSessions(); // a session start or stop wipes the cache between searches
    await typeFilter('login'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(4);
  });

  it('runs at most the cap at once and starts exactly one more for each answer', async () => {
    // Pins: concurrency is capped, and a settle frees exactly one slot.
    const names = placeNames(10);
    seedPlaces(names);
    const gates = new Map(names.map((n) => [n, held<RouteAnswer>()]));
    const calls = routeFetch(Object.fromEntries(names.map((n) => [`GET /api/projects/${n}/sessions`, () => gates.get(n)!.answer])));
    renderSidebar();
    await typeFilter('x'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(SESSION_SEARCH_CONCURRENCY);
    gates.get('p1')!.release({ json: [] });
    await flush();
    expect(sessionGets(calls)).toHaveLength(SESSION_SEARCH_CONCURRENCY + 1);
    for (const g of gates.values()) g.release({ json: [] });
    await flush(); await flush();
    expect(sessionGets(calls)).toHaveLength(10);
  });

  it('after a session starts, refetches only the place whose fingerprint changed, and a place-specific stale refetches only that place', async () => {
    // Pins: the wipe a session start causes costs one GET (the changed place), not one per loaded place; held rows keep the unchanged place listed.
    seedPlaces(['p1', 'p2']);
    let p1Rows = [disk('d-1', 'alpha one')];
    const calls = routeFetch({
      'GET /api/projects/p1/sessions': () => ({ json: p1Rows }),
      'GET /api/projects/p2/sessions': rowsRoute([disk('d-2', 'alpha two')]),
    });
    renderSidebar();
    await typeFilter('alpha'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(rowIds('p1')).toEqual(['d-1']);
    expect(rowIds('p2')).toEqual(['d-2']);
    const before = sessionGets(calls).length;
    p1Rows = [disk('d-1', 'alpha one'), disk('d-3', 'alpha three')];
    await act(async () => {
      appStore.set({
        instances: [hand('h-new', 'p1', null, { firstPrompt: 'beta' })],
        projects: [proj('p1', { sessions: summary(2, 2, 9) }), proj('p2', { sessions: summary(1) })],
      });
    });
    await flush(); await flush();
    expect(urls(calls).slice(before)).toEqual(['/api/projects/p1/sessions']);
    expect(rowIds('p1')).toEqual(['d-1', 'd-3']);
    expect(rowIds('p2')).toEqual(['d-2']);
    const afterWipe = sessionGets(calls).length;
    await act(async () => { emit('sessionsStale', { project: 'p2', worktree: null }); });
    await flush(); await flush();
    expect(urls(calls).slice(afterWipe)).toEqual(['/api/projects/p2/sessions']);
  });

  it('fetches only hand places under Hand, nothing under an owner scope, and never asks for archived rows', async () => {
    // Pins: the loader's scope awareness (disk rows carry no owner) and that it never passes includeArchived.
    seedPlaces(['p1', 'p2', 'p3'], (n) => ({ sessions: summary(1, n === 'p2' ? 1 : 0) }));
    const calls = routeFetch({ 'GET /api/projects/': rowsRoute([]) });
    renderSidebar();
    await act(async () => { sidebarStore.set({ filter: 'hand' }); });
    await typeFilter('x'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(urls(calls)).toEqual(['/api/projects/p2/sessions']);
    await typeFilter(''); await flush();
    invalidateSessions();
    seed({ projects: [proj('p1', { sessions: summary(1) })], workspaces: [], instances: [conductor(A, { title: ALPHA }), worker('wa-w', A, 'p1')] });
    await act(async () => { sidebarStore.set({ filter: A }); });
    const before = sessionGets(calls).length;
    await typeFilter('x'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(before);
    expect(calls.some((c) => c.url.includes('includeArchived'))).toBe(false);
  });

  it('shows the searching hint while loads are held, clears it after the last settles, and degrades a failed place to its live rows without retrying it', async () => {
    // Pins: pending tracks held loads; a failed list neither blocks the others nor logs, and a keystroke does not retry it.
    seedPlaces(['p-ok', 'p-fail'], () => ({}), [hand('h-live', 'p-fail', null, { firstPrompt: 'needle live' })]);
    const gate = held<RouteAnswer>();
    const calls = routeFetch({
      'GET /api/projects/p-ok/sessions': () => gate.answer,
      'GET /api/projects/p-fail/sessions': () => new Error('boom'),
    });
    renderSidebar();
    await typeFilter('needle'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(document.querySelector('[data-filter-pending]')).toBeTruthy();
    gate.release({ json: [disk('d-ok', 'needle disk')] });
    await flush(); await flush();
    expect(document.querySelector('[data-filter-pending]')).toBeNull();
    expect(rowIds('p-ok')).toEqual(['d-ok']);
    expect(el('[data-session-row="h-live"]')).toBeTruthy();
    const before = sessionGets(calls).length;
    await typeFilter('needle l'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(before);
  });

  it('ends with the search: clearing during held loads starts no further request and drops the hint', async () => {
    // Pins: a search session's end cancels its queue and its pending state.
    const names = placeNames(6);
    seedPlaces(names);
    const gates = new Map(names.map((n) => [n, held<RouteAnswer>()]));
    const calls = routeFetch(Object.fromEntries(names.map((n) => [`GET /api/projects/${n}/sessions`, () => gates.get(n)!.answer])));
    renderSidebar();
    await typeFilter('x'); await settleSearch(SESSION_SEARCH_DEBOUNCE_MS);
    expect(sessionGets(calls)).toHaveLength(SESSION_SEARCH_CONCURRENCY);
    await typeFilter(''); await flush();
    expect(document.querySelector('[data-filter-pending]')).toBeNull();
    for (const g of gates.values()) g.release({ json: [] });
    await flush(); await flush();
    expect(sessionGets(calls)).toHaveLength(SESSION_SEARCH_CONCURRENCY);
  });
});
