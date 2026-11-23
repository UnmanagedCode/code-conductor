// Focus mode's opener: a headless-family server names one session on
// GET /api/health (shared/focus.ts) and the client opens it with no gesture, so
// a live session is selected and an inactive one opens read-only — never a
// POST. A live run's root has not spawned when the page loads, so the read
// repeats until the server names it.

import { apiFetch } from '@shared/http';
import { capabilitiesSettled } from '@shared/capabilities';
import { focusFromHealth, focusState, setFocus } from '@shared/focus';

export const FOCUS_POLL_MS = 1000;

export interface FocusOpenDeps {
  signal: AbortSignal;
  refreshInstances: () => Promise<unknown>;
  hasActive: () => boolean;
  resumeSessionByAnchor: (anchor: string, opts: { clearAnchorOnMiss: boolean }) => Promise<boolean>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function openFocusedSession({ signal, refreshInstances, hasActive, resumeSessionByAnchor }: FocusOpenDeps): Promise<void> {
  // The app's own startup read (main.tsx) names the focus; a controller started without one has none.
  await capabilitiesSettled();
  while (focusState() !== null && focusState()?.sessionId === null) {
    await sleep(FOCUS_POLL_MS, signal);
    if (signal.aborted) return;
    // A failed read keeps polling.
    try { setFocus(focusFromHealth(await apiFetch('/api/health'))); }
    catch (e) { console.warn('focus: could not read /api/health, will retry:', e); }
  }
  const id = focusState()?.sessionId;
  if (!id || signal.aborted) return;
  await refreshInstances();
  // A session already selected (an anchor that resolved, or the user's own pick) stands.
  if (hasActive()) return;
  await resumeSessionByAnchor(id, { clearAnchorOnMiss: false });
}
