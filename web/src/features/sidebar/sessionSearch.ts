// Session-list loading for the text filter. A place's on-disk list is lazy (it
// loads when its group opens), so a query could only match rows already opened.
// While the query is non-empty this loader fetches the lists the scope can show:
// debounced, capped, at most once per place per search session, and refetching
// only a place whose summary fingerprint changed. Module state is the search
// session; importing the module installs its subscriptions.
import { createStore, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { on } from '@/app/events';
import type { Project } from '@/state/types';
import { filterOwner, placeKeyOf, type Filter } from './derive';
import { ensureSessions, sessionsCache, sessionsSignal, sidebarStore } from './state';
import { textFilterStore } from './textFilterState';
import { tokensOf } from './textFilter';

export const SESSION_SEARCH_DEBOUNCE_MS = 250;
export const SESSION_SEARCH_CONCURRENCY = 4;

export type PlaceRef = { project: string; worktree: string | null; key: string; fp: string };
type Summary = { count?: number; handCount?: number; lastActivity?: number } | undefined;

const fpOf = (s: Summary) => `${s?.count ?? 0}:${s?.lastActivity ?? 0}`;

/** Every place with sessions, with its summary fingerprint. */
function placesOf(projects: Project[]): (PlaceRef & { summary: Summary })[] {
  const out: (PlaceRef & { summary: Summary })[] = [];
  for (const p of projects) {
    out.push({ project: p.name, worktree: null, key: p.name, fp: fpOf(p.sessions), summary: p.sessions });
    for (const wt of Array.isArray(p.worktrees) ? p.worktrees : []) {
      const summary = wt.sessions as Summary;
      out.push({ project: p.name, worktree: wt.worktreeName, key: placeKeyOf(p.name, wt.worktreeName), fp: fpOf(summary), summary });
    }
  }
  return out;
}

/** The places to fetch now: those the scope can show, with sessions, not yet attempted at their current fingerprint. */
export function planLoads({ projects, filter, attempted, skip = () => false }: {
  projects: Project[]; filter: Filter; attempted: ReadonlyMap<string, string>; skip?: (key: string) => boolean;
}): PlaceRef[] {
  if (filterOwner(filter)) return []; // disk rows carry no owner: an owner scope shows live rows only
  return placesOf(projects)
    .filter((p) => (filter === 'hand' ? (p.summary?.handCount ?? 0) > 0 : (p.summary?.count ?? 0) > 0))
    .filter((p) => attempted.get(p.key) !== p.fp && !skip(p.key))
    .map(({ project, worktree, key, fp }) => ({ project, worktree, key, fp }));
}

const held = new Map<string, { fp: string; rows: any[] }>();
const attempted = new Map<string, string>();
let queue: PlaceRef[] = [];
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** True once the debounce has fired in this search session. */
let started = false;
/** Identifies the search session; a settle from an earlier one is ignored. */
let epoch = 0;
let prevQuery = '';

export const searchStore = createStore({ pending: false, version: 0 });
export const useSearchPending = () => useStore(searchStore, (s) => s.pending);
export const useSearchVersion = () => useStore(searchStore, (s) => s.version);

const active = () => tokensOf(textFilterStore.get().query).length > 0;

let fpCache: { projects: Project[]; map: Map<string, string> } | null = null;
function currentFp(key: string): string | undefined {
  const projects = appStore.get().projects;
  if (fpCache?.projects !== projects) fpCache = { projects, map: new Map(placesOf(projects).map((p) => [p.key, p.fp])) };
  return fpCache.map.get(key);
}

/** The rows a search load of this place held, surviving the cache's wipes; null when none. */
export const heldRowsOf = (key: string): any[] | null => held.get(key)?.rows ?? null;
/** Whether the search already holds this place's list at its current fingerprint (the tree need not load it). */
export const searchCovers = (key: string) => active() && held.get(key)?.fp === currentFp(key);

const planNow = () => planLoads({
  projects: appStore.get().projects,
  filter: sidebarStore.get().filter,
  attempted,
  skip: (key) => inFlight.has(key) || queue.some((q) => q.key === key),
});

function updatePending() {
  const pending = (timer !== null && planNow().length > 0) || queue.length + inFlight.size > 0;
  if (pending !== searchStore.get().pending) searchStore.set({ pending });
}

function pump() {
  while (inFlight.size < SESSION_SEARCH_CONCURRENCY && queue.length > 0) {
    const place = queue.shift()!;
    if (inFlight.has(place.key)) continue;
    inFlight.add(place.key);
    const mine = epoch;
    void ensureSessions(place.project, place.worktree).then(() => {
      if (mine === epoch) settle(place);
    });
  }
  updatePending();
}

function settle(place: PlaceRef) {
  inFlight.delete(place.key);
  const rows = sessionsCache.get(place.key);
  if (rows) held.set(place.key, { fp: place.fp, rows });
  attempted.set(place.key, place.fp);
  searchStore.set((s) => ({ version: s.version + 1 }));
  pump();
}

/** Enqueues what `planNow` finds and starts loads. */
function replan() {
  queue.push(...planNow());
  pump();
}

function endSession() {
  epoch++;
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  queue = [];
  inFlight.clear();
  held.clear();
  attempted.clear();
  searchStore.set((s) => ({ pending: false, version: s.version + 1 }));
}

function onQueryChange() {
  const q = tokensOf(textFilterStore.get().query).join(' ');
  if (q === prevQuery) return;
  prevQuery = q;
  if (q === '') { endSession(); return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    started = true;
    replan();
  }, SESSION_SEARCH_DEBOUNCE_MS);
  updatePending();
}

/** Forgets every search session (tests). */
export function resetSessionSearch() {
  endSession();
  prevQuery = '';
  fpCache = null;
}

textFilterStore.subscribe(onQueryChange);
appStore.subscribe(() => { if (active() && started) replan(); });
sessionsSignal.subscribe(() => { if (active() && started) replan(); });
on('sessionsStale', (place) => {
  if (place) attempted.delete(placeKeyOf(place.project, place.worktree));
  if (active() && started) replan();
});
