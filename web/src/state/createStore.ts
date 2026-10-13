import { useSyncExternalStore } from 'react';

// A minimal external store: plain state object, immutable updates, React reads
// through useSyncExternalStore. Selectors must return stable references (a
// field of the state, or a primitive) — derive anything else with useMemo.
export type Store<S> = {
  get: () => S;
  set: (patch: Partial<S> | ((s: S) => Partial<S>)) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore<S extends object, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

/** A version counter for mutable objects (trackers, models) React must re-read. */
export function createSignal() {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    bump() {
      version++;
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    version: () => version,
  };
}
export type Signal = ReturnType<typeof createSignal>;

export function useSignal(signal: Signal): number {
  return useSyncExternalStore(signal.subscribe, signal.version, signal.version);
}
