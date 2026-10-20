// Detached process-group command runner.
//
// Five places in the tree spawn a child that can fork grandchildren (`npm ci`,
// `npm install`, a plugin's start command, a post-worktree hook, `git`). All of
// them need the same two things:
//
//   - the platform's `group` spawn options, so the child leads its own process
//     GROUP and one `platform.killGroup` reaches every grandchild. Killing just
//     the direct child orphans the rest, so a timed-out `npm ci` would keep
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
import type { Platform } from './platform/index.ts';
import { ExecOutputCollector } from './systems/execCollector.ts';
import { assertEnvOverlay, shellWithPrelude } from './systems/execWrap.ts';
import type { ExecOptions, ExecResult, ExecSpec } from './systems/system.ts';

// Tail of a command's output kept in memory. Chatty scripts (npm ci, a browser
// downloader) can emit megabytes; only the tail is ever shown or logged. This
// is the single owner of the value — it was previously three separate 16*1024
// literals whose comments cross-referenced each other.
export const GROUP_OUTPUT_CAP = 16 * 1024;

// The shorter tail a failed or finished command carries back to a client (a
// refused restart's, an update's npm step's).
export const RESULT_TAIL_CAP = 4000;

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
  { graceMs = DEFAULT_KILL_GRACE_MS, fallback, platform }: { graceMs?: number; fallback?: (signal: NodeJS.Signals) => void; platform: Platform },
): void {
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (pid == null) { try { fallback?.(sig); } catch { /* already gone */ } return; }
    try { platform.killGroup(pid, sig as 'SIGTERM' | 'SIGKILL'); }
    catch { try { fallback?.(sig); } catch { /* already gone */ } }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), graceMs).unref();
}

// `shell` runs the command string through the platform's login shell — what a
// user-authored hook/start command expects (pipes, `&&`, login-shell PATH).
export type GroupedCommandSpec = ExecSpec;

export function runGroupedCommand(
  spec: GroupedCommandSpec,
  { cwd, env = process.env, timeoutMs, cap, headCapBytes, maxBufferBytes, onChunk, killGraceMs, stdin, signal, envOverlay, encoding }: GroupedCommandOptions,
  platform: Platform,
): Promise<GroupedCommandResult> {
  // The overlay ADDS to the environment. An argv command takes it as a merge;
  // a shell command takes it as `export` lines after the login profile, so the
  // profile cannot override it — the same prelude the wire path uses
  // (src/systems/execWrap.ts), which keeps the two indistinguishable.
  let runSpec = spec;
  let runEnv = env;
  if (envOverlay && Object.keys(envOverlay).length > 0) {
    assertEnvOverlay(envOverlay);
    if ('shell' in spec) runSpec = { shell: shellWithPrelude(spec.shell, { envOverlay }) };
    else runEnv = { ...env, ...envOverlay };
  }
  // A non-empty Buffer goes down a pipe; an empty one is EOF, i.e. 'ignore'.
  const input = Buffer.isBuffer(stdin) && stdin.length > 0 ? stdin : null;
  const closedStdin = stdin === 'ignore' || (Buffer.isBuffer(stdin) && stdin.length === 0);
  return new Promise((resolve) => {
    const start = Date.now();
    let proc: ReturnType<typeof spawn>;
    // Output accounting is the SHARED implementation (src/systems/execCollector.ts):
    // the wire `exec` must be indistinguishable from this one, so both read the
    // caps, the fence and the decoders out of the same object.
    const collector = new ExecOutputCollector(
      { cap, headCapBytes, maxBufferBytes, onChunk, encoding },
      () => killProcessGroup(proc.pid, { graceMs: killGraceMs, fallback: (sig) => proc.kill(sig), platform }),
    );
    try {
      const { command: cmd, args } = platform.commandFor(runSpec);
      proc = spawn(cmd, args, {
        cwd, env: runEnv, ...platform.spawnOptions('group'),
        // 'ignore' gives the command a closed stdin so an interactive one sees
        // EOF instead of blocking on a pipe nobody writes to.
        ...(closedStdin ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : {}),
      });
    } catch (e) {
      // spawn throws SYNCHRONOUSLY for an invalid argument — a NUL byte in an
      // argv entry is the reachable case, since the caller's own string lands
      // there (so does `commandFor`, when the host shell cannot be resolved) —
      // where a missing binary or a bad cwd arrives as an 'error'
      // event. The runner never rejects either way: both become a spawnError.
      const msg = e instanceof Error ? e.message : String(e);
      resolve(collector.result(1, { timedOut: false, spawnError: msg, durationMs: Date.now() - start }));
      return;
    }

    if (input) {
      // EPIPE when the command exits without reading all of it — the command's
      // own choice, reported through its exit, not a failure of the runner.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(input);
    }

    proc.stdout?.on('data', (chunk: Buffer) => collector.push('out', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => collector.push('err', chunk));

    let timedOut = false;
    const kill = () => killProcessGroup(proc.pid, { graceMs: killGraceMs, fallback: (sig) => proc.kill(sig), platform });
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
