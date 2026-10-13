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

/** The widest panel that leaves the rail and the transcript their room in a main row `available` px wide. */
export function maxPanel(available: number): number {
  return available - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH;
}

/** Whether a panel `width` px wide fits beside the rail and the transcript floor; before the first measurement (null) everything fits. */
export function fits(width: number, available: number | null): boolean {
  return available === null || width <= maxPanel(available);
}

/** Whether any split fits: false once not even DOCK_PANEL_MIN_WIDTH does, and then every open from the rail is the full view. */
export function canSplit(available: number | null): boolean {
  return fits(DOCK_PANEL_MIN_WIDTH, available);
}

/** What a drag's release at the unclamped width `raw` does: the rail below the minimum, else the full view when no split fits or `raw` passes the transcript limit. */
export function releaseDecision(raw: number, available: number): 'rail' | 'full' | 'width' {
  if (raw < DOCK_PANEL_MIN_WIDTH) return 'rail';
  if (!canSplit(available) || raw > maxPanel(available)) return 'full';
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
  const id = i.dragging ? dockTarget(i.dock.id, i.catalogIds) : i.dock.open && i.dock.id !== null && i.catalogIds.includes(i.dock.id) ? i.dock.id : null;
  if (id !== null && fits(i.width, i.available)) return { mode: 'split', shownId: id, railShown: true };
  return { mode: 'rail', shownId: null, railShown: true };
}
