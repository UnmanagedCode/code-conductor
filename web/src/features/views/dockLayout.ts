// The plugin column's mode, derived from the route, the breakpoint, the dock
// state and the room the main row leaves: hidden, an icon rail, a split beside
// the transcript, or the full view. DOM-free (no JSX, no `@/` imports) so the
// e2e suite imports its constants as well.

/** px, the icon rail. */
export const DOCK_RAIL_WIDTH = 32;
/** A release below it snaps to the rail; the drag and key floor. */
export const DOCK_PANEL_MIN_WIDTH = 280;
/** The split width when nothing is stored. */
export const DOCK_PANEL_DEFAULT_WIDTH = 420;
/** The transcript's floor: past it a release snaps to full, and a window that can't keep it auto-collapses to the rail. */
export const DOCK_TRANSCRIPT_MIN_WIDTH = 400;

export type DockMode = 'hidden' | 'rail' | 'split' | 'full';

/** The widest panel that leaves the rail and the transcript their room; unbounded before the first measurement. */
export function maxPanel(available: number | null): number {
  return available === null ? Infinity : available - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH;
}

/** What a drag's release at the unclamped width `raw` does. */
export function releaseDecision(raw: number, available: number | null): 'rail' | 'full' | 'width' {
  if (raw < DOCK_PANEL_MIN_WIDTH) return 'rail';
  if (raw > maxPanel(available)) return 'full';
  return 'width';
}

/** The plugin a dock gesture opens: the docked one while it is listed, else the first app. */
export function dockTarget(dockId: string | null, catalogIds: string[]): string | null {
  return dockId !== null && catalogIds.includes(dockId) ? dockId : catalogIds[0] ?? null;
}

export function dockLayout(i: {
  desktop: boolean;
  /** The route's view (MainView in state/route.ts). */
  view: string;
  routePluginId: string | null;
  catalogIds: string[];
  dock: { id: string | null; open: boolean };
  width: number;
  available: number | null;
  dragging: boolean;
}): { mode: DockMode; shownId: string | null; railShown: boolean } {
  if (i.view === 'plugin') return { mode: 'full', shownId: i.routePluginId, railShown: i.desktop && i.catalogIds.length > 0 };
  if (!i.desktop || i.view !== 'session' || !i.catalogIds.length) return { mode: 'hidden', shownId: null, railShown: false };
  const fits = i.available === null || i.width + DOCK_RAIL_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH <= i.available;
  const id = i.dragging ? dockTarget(i.dock.id, i.catalogIds) : i.dock.open && i.dock.id !== null && i.catalogIds.includes(i.dock.id) ? i.dock.id : null;
  if (id !== null && fits) return { mode: 'split', shownId: id, railShown: true };
  return { mode: 'rail', shownId: null, railShown: true };
}
