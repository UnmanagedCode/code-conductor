// One reading of a worktree hook's report (`postWorktreeCreate` /
// `postWorktreeMerge`, src/worktrees.ts) for every surface that shows one.
import type { PostWorktreeHook } from '@/state/types';

/** How many trailing lines of a failed hook's output its warning quotes. */
export const HOOK_OUTPUT_TAIL_LINES = 6;

/** A one-line summary: how the hook ended, or why it did not run. */
export function hookResultLabel(h: PostWorktreeHook): string {
  if (!h.ran) {
    if (h.skipped === 'STORE_HOOK_LOCAL_ONLY') return 'not run — a store hook runs only on this machine';
    if (h.skipped === 'disabled') return 'disabled';
    return h.error ? 'failed' : 'none';
  }
  const status = h.error ? 'failed to start' : h.timedOut ? 'timed out' : `exit ${h.exitCode}`;
  return `${status}${h.durationMs != null ? ` (${h.durationMs}ms)` : ''}${h.truncated ? ' · output truncated' : ''}`
    + (h.descendantsMaySurvive ? ' · what it started may still be running' : '');
}

/** The hook did not do its job: a non-zero exit, a timeout, an error, or a hook found and refused. */
export function hookFailed(h: PostWorktreeHook): boolean {
  if (h.error || h.skipped === 'STORE_HOOK_LOCAL_ONLY') return true;
  return h.ran && (!!h.timedOut || h.exitCode !== 0);
}

/** The last HOOK_OUTPUT_TAIL_LINES lines of the hook's output. */
export function hookOutputTail(h: PostWorktreeHook): string {
  return (h.output ?? '').trimEnd().split('\n').slice(-HOOK_OUTPUT_TAIL_LINES).join('\n');
}
