// The plugin dock's state: which plugin sits in the desktop column beside the
// session, at which subpath, and whether it is open or collapsed to the rail.
// It is the user's place, not a route: persisted per browser, never in the hash.
import { createStore } from '@/state/createStore';
import type { Route } from '@/state/route';
import { openPlugin } from './api';
import { leaveView } from './ViewShell';
import { hashMirror, type RouteMirror } from './plugins';
import type { DockMode } from './dockLayout';

export type DockState = { id: string | null; subpath: string; open: boolean };

export const DOCK_STORAGE_KEY = 'code-conductor:plugin-dock';
/** The split panel's width, owned by the resize hook. */
export const DOCK_WIDTH_STORAGE_KEY = 'code-conductor:plugin-dock-width';

const CLOSED: DockState = { id: null, subpath: '/', open: false };

export function readDockState(): DockState {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null');
    const valid = v !== null && typeof v === 'object'
      && (v.id === null || typeof v.id === 'string')
      && typeof v.subpath === 'string' && v.subpath.startsWith('/')
      && typeof v.open === 'boolean';
    return valid ? { id: v.id, subpath: v.subpath, open: v.open } : CLOSED;
  } catch {
    return CLOSED;
  }
}

export const dockStore = createStore<DockState>(readDockState());

dockStore.subscribe(() => {
  const { id, subpath, open } = dockStore.get();
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id, subpath, open })); } catch { /* storage unavailable */ }
});

/** Split: the docked frame's own navigation is remembered as the dock's subpath. */
export const dockMirror: RouteMirror = (id, path) => {
  const cur = dockStore.get();
  if (id === cur.id && path !== cur.subpath) dockStore.set({ subpath: path });
};

/** Full view: the frame's navigation goes into the hash, and into the dock when it is the docked plugin, so docking back sends no stale navigate. */
export const fullMirror: RouteMirror = (id, path) => {
  hashMirror(id, path);
  dockMirror(id, path);
};

/** Dock `id` open; a different plugin starts at its root. */
export function openDock(id: string) {
  const cur = dockStore.get();
  dockStore.set({ id, open: true, subpath: id === cur.id ? cur.subpath : '/' });
}

export function collapseDock() {
  dockStore.set({ open: false });
}

/** Dock `id` at `subpath` and leave the full view (Back, or the session's anchor). */
export function dockFromFull(id: string, subpath: string) {
  dockStore.set({ id, subpath, open: true });
  leaveView();
}

/** The docked plugin in the full view, at the subpath it is on. */
export function expandDocked() {
  const { id, subpath } = dockStore.get();
  if (id) openPlugin(id, subpath.slice(1));
}

/** A rail icon: on the rail open it; in split collapse the docked one or swap; in full dock it beside the session. */
export function pickRailApp(id: string, mode: DockMode, route: Route) {
  const cur = dockStore.get();
  if (mode === 'full') {
    dockFromFull(id, id === route.pluginId ? `/${route.pluginPath}` : id === cur.id ? cur.subpath : '/');
  } else if (mode === 'split' && id === cur.id) {
    collapseDock();
  } else {
    openDock(id);
  }
}
