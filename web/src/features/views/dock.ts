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

/** The mode a pick from Conductor opens; written only by the column's toggle. */
export type DockPref = 'full' | 'split';
/** `id` is the plugin in split, so it is set only while `mode` is 'split'. */
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
      && (v.mode === 'full' || v.mode === 'split')
      && (v.id === null || v.mode === 'split');
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

/** Full and split never coexist: entering the full view (a pick, Expand, a link while no split shows, the address bar, Forward) ends split, so leaving it lands on Conductor. Only the transition clears, so Dock to side can select while the route is still leaving the plugin. */
let inPlugin = routeStore.get().route.view === 'plugin';
if (inPlugin && dockStore.get().id !== null) closeDock();
routeStore.subscribe(() => {
  const now = routeStore.get().route.view === 'plugin';
  if (now && !inPlugin && dockStore.get().id !== null) closeDock();
  inPlugin = now;
});

/** Whether the plugin column fills the main row: the full view, or a split too narrow to fit; `App` hides the main slot while it does. */
export const dockFullStore = createStore<{ full: boolean }>({ full: false });

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

/** A link a plugin page's bridge caught (`openLink`): the dock when one shows; else the fragment navigation the browser would have made for the page's `_top` link. */
export function followFrameLink(hash: string) {
  if (!showLinkInDock(hash)) location.hash = hash;
}

/** A session pick closes a full-screen plugin, as in the full view. Only a user's pick: the first-connect restore keeps what a reload restored. */
on('select', ({ userGesture }) => {
  if (userGesture && dockFullStore.get().full) closeDock();
});

/** Split: the docked frame's own navigation is remembered as the dock's subpath. */
export const dockMirror: RouteMirror = (id, path) => {
  const cur = dockStore.get();
  if (id === cur.id && path !== cur.subpath) dockStore.set({ subpath: path });
};

/** The switcher's pick: the full view below md, from a plugin view, or with full remembered; else split beside the session, closing a view that covers it. */
export function selectApp(id: string, desktop: boolean) {
  const { view } = routeStore.get().route;
  if (!desktop || view === 'plugin' || dockStore.get().mode === 'full') {
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

/** Full → split: remembers split on the full view's plugin at its page's route, and leaves the full view. */
export function dockFullView() {
  const { pluginId, pluginPath } = routeStore.get().route;
  if (!pluginId) return;
  dockStore.set({ id: pluginId, subpath: `/${pluginPath}`, mode: 'split' });
  leaveView();
}
