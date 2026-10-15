// The session column's width floor, gutter, snap points, drag maths and labels. DOM-free (no JSX,
// no `@/` imports) so the e2e suite imports its constants as well.

/** The floor for stored and dragged widths, in px. */
export const SESSION_WIDTH_MIN = 480;
/** The room kept clear on each side of the column on desktop, in px: it keeps the handles off the dock divider, the sidebar handle and the scrollbar. */
export const SESSION_WIDTH_GUTTER = 24;
/** A pointer drag within this many width px of a snap point lands on it. */
export const SESSION_WIDTH_SNAP_RADIUS = 32;
export const SESSION_WIDTH_SNAPS = [
  { label: 'Normal', px: 768 },
  { label: 'Wide', px: 1024 },
] as const;
/** The width when nothing is stored, and what a reset returns to: Normal. */
export const SESSION_WIDTH_DEFAULT: number = SESSION_WIDTH_SNAPS[0].px;

export type SessionWidthState = { width: number; full: boolean };

const DEFAULT_STATE: SessionWidthState = { width: SESSION_WIDTH_DEFAULT, full: false };

/** The floor only: there is no fixed maximum. */
export function clampSessionWidth(px: number): number {
  return Math.max(SESSION_WIDTH_MIN, Math.round(px));
}

/** The widest a drag may go in `room` px: the room less a gutter per side, never below the floor. */
export function sessionWidthCeiling(room: number): number {
  return Math.max(SESSION_WIDTH_MIN, Math.floor(room - 2 * SESSION_WIDTH_GUTTER));
}

/** The width as shown in `room` px: the stored width capped to the ceiling. */
export function fitSessionWidth(px: number, room: number): number {
  return Math.min(sessionWidthCeiling(room), clampSessionWidth(px));
}

/** The width a drag of `dx` pointer px on `edge` leads to from `start`: mirrored (2x), snapped, then fitted to `room`. */
export function dragSessionWidth(start: number, dx: number, edge: 'left' | 'right', room: number): number {
  return fitSessionWidth(snapSessionWidth(start + 2 * (edge === 'right' ? dx : -dx)), room);
}

/** The nearest snap point's px when `px` is within the snap radius (inclusive), else `px`. */
export function snapSessionWidth(px: number): number {
  let best: number = px;
  let bestDist = Infinity;
  for (const { px: snap } of SESSION_WIDTH_SNAPS) {
    const dist = Math.abs(px - snap);
    if (dist <= SESSION_WIDTH_SNAP_RADIUS && dist < bestDist) { best = snap; bestDist = dist; }
  }
  return best;
}

export function sessionWidthLabel(s: SessionWidthState): string {
  return s.full ? 'Full' : `Resizable, ${s.width} px`;
}

/** The `data-session-width` value: the setting, not the rendered width. */
export function sessionWidthKey(s: SessionWidthState): string {
  return s.full ? 'full' : String(s.width);
}

/** The stored JSON shape; anything else reads as the default. */
export function parseSessionWidth(raw: string | null): SessionWidthState {
  try {
    const v: unknown = JSON.parse(raw ?? '');
    if (v && typeof v === 'object') {
      const { width, full } = v as { width?: unknown; full?: unknown };
      if (typeof width === 'number' && Number.isFinite(width) && typeof full === 'boolean') {
        return { width: clampSessionWidth(width), full };
      }
    }
  } catch { /* not JSON */ }
  return { ...DEFAULT_STATE };
}
