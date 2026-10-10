import * as React from 'react';

let counter = 0;

/**
 * A fresh key every time a dialog slot is (re)opened, so the dialog's body
 * remounts and every field starts from its reset state.
 */
export function useOpenKey(slot: unknown): number {
  return React.useMemo(() => ++counter, [slot]);
}
