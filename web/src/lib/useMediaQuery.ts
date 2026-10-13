import * as React from 'react';

/** Whether the media query matches; re-renders when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
