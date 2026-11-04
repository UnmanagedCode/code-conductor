// The headless run's one stdout object and its exit codes — the single source
// the entry (src/headless/entry.ts), the runner and the docs table read
// (docs/protocol.md → Headless run result).

import { constants } from 'node:os';
import { ROOT_LOCK_HELD_EXIT } from '../rootLock.ts';

export type HeadlessReason = 'completed' | 'conductor_error' | 'signal' | 'usage_error' | 'root_held' | 'boot_failed';

// Every reason but `signal`, whose code is 128 + the signal number (signalExitCode).
export const EXIT_CODES = {
  completed: 0,
  boot_failed: 1,
  usage_error: 2,
  conductor_error: 3,
  root_held: ROOT_LOCK_HELD_EXIT,
} as const satisfies Record<Exclude<HeadlessReason, 'signal'>, number>;

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

export interface HeadlessResult {
  reason: HeadlessReason;
  exitCode: number;
  sessionId: string | null;
  text: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
}

// A result carrying no session facts: a run that never spawned its root (usage,
// boot, a signal during boot), or the entry's catch-all.
export function bareResult(reason: Exclude<HeadlessReason, 'completed'>, error: string, exitCode: number): HeadlessResult {
  return { reason, exitCode, sessionId: null, text: null, costUsd: null, durationMs: null, error };
}

// One line, the fields in their documented order.
export function formatResult(r: HeadlessResult): string {
  const { reason, exitCode, sessionId, text, costUsd, durationMs, error } = r;
  return `${JSON.stringify({ reason, exitCode, sessionId, text, costUsd, durationMs, error })}\n`;
}
