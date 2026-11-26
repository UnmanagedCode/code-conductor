// View-only refusals show ONE toast: every refusal re-fires the same-id warning,
// and a caller's own toast.error carrying the refusal message is folded into it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sonner = vi.hoisted(() => {
  const warning = vi.fn();
  const error = vi.fn();
  const fn: any = Object.assign(vi.fn(), { warning, error, success: vi.fn() });
  return { toast: fn, Toaster: () => null };
});
vi.mock('sonner', () => sonner);

import { refuse, setUiMode, VIEW_ONLY_MESSAGE } from '@shared/viewOnly';
import { toast, VIEW_ONLY_TOAST_ID } from '@/ui/feedback';
import { startViewOnlyNotice } from './viewOnlyNotice';

let stop: () => void;
beforeEach(() => { vi.clearAllMocks(); setUiMode('view'); stop = startViewOnlyNotice(); });
afterEach(() => { stop(); setUiMode('full'); });

describe('the view-only notice', () => {
  it('a refusal burst shows one toast (every call carries the same id)', () => {
    // Invariant: refusals collapse into a single sonner toast, keyed by VIEW_ONLY_TOAST_ID.
    refuse('POST /api/instances');
    refuse('prompt frame');
    expect(sonner.toast.warning).toHaveBeenCalledTimes(2);
    for (const call of sonner.toast.warning.mock.calls) expect(call[1]).toMatchObject({ id: VIEW_ONLY_TOAST_ID });
  });

  it('a caller\'s own error toast carrying the refusal message is folded away', () => {
    // Invariant: toast.error(title, VIEW_ONLY_MESSAGE) shows nothing; any other error still shows.
    toast.error('Merge failed', VIEW_ONLY_MESSAGE);
    expect(sonner.toast.error).not.toHaveBeenCalled();
    toast.error('Merge failed', 'conflict');
    expect(sonner.toast.error).toHaveBeenCalledTimes(1);
  });

  it('stopping removes the listener', () => {
    // Invariant: the returned function unsubscribes.
    stop();
    refuse('x');
    expect(sonner.toast.warning).not.toHaveBeenCalled();
  });
});
