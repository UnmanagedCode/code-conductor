// The plugin column's mode, derived from the route, the breakpoint, the dock
// selection and the room the main row leaves: hidden, a split beside the
// transcript, a rail (the split collapsed to a strip), or full (the whole row);
// and where the one app switcher shows for a mode. DOM-free (no JSX, no `@/` imports) so
// the e2e suite imports its constants as well.

/** The drag and key floor. */
export const DOCK_PANEL_MIN_WIDTH = 280;
/** The collapsed column's width: the rail holding Expand and the plugin's name. */
export const DOCK_RAIL_WIDTH = 36;
/** The split width when nothing is stored. */
export const DOCK_PANEL_DEFAULT_WIDTH = 420;
/** The transcript's floor beside a split: the handle's ceiling leaves it, and a window that can't keep it beside DOCK_PANEL_MIN_WIDTH shows the split full. */
export const DOCK_TRANSCRIPT_MIN_WIDTH = 400;

export type DockMode = 'hidden' | 'split' | 'rail' | 'full';

export type SwitcherSlot = 'pane' | 'sidebar' | 'drawer';

/** Where the one app switcher shows: the column's bar while it shows a plugin at split or full width; else the sidebar copy of the current breakpoint (the rail has no room for it). */
export function switcherSlot(mode: DockMode, desktop: boolean): SwitcherSlot {
  if (mode === 'split' || mode === 'full') return 'pane';
  return desktop ? 'sidebar' : 'drawer';
}

/** The widest panel that leaves the transcript its floor in a main row `available` px wide. */
export function maxPanel(available: number): number {
  return available - DOCK_TRANSCRIPT_MIN_WIDTH;
}

/** Whether any split fits; before the first measurement (null) it does. */
export function canSplit(available: number | null): boolean {
  return available === null || DOCK_PANEL_MIN_WIDTH <= maxPanel(available);
}

type Where = {
  desktop: boolean;
  /** The route's view (MainView in state/route.ts). */
  view: string;
  routePluginId: string | null;
  catalogIds: string[];
  /** The plugin selected in split (dock.ts). */
  dockId: string | null;
};

/** The plugin on screen: the full view's (listed or not), else on desktop beside a session the split selection the catalog lists, else none (Conductor). */
export function shownApp(i: Where): string | null {
  if (i.view === 'plugin') return i.routePluginId;
  if (i.desktop && i.view === 'session' && i.dockId !== null && i.catalogIds.includes(i.dockId)) return i.dockId;
  return null;
}

/** The bar's far-right control: Collapse (to the rail) wherever a rail can show beside the session, Close plugin where none can (below md, or a plugin the switcher does not list); none in the rail, which has its own Expand, or when hidden. */
export type Dismiss = 'collapse' | 'close';

/** The column's mode (a collapsed split beside a session is the rail, which always fits), the plugin it shows, the mode toggle it offers (only when the toggle's target layout is reachable) and the bar's dismiss control. */
export function dockLayout(i: Where & { available: number | null; collapsed: boolean }): { mode: DockMode; shownId: string | null; toggle: 'dock' | 'expand' | null; dismiss: Dismiss | null } {
  const shownId = shownApp(i);
  if (shownId === null) return { mode: 'hidden', shownId, toggle: null, dismiss: null };
  if (i.view === 'plugin') {
    const dockable = i.desktop && i.catalogIds.includes(shownId) && canSplit(i.available);
    return { mode: 'full', shownId, toggle: dockable ? 'dock' : null, dismiss: i.desktop && i.catalogIds.includes(shownId) ? 'collapse' : 'close' };
  }
  if (i.collapsed) return { mode: 'rail', shownId, toggle: null, dismiss: null };
  if (canSplit(i.available)) return { mode: 'split', shownId, toggle: 'expand', dismiss: 'collapse' };
  return { mode: 'full', shownId, toggle: null, dismiss: 'collapse' };
}
