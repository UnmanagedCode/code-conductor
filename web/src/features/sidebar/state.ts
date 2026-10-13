// Sidebar-only UI state: which groups are open, the Projects-lens filter, the
// per-place session-list cache, and the 15s tick that keeps "ago" labels fresh.
import { createSignal, createStore, useSignal, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { on } from '@/app/events';
import type { uiStore } from '@/app/ui';
import { loadSessions } from '@/app/sessionActions';
import { placeKeyOf, wtName, type Filter } from './derive';

const WORKSPACES_EXPANDED_KEY = 'code-conductor:workspaces-expanded';

function loadExpandedWorkspaces(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(WORKSPACES_EXPANDED_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveExpandedWorkspaces(list: string[]) {
  try {
    if (list.length === 0) localStorage.removeItem(WORKSPACES_EXPANDED_KEY);
    else localStorage.setItem(WORKSPACES_EXPANDED_KEY, JSON.stringify(list));
  } catch { /* private mode / quota */ }
}

export type SidebarUi = {
  /** Places whose Sessions subnode the user collapsed (open by default). */
  collapsedSessions: string[];
  /** Projects whose Worktrees group is open (closed by default). */
  expandedWorktrees: string[];
  /** Workspaces open (closed by default; persisted). */
  expandedWorkspaces: string[];
  /** Conductor blocks expanded into their tree. */
  expandedConductors: string[];
  inactiveOpen: boolean;
  filter: Filter;
};

export const sidebarStore = createStore<SidebarUi>({
  collapsedSessions: [],
  expandedWorktrees: [],
  expandedWorkspaces: loadExpandedWorkspaces(),
  expandedConductors: [],
  inactiveOpen: false,
  filter: '',
});

const toggleIn = (list: string[], key: string, on: boolean) =>
  on ? (list.includes(key) ? list : [...list, key]) : list.filter((k) => k !== key);

export function setSessionsOpen(key: string, open: boolean) {
  sidebarStore.set((s) => ({ collapsedSessions: toggleIn(s.collapsedSessions, key, !open) }));
}
export function setWorktreesOpen(project: string, open: boolean) {
  sidebarStore.set((s) => ({ expandedWorktrees: toggleIn(s.expandedWorktrees, project, open) }));
}
export function setWorkspaceOpen(name: string, open: boolean) {
  const next = toggleIn(sidebarStore.get().expandedWorkspaces, name, open);
  sidebarStore.set({ expandedWorkspaces: next });
  saveExpandedWorkspaces(next);
}
export function setConductorOpen(sid: string, open: boolean) {
  sidebarStore.set((s) => ({ expandedConductors: toggleIn(s.expandedConductors, sid, open) }));
}
export function setFilter(filter: Filter) {
  sidebarStore.set({ filter });
}

export function useSidebarUi() {
  return useStore(sidebarStore, (s) => s);
}

// ── Session lists ────────────────────────────────────────────────────────

/** place key → on-disk session rows (GET …/sessions), filled lazily when a subnode opens. */
export const sessionsCache = new Map<string, any[]>();
const loading = new Map<string, Promise<void>>();
const errors = new Map<string, string>();
export const sessionsSignal = createSignal();

export function invalidateSessions(key?: string) {
  if (key) { sessionsCache.delete(key); errors.delete(key); }
  else { sessionsCache.clear(); errors.clear(); }
  sessionsSignal.bump();
}

export function sessionsStatus(key: string): 'ready' | 'loading' | 'error' | 'idle' {
  if (sessionsCache.has(key)) return 'ready';
  if (loading.has(key)) return 'loading';
  if (errors.has(key)) return 'error';
  return 'idle';
}
export const sessionsError = (key: string) => errors.get(key) ?? null;

/** Fetch a place's session list once; concurrent calls coalesce. */
export function ensureSessions(project: string, worktree: string | null): Promise<void> {
  const key = placeKeyOf(project, worktree);
  if (sessionsCache.has(key)) return Promise.resolve();
  const pending = loading.get(key);
  if (pending) return pending;
  // A failed load stays failed until the next invalidation (no hot retry loop).
  if (errors.has(key)) return Promise.resolve();
  const p = (async () => {
    try {
      const rows = await loadSessions(project, worktree);
      sessionsCache.set(key, Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      errors.set(key, e?.message ?? String(e));
    } finally {
      loading.delete(key);
      sessionsSignal.bump();
    }
  })();
  loading.set(key, p);
  sessionsSignal.bump();
  return p;
}

// Cache invalidation from the outside world.
on('sessionsStale', (place) => invalidateSessions(place ? placeKeyOf(place.project, place.worktree) : undefined));

let prevSids = new Set<string | null>();
let prevStatus = new Map<string, string>();
appStore.subscribe(() => {
  const instances: Instance[] = appStore.get().instances;
  const sids = new Set(instances.map((i) => i.sessionId));
  let changed = sids.size !== prevSids.size;
  if (!changed) for (const s of sids) if (!prevSids.has(s)) { changed = true; break; }
  prevSids = sids;
  // A session appearing or disappearing changes which disk rows exist.
  if (changed) { invalidateSessions(); }
  // A turn ending writes the transcript: refetch that place's list.
  const next = new Map<string, string>();
  for (const i of instances) {
    next.set(i.id, i.status);
    const before = prevStatus.get(i.id);
    if (!changed && before && before !== 'idle' && i.status === 'idle') invalidateSessions(placeKeyOf(i.project, wtName(i)));
  }
  prevStatus = next;
});

// ── Lens scroll ──────────────────────────────────────────────────────────

type Lens = ReturnType<typeof uiStore.get>['lens'];
/** Each lens's body scroll offset. Module state, so the phone drawer's remount keeps it; not a store, so a scroll re-renders nothing. */
const lensScroll = new Map<Lens, number>();
export const lensScrollOf = (lens: Lens) => lensScroll.get(lens) ?? 0;
export function setLensScroll(lens: Lens, top: number) {
  lensScroll.set(lens, top);
}
/** Forgets every offset (tests). */
export function resetLensScroll() {
  lensScroll.clear();
}

// ── Ago ticker ───────────────────────────────────────────────────────────

export const agoTick = createSignal();
setInterval(() => agoTick.bump(), 15_000);
export const useAgoTick = () => useSignal(agoTick);
