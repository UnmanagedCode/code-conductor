// The dialogs are one lazy chunk, requested when App first renders. An open made before it lands is held in
// `dialogStore` and shows once the chunk lands. A chunk that cannot load, or a dialog that crashes, closes the dialog.
import * as React from 'react';
import { useStore } from '@/state/createStore';
import { toast } from '@/ui/feedback';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { closeDialog, dialogStore, type DialogState } from './api';

/** The first open slot, or null: a primitive, as `useStore` requires. */
const openSlot = (s: DialogState) => (Object.keys(s) as (keyof DialogState)[]).find((k) => s[k]) ?? null;

type Failure = { title: string; detail: string };
const LOAD_FAILED: Failure = { title: "The dialog couldn't open", detail: 'Part of the page failed to load. Reload the page and try again.' };
const CRASHED: Failure = { title: 'The dialog closed after an error', detail: 'Reload the page and try again.' };

/** Closes the open dialog and says why; renders nothing. */
function DialogsUnavailable({ failure }: { failure: Failure }) {
  const open = useStore(dialogStore, openSlot);
  React.useEffect(() => {
    // The live store, not `open`: a second pass of the effect finds the slot already closed.
    const slot = openSlot(dialogStore.get());
    if (!slot) return;
    closeDialog(slot);
    toast.error(failure.title, failure.detail);
  }, [open, failure]);
  return null;
}

export function lazyDialogsHost(load: () => Promise<{ DialogsHost: React.ComponentType }>): React.ComponentType {
  const Lazy = React.lazy(() => load().then(
    (m) => ({ default: m.DialogsHost }),
    (error) => {
      console.error('The dialogs failed to load', error);
      return { default: () => <DialogsUnavailable failure={LOAD_FAILED} /> };
    },
  ));
  return function LazyDialogs() {
    // Keyed on the open slot: the fallback closes it, which resets the boundary for the next open.
    const open = useStore(dialogStore, openSlot);
    return (
      <ErrorBoundary resetKey={open} fallback={() => <DialogsUnavailable failure={CRASHED} />}>
        <React.Suspense fallback={null}><Lazy /></React.Suspense>
      </ErrorBoundary>
    );
  };
}

export const LazyDialogsHost = lazyDialogsHost(() => import('./DialogsHost'));
