import * as React from 'react';
import { clampSidebarWidth, SIDEBAR_WIDTH_STORAGE_KEY } from './derive';

export function loadSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return raw ? clampSidebarWidth(Number(raw)) : null;
  } catch {
    return null;
  }
}

/** The desktop column's width: dragged live from the right-edge handle, persisted on release. */
export function useSidebarWidth() {
  const [width, setWidth] = React.useState<number | null>(loadSidebarWidth);
  const [active, setActive] = React.useState(false);
  const drag = React.useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const aside = e.currentTarget.parentElement;
    const startWidth = aside?.getBoundingClientRect().width ?? width ?? 288;
    drag.current = { startX: e.clientX, startWidth, last: startWidth };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setActive(true);
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = clampSidebarWidth(d.startWidth + (e.clientX - d.startX));
    if (next != null) { d.last = next; setWidth(next); }
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    document.body.style.userSelect = '';
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(d.last)); } catch { /* private mode */ }
  };
  const onDoubleClick = () => {
    setWidth(null);
    try { localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY); } catch { /* ignore */ }
  };

  return {
    width,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onDoubleClick, 'data-active': active },
  };
}
