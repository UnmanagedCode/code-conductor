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
import { StringDecoder } from 'node:string_decoder';
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
  { cwd, env = process.env, timeoutMs, cap, headCapBytes, onChunk, killGraceMs, stdin }: GroupedCommandOptions,
): Promise<GroupedCommandResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const [cmd, args] = 'shell' in spec ? ['bash', ['-lc', spec.shell]] : [spec.argv[0], spec.argv.slice(1)];
    let proc: ReturnType<typeof spawn>;
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
      resolve({
        code: 1, stdout: '', stderr: msg, output: msg,
        timedOut: false, truncated: false, durationMs: Date.now() - start, spawnError: msg,
      });
      return;
    }

    let stdout = '', stderr = '', output = '', truncated = false;
    // One decoder per stream so a multi-byte character split across two chunk
    // boundaries still decodes correctly — the per-chunk `.toString()` the old
    // copies used could split it into two replacement characters.
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

    const clip = (s: string): string => {
      if (cap === undefined || s.length <= cap) return s;
      truncated = true;
      return s.slice(-cap);
    };

    // Bytes retained so far under a HEAD cap, shared across both streams. Whole
    // chunks are kept until the budget is met, so retention can overshoot by at
    // most one chunk; past that the pipes are still drained (the command runs to
    // completion) but nothing more is kept.
    let headBytes = 0;

    const onData = (which: 'out' | 'err') => (d: Buffer) => {
      if (headCapBytes !== undefined) {
        if (headBytes >= headCapBytes) { truncated = true; return; }
        headBytes += d.length;
        if (headBytes >= headCapBytes) truncated = true;
      }
      const s = decoders[which].write(d);
      if (!s) return;
      if (which === 'out') stdout = clip(stdout + s);
      else stderr = clip(stderr + s);
      output = clip(output + s);
      onChunk?.(s);
    };
    proc.stdout?.on('data', onData('out'));
    proc.stderr?.on('data', onData('err'));

    let timedOut = false;
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, { graceMs: killGraceMs, fallback: (sig) => proc.kill(sig) });
    }, timeoutMs);

    // On a spawn error (ENOENT, EACCES) the message becomes the diagnostic. It
    // fills whichever buffers are still empty — in practice all of them, since
    // the error fires before any data — so `output`-reading and `stderr`-reading
    // callers both see it without either clobbering real output.
    const finish = (code: number, spawnError?: string): void => {
      if (timer) clearTimeout(timer);
      if (spawnError) {
        if (!stderr) stderr = spawnError;
        if (!output) output = spawnError;
      }
      resolve({
        code: timedOut ? 124 : code,
        stdout, stderr, output,
        timedOut, truncated,
        durationMs: Date.now() - start,
        spawnError: spawnError ?? null,
      });
    };

    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (e) => finish(1, e.message));
  });
}
