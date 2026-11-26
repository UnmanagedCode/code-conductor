import { useSyncExternalStore } from 'react';
import { isViewOnly, sessionViewOnly, subscribeSessionViewOnly, subscribeViewOnly } from '@shared/viewOnly';

/** Whether this client runs under a read-only UI mode (`--ui view` or `--ui interact`): the global gate for app-wide controls. Non-React code calls `isViewOnly()`. */
export const useViewOnly = (): boolean => useSyncExternalStore(subscribeViewOnly, isViewOnly, isViewOnly);

/** Whether `sessionId`'s own controls are read-only: the global gate, minus the interactive session under `--ui interact`. Non-React code calls `sessionViewOnly()`. */
export function useSessionViewOnly(sessionId: string | null | undefined): boolean {
  const read = () => sessionViewOnly(sessionId);
  return useSyncExternalStore(subscribeSessionViewOnly, read, read);
}
