// The Projects lens's text filter state. In memory only: never persisted, never
// written into `sidebarStore`, so clearing the query restores the user's own
// open and closed groups exactly.
import { createStore, useStore } from '@/state/createStore';

export type TextFilterState = {
  query: string;
  /** Auto-opened groups the user collapsed while filtering: `ws:<name>`, `wt:<project>`, `s:<placeKey>`. */
  collapsed: string[];
  /** The filter input is asked to take focus; the input that does clears it. */
  focusWanted: boolean;
};

const INITIAL: TextFilterState = { query: '', collapsed: [], focusWanted: false };
export const textFilterStore = createStore<TextFilterState>({ ...INITIAL });

export function setQuery(query: string) {
  if (query.trim() === '') textFilterStore.set({ query, collapsed: [] });
  else textFilterStore.set({ query });
}
export const clearQuery = () => setQuery('');

export function toggleForced(key: string) {
  textFilterStore.set((s) => ({ collapsed: s.collapsed.includes(key) ? s.collapsed.filter((k) => k !== key) : [...s.collapsed, key] }));
}
export const requestFilterFocus = () => textFilterStore.set({ focusWanted: true });
export const consumeFilterFocus = () => textFilterStore.set({ focusWanted: false });
export const useTextFilter = () => useStore(textFilterStore, (s) => s);

/** Forgets the query and every transient collapse (tests). */
export function resetTextFilter() {
  textFilterStore.set({ ...INITIAL });
}
