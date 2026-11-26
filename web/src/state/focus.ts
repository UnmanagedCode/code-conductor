import { useSyncExternalStore } from 'react';
import { focusState, subscribeFocus } from '@shared/focus';

const inFocusMode = (): boolean => focusState() !== null;

/** Whether this client is in focus mode: the server put it there (a headless run or a `--replay`) or the page's URL carries `?focus=<sid>`: no sidebar, one session. */
export const useFocusMode = (): boolean => useSyncExternalStore(subscribeFocus, inFocusMode, inFocusMode);
