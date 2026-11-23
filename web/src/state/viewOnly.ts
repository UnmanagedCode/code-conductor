import { useSyncExternalStore } from 'react';
import { isViewOnly, subscribeViewOnly } from '@shared/viewOnly';

/** Whether this client is in view-only mode (CC_VIEW_ONLY). The one hook every component reads; non-React code calls `isViewOnly()`. */
export const useViewOnly = (): boolean => useSyncExternalStore(subscribeViewOnly, isViewOnly, isViewOnly);
