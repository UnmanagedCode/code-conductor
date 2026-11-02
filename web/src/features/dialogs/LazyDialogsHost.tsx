// The dialogs are one lazy chunk, requested when App first renders. An open made before it lands is held in
// `dialogStore` and shows once the chunk lands. A chunk that cannot load closes every dialog it is asked to open.
import * as React from 'react';
import { useStore } from '@/state/createStore';
import { toast } from '@/ui/feedback';
import { closeDialog, dialogStore, type DialogState } from './api';

/** The first open slot, or null: a primitive, as `useStore` requires. */
const openSlot = (s: DialogState) => (Object.keys(s) as (keyof DialogState)[]).find((k) => s[k]) ?? null;

function DialogsUnavailable() {
  const open = useStore(dialogStore, openSlot);
  React.useEffect(() => {
    // The live store, not `open`: a second pass of the effect finds the slot already closed.
    const slot = openSlot(dialogStore.get());
    if (!slot) return;
    closeDialog(slot);
    toast.error("The dialog couldn't open", 'Part of the page failed to load. Reload the page and try again.');
  }, [open]);
  return null;
}

export function lazyDialogsHost(load: () => Promise<{ DialogsHost: React.ComponentType }>): React.ComponentType {
  const Lazy = React.lazy(() => load().then(
    (m) => ({ default: m.DialogsHost }),
    (error) => {
      console.error('The dialogs failed to load', error);
      return { default: DialogsUnavailable };
    },
  ));
  return function LazyDialogs() {
    return <React.Suspense fallback={null}><Lazy /></React.Suspense>;
  };
}

export const LazyDialogsHost = lazyDialogsHost(() => import('./DialogsHost'));
