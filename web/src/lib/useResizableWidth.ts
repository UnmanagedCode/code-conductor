// A width resized from an edge handle: dragged live, committed on release or
// by the arrow keys (the WAI-ARIA window-splitter pattern), persisted per key.
import * as React from 'react';

/** The edge of the resized box the handle sits on: 'right' grows with +dx (sidebar), 'left' grows with -dx (plugin column). */
export type ResizeEdge = 'left' | 'right';
export const RESIZE_KEY_STEP = 16;

export type ResizableWidthOptions = {
  /** The committed width persists here as String(px). */
  storageKey: string;
  /** Floor for stored, dragged and keyed widths. */
  min: number;
  /** Ceiling for dragged and keyed widths, and aria-valuemax; may change every render. */
  max: number;
  /** When nothing (or garbage) is stored. */
  defaultWidth: number;
  edge: ResizeEdge;
  /** The separator's aria-label. */
  label: string;
  /** aria-valuemin reads 0: collapse is a reachable value. */
  collapsible?: boolean;
  /** aria-valuenow reads 0, and a drag or key starts from 0. A function is given the preferred width, for a caller whose collapse depends on it. */
  collapsed?: boolean | ((preferred: number) => boolean);
  /** Pointer release at the unclamped width; false = the caller handled it (a snap), commit nothing. Default: commit. */
  onRelease?: (raw: number) => boolean;
  /** Double-click and Enter. Default: remove the key (back to defaultWidth). */
  onToggle?: () => void;
  /** After every commit (release or arrow key). */
  onCommit?: (width: number) => void;
};

function readWidth(key: string, min: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.max(min, n) : null;
  } catch {
    return null;
  }
}

function setResizing(on: boolean) {
  document.body.style.userSelect = on ? 'none' : '';
  if (on) document.body.dataset.resizing = '';
  else delete document.body.dataset.resizing;
}

export function useResizableWidth(o: ResizableWidthOptions) {
  const [stored, setStored] = React.useState<number | null>(() => readWidth(o.storageKey, o.min));
  const [live, setLive] = React.useState<number | null>(null);
  const [active, setActive] = React.useState(false);
  const drag = React.useRef<{ startX: number; start: number; raw: number } | null>(null);

  const ceiling = Math.max(o.max, o.min);
  const clamp = (n: number) => Math.min(ceiling, Math.max(o.min, n));
  const preferred = stored ?? Math.max(o.min, o.defaultWidth);
  const width = clamp(preferred);
  const collapsed = typeof o.collapsed === 'function' ? o.collapsed(preferred) : !!o.collapsed;
  const start = collapsed ? 0 : width;
  const sign = o.edge === 'right' ? 1 : -1;

  const commit = (w: number) => {
    const px = Math.round(w);
    setStored(px);
    try { localStorage.setItem(o.storageKey, String(px)); } catch { /* private mode */ }
    o.onCommit?.(px);
  };
  const reset = () => {
    setStored(null);
    try { localStorage.removeItem(o.storageKey); } catch { /* ignore */ }
  };
  const toggle = () => (o.onToggle ?? reset)();

  const end = () => {
    const d = drag.current;
    drag.current = null;
    setActive(false);
    setLive(null);
    setResizing(false);
    return d;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, start, raw: start };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setActive(true);
    setResizing(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    d.raw = d.start + sign * (e.clientX - d.startX);
    setLive(clamp(d.raw));
  };
  const onPointerUp = () => {
    const d = end();
    if (d && (o.onRelease?.(d.raw) ?? true)) commit(clamp(d.raw));
  };
  // A cancelled drag (the browser took the pointer) commits nothing; the live width reverts.
  const onPointerCancel = () => { end(); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const grow = o.edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = o.edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === 'Enter') { e.preventDefault(); toggle(); return; }
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    if (e.key === shrink && collapsed) return;
    commit(clamp(start + (e.key === grow ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP)));
  };

  return {
    preferred,
    width,
    live,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-label': o.label,
      'aria-valuenow': Math.round(live ?? start),
      'aria-valuemin': o.collapsible ? 0 : o.min,
      'aria-valuemax': Math.round(ceiling),
      tabIndex: 0 as const,
      onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick: toggle, onKeyDown,
      'data-active': active,
    },
  };
}
