// The diff view's layout, one choice per browser. Narrow viewports always render unified.
import { createStore, useStore } from '@/state/createStore';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';

export type DiffMode = 'unified' | 'split';

export const DIFF_MODE_STORAGE_KEY = 'code-conductor:diff-mode';
export function readDiffMode(): DiffMode {
  try { return localStorage.getItem(DIFF_MODE_STORAGE_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; }
}
export const diffModeStore = createStore<{ mode: DiffMode }>({ mode: readDiffMode() });

/** Choose the layout; when it is already in force nothing is written. */
export function setDiffMode(mode: DiffMode) {
  if (diffModeStore.get().mode === mode) return;
  diffModeStore.set({ mode });
  try { localStorage.setItem(DIFF_MODE_STORAGE_KEY, mode); } catch { /* storage unavailable */ }
}

/** The mode diffs render in: the stored one from md up, unified below. */
export function useDiffMode(): { mode: DiffMode; splitAvailable: boolean } {
  const splitAvailable = useMediaQuery(WIDE_QUERY);
  const stored = useStore(diffModeStore, (s) => s.mode);
  return { mode: splitAvailable ? stored : 'unified', splitAvailable };
}
