// The headless run's result, its exit codes and its output formats — the single
// source the entry (src/headless/entry.ts), the runner and the docs tables read
// (docs/protocol/headless.md → Headless run result, Output formats).

import { constants } from 'node:os';
import { ROOT_LOCK_HELD_EXIT } from '../rootLock.ts';

// `--output-format`'s values; `json` is the default.
export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export type HeadlessReason = 'completed' | 'conductor_error' | 'signal' | 'usage_error' | 'root_held' | 'boot_failed' | 'stopped' | 'no_session';

// Every reason but `signal`, whose code is 128 + the signal number (signalExitCode).
export const EXIT_CODES = {
  completed: 0,
  boot_failed: 1,
  usage_error: 2,
  conductor_error: 3,
  root_held: ROOT_LOCK_HELD_EXIT,
  // `--replay` only (src/headless/replay.ts): the replay's normal end, and a root with no session to show.
  stopped: 0,
  no_session: 4,
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

// The result as `format` prints it: stdout's bytes, plus a stderr line where the
// format has no room for the error. `stream-json`'s is the stream's last line,
// marked `cc_result` so it never reads as a CLI's per-turn `result`.
export function renderResult(r: HeadlessResult, format: OutputFormat): { stdout: string; stderr: string | null } {
  if (format === 'json') return { stdout: formatResult(r), stderr: null };
  if (format === 'stream-json') {
    const { reason, exitCode, sessionId, text, costUsd, durationMs, error } = r;
    return { stdout: `${JSON.stringify({ type: 'cc_result', reason, exitCode, sessionId, text, costUsd, durationMs, error })}\n`, stderr: null };
  }
  return {
    stdout: r.text === null ? '' : `${r.text}\n`,
    stderr: r.error === null ? null : `headless: ${r.reason}: ${r.error}\n`,
  };
}
