import { useSyncExternalStore } from 'react';
import { focusState, subscribeFocus } from '@shared/focus';

const inFocusMode = (): boolean => focusState() !== null;

/** Whether the server put this client in focus mode (a headless run or a `--replay`): no sidebar, one session. */
export const useFocusMode = (): boolean => useSyncExternalStore(subscribeFocus, inFocusMode, inFocusMode);
