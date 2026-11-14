// Lets pending async work land before a test reads the page: React updates, promise chains,
// zero-delay timers (real, or faked by Vitest), and whatever the DOM does in response.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Consecutive turns without a DOM change that end a settle, and so its minimum length. A
 * settle-then-absent assertion therefore always sees at least this many rounds of
 * zero-delay timers, however quiet the DOM is.
 */
export const SETTLE_QUIET_TURNS = 10;
// A DOM change can keep a settle going only if one lands within every quiet window. No timer in
// web/src repeats that fast, so a DOM that is still changing at the cap is a loop: fail, don't hang.
const MAX_TURNS = 200;

export async function settle(): Promise<void> {
  // Vitest marks the functions it fakes with `clock`; vi.isFakeTimers() is also true when only Date is faked.
  const turn = 'clock' in globalThis.setTimeout
    ? () => vi.advanceTimersByTimeAsync(0)
    : () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  let changed = false;
  const observer = new MutationObserver(() => { changed = true; });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    let quiet = 0;
    for (let i = 0; i < MAX_TURNS; i++) {
      await act(async () => { await turn(); });
      if (observer.takeRecords().length > 0) changed = true;
      quiet = changed ? 0 : quiet + 1;
      changed = false;
      if (quiet >= SETTLE_QUIET_TURNS) return;
    }
    throw new Error(`settle: the DOM was still changing after ${MAX_TURNS} turns`);
  } finally {
    observer.disconnect();
  }
}
