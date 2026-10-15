import * as React from 'react';
import { useStore } from '@/state/createStore';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import { RESIZE_HANDLE_CLASS, setResizing } from '@/lib/useResizableWidth';
import { cn } from '@/lib/utils';
import {
  resetSessionWidth, sessionWidthDragStore, sessionWidthStore, setSessionWidth, useSessionColumn,
} from '@/app/sessionWidth';
import { dragSessionWidth, fitSessionWidth } from '@/app/sessionWidthScale';

type Edge = 'left' | 'right';
type Drag = { startX: number; start: number; room: number; last: number; moved: boolean };

/**
 * Pointer-only drag handles on both edges of the session column; dragging one
 * mirrors the other. Mounted over the transcript and composer, so the strips
 * span the whole column. Hidden from assistive tech: the footer toggle is the
 * keyboard path to the setting.
 */
export function SessionWidthHandles() {
  const desktop = useMediaQuery(WIDE_QUERY);
  const full = useStore(sessionWidthStore, (s) => s.full);
  const column = useSessionColumn();
  const layerRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<Drag | null>(null);
  const [active, setActive] = React.useState<Edge | null>(null);

  const end = React.useCallback(() => {
    const d = drag.current;
    drag.current = null;
    sessionWidthDragStore.set({ live: null });
    setResizing(false);
    setActive(null);
    return d;
  }, []);
  const visible = desktop && !full;
  // Hiding the handles (Full, a drawer viewport) or unmounting them (a session switch) mid-drag drops the body flag and the live width.
  React.useEffect(() => () => { if (drag.current) end(); }, [visible, end]);

  if (!visible) return null;

  const onPointerDown = (edge: Edge) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const room = layerRef.current?.getBoundingClientRect().width ?? 0;
    const start = fitSessionWidth(sessionWidthStore.get().width, room);
    drag.current = { startX: e.clientX, start, room, last: start, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setResizing(true);
    setActive(edge);
  };
  const onPointerMove = (edge: Edge) => (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.clientX === d.startX) return;
    d.moved = true;
    d.last = dragSessionWidth(d.start, e.clientX - d.startX, edge, d.room);
    sessionWidthDragStore.set({ live: d.last });
  };
  const onPointerUp = () => {
    const d = end();
    if (d?.moved) setSessionWidth(d.last);
  };

  const handle = (edge: Edge) => (
    <div
      data-session-handle={edge}
      data-active={active === edge}
      className={cn('pointer-events-auto absolute inset-y-0', edge === 'left' ? '-left-1' : '-right-1', RESIZE_HANDLE_CLASS)}
      onPointerDown={onPointerDown(edge)}
      onPointerMove={onPointerMove(edge)}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { end(); }}
      onDoubleClick={resetSessionWidth}
    />
  );

  return (
    <div ref={layerRef} aria-hidden="true" data-session-handles className="pointer-events-none absolute inset-0 z-20">
      <div style={column.style} className="relative mx-auto h-full w-full">
        {handle('left')}
        {handle('right')}
      </div>
    </div>
  );
}
