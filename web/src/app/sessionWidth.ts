// Session column width. One browser-local setting widens the whole session
// column (transcript, sticky pin, panels, composer) together.
import { useMemo } from 'react';
import { createStore, useStore } from '@/state/createStore';
import {
  SESSION_WIDTH_DEFAULT, clampSessionWidth, legacySessionWidth, parseSessionWidth, sessionWidthKey,
  type SessionWidthState,
} from './sessionWidthScale';

const KEY = 'code-conductor:session-width';

// Browser-storage migration: `migrations/` covers the server store only and
// cannot reach localStorage, so the owning store upgrades its own key at load.
function migrateStoredSessionWidth() {
  try {
    const mapped = legacySessionWidth(localStorage.getItem(KEY));
    if (mapped) localStorage.setItem(KEY, JSON.stringify(mapped));
  } catch { /* storage unavailable */ }
}

function read(): SessionWidthState {
  try {
    return parseSessionWidth(localStorage.getItem(KEY));
  } catch {
    return parseSessionWidth(null);
  }
}

migrateStoredSessionWidth();
export const sessionWidthStore = createStore<SessionWidthState>(read());

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

/** The props every session-column box carries: the e2e hook and the width cap. */
export function useSessionColumn() {
  const width = useStore(sessionWidthStore, (s) => s.width);
  const full = useStore(sessionWidthStore, (s) => s.full);
  return useMemo(
    () => ({
      'data-session-width': sessionWidthKey({ width, full }),
      style: { maxWidth: full ? 'none' : `${width}px` },
    }),
    [width, full],
  );
}
