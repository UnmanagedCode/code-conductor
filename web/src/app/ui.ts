// UI-only state that is not part of the server's data: the mobile drawer,
// the sidebar lens, and per-session view toggles.
import { createStore } from '@/state/createStore';

const LENS_KEY = 'code-conductor:sidebar-lens';

function readLens(): 'conductors' | 'projects' {
  try {
    return localStorage.getItem(LENS_KEY) === 'projects' ? 'projects' : 'conductors';
  } catch {
    return 'conductors';
  }
}

export const uiStore = createStore({
  /** The phone-width sidebar drawer. */
  sidebarOpen: false,
  lens: readLens() as 'conductors' | 'projects',
  /** Sessions with "Show mid-turn statistics" on (per-call usage lines). */
  callUsageShown: {} as Record<string, true>,
});

export const isCallUsageShown = (sid: string | null | undefined) => !!sid && !!uiStore.get().callUsageShown[sid];

export function setCallUsageShown(sid: string | null | undefined, on: boolean) {
  if (!sid) return;
  const next = { ...uiStore.get().callUsageShown };
  if (on) next[sid] = true;
  else delete next[sid];
  uiStore.set({ callUsageShown: next });
}

export function setLens(lens: 'conductors' | 'projects') {
  uiStore.set({ lens });
  try { localStorage.setItem(LENS_KEY, lens); } catch { /* storage unavailable */ }
}

export function closeSidebarOnMobile() {
  if (uiStore.get().sidebarOpen) uiStore.set({ sidebarOpen: false });
}
