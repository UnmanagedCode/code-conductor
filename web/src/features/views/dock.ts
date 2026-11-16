// The plugin dock's state: which plugin sits in split beside the session, at
// which subpath, and the mode a pick from Conductor opens. The full view is the
// route (`#plugin/<id>/<subpath>`) and split is this store; they never coexist.
// A plugin link while split shows goes to the dock instead of the route (showLinkInDock).
// It is the user's place, not a route: persisted per browser, never in the hash.
// The collapse flag (split shown as a rail) is its own per-browser key.
import { createStore } from '@/state/createStore';
import { parseHash, routeStore } from '@/state/route';
import { on } from '@/app/events';
import { openPlugin } from './api';
import { leaveView, showActiveSession } from './ViewShell';
import { catalogStore, type RouteMirror } from './plugins';
import { canCollapseFullView, type DockMode } from './dockLayout';
import { WIDE_QUERY } from '@/lib/useMediaQuery';

/** The mode a pick from Conductor opens; written only by the column's toggle. */
export type DockPref = 'full' | 'split';
/** `id` is the plugin docked beside the session (split, or collapsed to the rail); `mode` is only the remembered pick. */
export type DockState = { id: string | null; subpath: string; mode: DockPref };

export const DOCK_STORAGE_KEY = 'code-conductor:plugin-dock';
/** The split panel's width, owned by the resize hook. */
export const DOCK_WIDTH_STORAGE_KEY = 'code-conductor:plugin-dock-width';

/** Whether the split shows as a rail; per browser like the split's width, cleared whenever the split selection is set or ended. */
export const DOCK_COLLAPSED_STORAGE_KEY = 'code-conductor:plugin-dock-collapsed';
export function readDockCollapsed(): boolean {
  try { return localStorage.getItem(DOCK_COLLAPSED_STORAGE_KEY) === 'true'; } catch { return false; }
}
export const dockCollapsedStore = createStore<{ collapsed: boolean }>({ collapsed: readDockCollapsed() });
dockCollapsedStore.subscribe(() => {
  try { localStorage.setItem(DOCK_COLLAPSED_STORAGE_KEY, String(dockCollapsedStore.get().collapsed)); } catch { /* storage unavailable */ }
});
/** Collapse or restore the split; when the flag already has that value it neither persists nor notifies subscribers. */
export function setDockCollapsed(collapsed: boolean) {
  if (dockCollapsedStore.get().collapsed !== collapsed) dockCollapsedStore.set({ collapsed });
}

const NOTHING: DockState = { id: null, subpath: '/', mode: 'full' };

export function readDockState(): DockState {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null');
    const valid = v !== null && typeof v === 'object'
      && (v.id === null || typeof v.id === 'string')
      && typeof v.subpath === 'string' && v.subpath.startsWith('/')
      && (v.mode === 'full' || v.mode === 'split');
    return valid ? { id: v.id, subpath: v.subpath, mode: v.mode } : NOTHING;
  } catch {
    return NOTHING;
  }
}

export const dockStore = createStore<DockState>(readDockState());

dockStore.subscribe(() => {
  const { id, subpath, mode } = dockStore.get();
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id, subpath, mode })); } catch { /* storage unavailable */ }
});

/** Set while `closeToConductor` changes the route, so the leave below does not park the plugin it is closing. */
let closingToConductor = false;

/** Full and split never coexist: entering the full view (a pick, Expand, a link while no split shows, the address bar, Forward) ends split. Leaving it parks the plugin as the collapsed dock at the page it was on, wherever Collapse shows (`canCollapseFullView`), so every exit but the switcher's Conductor collapses it; an exit that already docked it (Dock to side, Collapse) is left alone. Only the transition into the plugin view clears, so Dock to side and `collapseFullView` can select while the route is still leaving it. The subscription runs inside `routeStore.set`, before React renders, so the frame is never reloaded. */
let prev = routeStore.get().route;
if (prev.view === 'plugin' && dockStore.get().id !== null) closeDock();
routeStore.subscribe(() => {
  const next = routeStore.get().route;
  const was = prev;
  prev = next;
  if (next.view === 'plugin' && was.view !== 'plugin') {
    if (dockStore.get().id !== null) closeDock();
  } else if (was.view === 'plugin' && next.view !== 'plugin' && was.pluginId && !closingToConductor && dockStore.get().id === null
    && canCollapseFullView(matchMedia(WIDE_QUERY).matches, catalogStore.get().apps.map((a) => a.id), was.pluginId)) {
    parkCollapsed(was.pluginId, was.pluginPath);
  }
});

/** The plugin column's mode, published by PluginView from dockLayout: `App` hides the main slot while it is 'full' (the full view, or a split too narrow to fit), and the app switcher's slots place the one switcher by it. */
export const dockModeStore = createStore<{ mode: DockMode }>({ mode: 'hidden' });

/** The plugin the column shows beside the session (split, rail, or a split too narrow to fit), else null (hidden, the full view, below md); PluginView publishes it from dockLayout. */
export const dockBesideStore = createStore<{ id: string | null }>({ id: null });

/** Shows a plugin link's hash (already checked by `viewLinkHash`) in the dock and returns true; false when no dock shows or the switcher does not list its plugin, so the caller opens the full view. A rail expands. No route change, no history entry. */
export function showLinkInDock(hash: string): boolean {
  if (dockBesideStore.get().id === null) return false;
  const { view, pluginId, pluginPath } = parseHash(hash);
  if (view !== 'plugin' || !pluginId || !catalogStore.get().apps.some((a) => a.id === pluginId)) return false;
  setDockCollapsed(false);
  dockStore.set({ id: pluginId, subpath: `/${pluginPath}` });
  return true;
}

/** A link a plugin page's bridge caught (`openLink`, its href already checked by `viewLinkHash`): the dock when one shows; else the fragment navigation a `_top` link to cc's page makes. */
export function followFrameLink(hash: string) {
  if (!showLinkInDock(hash)) location.hash = hash;
}

/** A user's session pick collapses a split shown full-screen in a window too narrow for it (a rail always fits); a pick out of the full view is the route leave above. Only a user's pick: the first-connect restore keeps what a reload restored. */
on('select', ({ userGesture }) => {
  if (userGesture && dockModeStore.get().mode === 'full' && routeStore.get().route.view !== 'plugin') setDockCollapsed(true);
});

/** Split: the docked frame's own navigation is remembered as the dock's subpath. */
export const dockMirror: RouteMirror = (id, path) => {
  const cur = dockStore.get();
  if (id === cur.id && path !== cur.subpath) dockStore.set({ subpath: path });
};

/** The switcher's pick: the full view below md, from a plugin view, or with full remembered while no plugin shows expanded beside the session (a rail does not count); else split beside the session, closing a view that covers it. */
export function selectApp(id: string, desktop: boolean) {
  const { view } = routeStore.get().route;
  if (!desktop || view === 'plugin' || (dockStore.get().mode === 'full' && (dockBesideStore.get().id === null || dockCollapsedStore.get().collapsed))) {
    openPlugin(id);
    return;
  }
  // The anchor write lands on the session whatever history holds beneath; stepping back could enter a plugin's full view, which ends split and so the pick.
  if (view !== 'session') showActiveSession();
  setDockCollapsed(false);
  dockStore.set({ id, subpath: '/' });
}

/** Nothing in split; the remembered mode stays. */
export function closeDock() {
  setDockCollapsed(false);
  dockStore.set({ id: null, subpath: '/' });
}

/** Split → full: remembers full and opens the docked plugin's full view at its subpath (entering it ends split). */
export function expandDock() {
  const { id, subpath } = dockStore.get();
  if (!id) return;
  dockStore.set({ mode: 'full' });
  openPlugin(id, subpath.slice(1));
}

/** Docks plugin `id` collapsed at the page `pluginPath`, keeping the remembered mode (a later pick from Conductor opens full again). */
function parkCollapsed(id: string, pluginPath: string) {
  setDockCollapsed(true);
  dockStore.set({ id, subpath: `/${pluginPath}` });
}

/** The one full close (the switcher's Conductor): no plugin docked or in full, and the active session. Nothing is parked on the way, so nothing transient is persisted. */
export function closeToConductor() {
  closingToConductor = true;
  try { showActiveSession(); } finally { closingToConductor = false; }
  closeDock();
}

/** Docks the full view's plugin at its page's route, then leaves the full view; entering the view again re-uses the same frame. */
function dockRouteApp(mode?: DockPref) {
  const { pluginId, pluginPath } = routeStore.get().route;
  if (!pluginId) return;
  dockStore.set({ id: pluginId, subpath: `/${pluginPath}`, ...(mode && { mode }) });
  leaveView();
}

/** Full → split: remembers split on the full view's plugin at its page's route, and leaves the full view. */
export function dockFullView() {
  dockRouteApp('split');
}

/** Full → rail: docks the full view's plugin collapsed and leaves the full view, keeping the remembered mode (a later pick from Conductor opens full again). */
export function collapseFullView() {
  const { pluginId, pluginPath } = routeStore.get().route;
  if (!pluginId) return;
  parkCollapsed(pluginId, pluginPath);
  leaveView();
}
