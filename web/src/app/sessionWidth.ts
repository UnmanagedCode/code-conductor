// Session column width. One browser-local setting widens the whole session
// column (transcript, sticky pin, panels, composer) together.
import { useMemo } from 'react';
import { createStore, useStore } from '@/state/createStore';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import {
  SESSION_WIDTH_DEFAULT, SESSION_WIDTH_GUTTER, clampSessionWidth, parseSessionWidth, sessionWidthKey,
  type SessionWidthState,
} from './sessionWidthScale';

const KEY = 'code-conductor:session-column';

function read(): SessionWidthState {
  try {
    return parseSessionWidth(localStorage.getItem(KEY));
  } catch {
    return parseSessionWidth(null);
  }
}

export const sessionWidthStore = createStore<SessionWidthState>(read());

/** The width a handle drag is showing, before release commits it; null when no drag is live. */
export const sessionWidthDragStore = createStore<{ live: number | null }>({ live: null });

function update(patch: Partial<SessionWidthState>) {
  const next = { ...sessionWidthStore.get(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  sessionWidthStore.set(next);
}

export function setSessionWidth(px: number) {
  update({ width: clampSessionWidth(px) });
}

/** Full never touches the width, so the custom value survives toggling it. */
export function setSessionFull(full: boolean) {
  update({ full });
}

export function resetSessionWidth() {
  setSessionWidth(SESSION_WIDTH_DEFAULT);
}

/**
 * The props every width box carries: the e2e hook and the width cap. The session column keeps a gutter clear per side on
 * desktop, which keeps its edge handles off the dock divider, the sidebar handle and the scrollbar. Full-page views have
 * no handles and pass `gutter: false` for the plain cap.
 */
export function useSessionColumn({ gutter = true }: { gutter?: boolean } = {}) {
  const width = useStore(sessionWidthStore, (s) => s.width);
  const full = useStore(sessionWidthStore, (s) => s.full);
  const live = useStore(sessionWidthDragStore, (s) => s.live);
  const desktop = useMediaQuery(WIDE_QUERY);
  return useMemo(() => {
    const w = live ?? width;
    return {
      'data-session-width': sessionWidthKey({ width, full }),
      style: { maxWidth: full ? 'none' : desktop && gutter ? `min(${w}px, 100% - ${2 * SESSION_WIDTH_GUTTER}px)` : `${w}px` },
    };
  }, [width, full, live, desktop, gutter]);
}
