// The session column's width range, snap points and labels. DOM-free (no JSX,
// no `@/` imports) so the e2e suite imports its constants as well.

/** The slider's floor, in px. */
export const SESSION_WIDTH_MIN = 480;
/** The slider's ceiling, in px; past it, Full width is the tool. */
export const SESSION_WIDTH_MAX = 1600;
/** The slider's step (1rem); every snap point is a multiple, so keyboard steps land on them. */
export const SESSION_WIDTH_STEP = 16;
/** A pointer drag within this many px of a snap point lands on it. */
export const SESSION_WIDTH_SNAP_RADIUS = 32;
export const SESSION_WIDTH_SNAPS = [
  { label: 'Normal', px: 768 },
  { label: 'Wide', px: 1024 },
] as const;
/** The width when nothing is stored, and what a reset returns to: Normal. */
export const SESSION_WIDTH_DEFAULT: number = SESSION_WIDTH_SNAPS[0].px;

export type SessionWidthState = { width: number; full: boolean };

const DEFAULT_STATE: SessionWidthState = { width: SESSION_WIDTH_DEFAULT, full: false };

export function clampSessionWidth(px: number): number {
  return Math.min(SESSION_WIDTH_MAX, Math.max(SESSION_WIDTH_MIN, Math.round(px)));
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
  if (s.full) return 'Full';
  return SESSION_WIDTH_SNAPS.find((snap) => snap.px === s.width)?.label ?? `${s.width} px`;
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

/** A pre-slider preset literal as the state it stood for; null for anything else. */
export function legacySessionWidth(raw: string | null): SessionWidthState | null {
  if (raw === 'normal') return { width: SESSION_WIDTH_SNAPS[0].px, full: false };
  if (raw === 'wide') return { width: SESSION_WIDTH_SNAPS[1].px, full: false };
  if (raw === 'full') return { width: SESSION_WIDTH_DEFAULT, full: true };
  return null;
}
