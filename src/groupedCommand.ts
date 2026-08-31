// Detached process-group command runner.
//
// Five places in the tree spawn a child that can fork grandchildren (`npm ci`,
// `npm install`, a plugin's start command, a post-worktree hook, `git`). All of
// them need the same two things, and all of them had their own copy:
//
//   - `detached: true` so the child leads its own process GROUP, letting one
//     `process.kill(-pid, sig)` reach every grandchild. Killing just the direct
//     child orphans the rest, which is how a timed-out `npm ci` used to keep
//     running after the request that started it was gone.
//   - a SIGTERM → SIGKILL backstop, because a shell script that traps or ignores
//     SIGTERM (`sleep` does on some platforms) would otherwise never die.
//
// `runGroupedCommand` is the full runner for one-shot commands.
// `killProcessGroup` is exported separately for the long-lived case (the plugin
// supervisor owns its child's lifecycle and only needs the kill).
//
// The runner NEVER rejects: every failure mode resolves to a result. A spawn
// error is `{code: 1}` with the error message as output, and a timeout is
// `{code: 124, timedOut: true}` — 124 being the exit code `timeout(1)` uses,
// which callers already branch on.

import { spawn } from 'node:child_process';
import { ExecOutputCollector } from './systems/execCollector.ts';
import type { ExecOptions, ExecResult, ExecSpec } from './systems/system.ts';

// Tail of a command's output kept in memory. Chatty scripts (npm ci, a browser
// downloader) can emit megabytes; only the tail is ever shown or logged. This
// is the single owner of the value — it was previously three separate 16*1024
// literals whose comments cross-referenced each other.
export const GROUP_OUTPUT_CAP = 16 * 1024;

// SIGTERM → SIGKILL delay for a one-shot command. Long enough for a well-behaved
// script to unwind, short enough that a wedged one doesn't hold the caller.
const DEFAULT_KILL_GRACE_MS = 100;

// The local implementation of the System `exec` primitive: its result and
// option shapes ARE the interface's (src/systems/system.ts), so LocalSystem
// delegates here without a translation layer. The aliases keep this module's
// own vocabulary readable at its call sites.
export type GroupedCommandResult = ExecResult;
export type GroupedCommandOptions = ExecOptions;

// SIGTERM the whole process group, then SIGKILL it after `graceMs` if it is
// still there. The backstop timer is `unref`'d so a pending kill can never hold
// the event loop open. Both signals are best-effort: an already-dead group
// throws ESRCH, which is the expected outcome, not an error.
export function killProcessGroup(
  pid: number | null | undefined,
  { graceMs = DEFAULT_KILL_GRACE_MS, fallback }: { graceMs?: number; fallback?: (signal: NodeJS.Signals) => void } = {},
): void {
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (pid == null) { try { fallback?.(sig); } catch { /* already gone */ } return; }
    try { process.kill(-pid, sig); }
    catch { try { fallback?.(sig); } catch { /* already gone */ } }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), graceMs).unref();
}

// `shell` runs the command string through `bash -lc` — what a user-authored
// hook/start command expects (pipes, `&&`, login-shell PATH).
export type GroupedCommandSpec = ExecSpec;

export function runGroupedCommand(
  spec: GroupedCommandSpec,
  { cwd, env = process.env, timeoutMs, cap, headCapBytes, maxBufferBytes, onChunk, killGraceMs, stdin, signal }: GroupedCommandOptions,
): Promise<GroupedCommandResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const [cmd, args] = 'shell' in spec ? ['bash', ['-lc', spec.shell]] : [spec.argv[0], spec.argv.slice(1)];
    let proc: ReturnType<typeof spawn>;
    // Output accounting is the SHARED implementation (src/systems/execCollector.ts):
    // the wire `exec` must be indistinguishable from this one, so both read the
    // caps, the fence and the decoders out of the same object.
    const collector = new ExecOutputCollector(
      { cap, headCapBytes, maxBufferBytes, onChunk },
      () => killProcessGroup(proc.pid, { graceMs: killGraceMs, fallback: (sig) => proc.kill(sig) }),
    );
    try {
      proc = spawn(cmd, args, {
        cwd, env, detached: true,
        // 'ignore' gives the command a closed stdin so an interactive one sees
        // EOF instead of blocking on a pipe nobody writes to.
        ...(stdin === 'ignore' ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : {}),
      });
    } catch (e) {
      // spawn throws SYNCHRONOUSLY for an invalid argument — a NUL byte in an
      // argv entry is the reachable case, since the caller's own string lands
      // there — where a missing binary or a bad cwd arrives as an 'error'
      // event. The runner never rejects either way: both become a spawnError.
      const msg = e instanceof Error ? e.message : String(e);
      resolve(collector.result(1, { timedOut: false, spawnError: msg, durationMs: Date.now() - start }));
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => collector.push('out', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => collector.push('err', chunk));

    let timedOut = false;
    const kill = () => killProcessGroup(proc.pid, { graceMs: killGraceMs, fallback: (sig) => proc.kill(sig) });
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Cancellation KILLS, it does not merely abandon: the caller has gone away,
    // so nothing will ever read this command's output and letting it run to
    // completion leaves its EFFECTS behind.
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number, spawnError?: string): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(collector.result(code, { timedOut, spawnError, durationMs: Date.now() - start }));
    };

    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (e) => finish(1, e.message));
  });
}
