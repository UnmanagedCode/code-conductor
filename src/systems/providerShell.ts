// The redirected shell: a sequence of commands with real exit codes and a real
// cwd, carried over `exec`.
//
// There is no shell OPERATION in the protocol. ONE `exec` PER COMMAND, of a
// script cc frames itself (src/systems/shellFraming.ts) — which is the shape a
// LOCAL Bash call already has, where nothing outlives the command either
// (card 2026-0312 §1).
//
// FAILURE MODES, all reachable and all tested:
//   EBUSY       — cc serialises per shell; a wait past its bound is refused
//                 rather than queued forever.
//   ETIMEDOUT   — the per-command ceiling expired: a command that legitimately
//                 ran that long. The provider is what kills it, through the
//                 `exec` frame's own `timeoutMs`.
//   ESHELLGONE  — the command destroyed its own framing (an `exit`, a syntax
//                 error that takes the shell with it), so no sentinel arrived.
//   ECANCELLED  — the caller went away (an interrupt, a tool timeout). PER
//                 CALL: a cancelled call that was still QUEUED never runs at
//                 all, and an unrelated command is untouched — each command is
//                 its own `exec`, with its own never-reused id to signal.

import {
  FS_ERROR_CODES, SystemError, classifySpawnError, type SystemErrorCode,
} from './protocol.ts';
import { FramedStreamFilter, frameCommand, newNonce, parseFramedStderr, parseFramedStdout } from './shellFraming.ts';
import type { ExecOptions, ExecResult, ExecSpec } from './system.ts';

// Live output, per stream, as it arrives. A caller that passes these gets the
// SAME bytes it would have read from the result at the end — FramedStreamFilter
// is what guarantees that — only sooner, and with the framing and the login
// shell's own banner already removed.
export interface ShellStreamSink {
  onOut?: (text: string) => void;
  onErr?: (text: string) => void;
}

// What the shell needs from a system, and nothing more — so it can be driven by
// a fake in tests without a provider process. ONE METHOD, and it is also what
// toolRedirect.ts's `isRedirectable` duck-types on.
export interface ShellHost {
  execOneShot(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult>;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  // Read back from the shell itself, never parsed out of the command. A `cd`
  // inside a function, a `pushd`, a symlinked path — the shell's own answer is
  // the only one that is right.
  cwd: string;
}

function isFsErrorCode(code: SystemErrorCode): boolean {
  return (FS_ERROR_CODES as readonly string[]).includes(code) && code !== 'EUNKNOWN';
}

// THE CLI's OWN CEILING for one Bash call. cc's sits ABOVE it rather than being
// tied to it: two timers armed on the same nominal value made which framing the
// agent got at the deadline a coin flip (card 2026-0305 §1). 600_000 is the
// built-in Bash tool's documented max — the same number src/mcp/handlers.ts
// clamps `project_bash` to — and 120_000 is its default, which cc used to tie
// this constant to.
const BASH_TOOL_MAX_TIMEOUT_MS = 600_000;

// Extra time cc keeps a command past the DOCUMENTED max above, so that for any
// tool timeout up to it the caller's own timer expires first and cc's is never
// what decides the outcome. SCOPED TO THE DOCUMENTED MAX ON PURPOSE: a tool
// timeout ABOVE 600_000 is unmeasured (the rig could not make the model emit
// one), and if the CLI honours such a value it outruns this ceiling — cc would
// then reset at 605s a command the CLI is still waiting on, which is this
// card's own dead-pointer divergence relocated. ORCH_SHELL_COMMAND_TIMEOUT_MS
// restores the ordering, and that is the answer rather than a placeholder:
// measuring the CLI's true maximum is not cheaply possible from here. Same
// value and same reason as providerSystem.ts's EXEC_TIMEOUT_SLACK_MS, which is
// not shared because providerSystem.ts imports THIS module.
const SHELL_TIMEOUT_SLACK_MS = 5_000;

// THE PER-COMMAND CEILING, AND IT IS ONE NUMBER DOING THREE JOBS: the longest a
// command may run, the longest a WEDGED shell stays wedged, and the longest a
// queued command waits for its turn on that agent's shell. So it is not "as
// large as possible". Unbounded is what the output fence below rules out for a
// caller that does not control the command — and here the MODEL writes the
// command: an unterminated quote is enough to wedge a shell, and nothing clears
// it early (the idle sweep is armed only after a command finishes). At this
// value cc never kills a command the CLI would still be waiting for FOR ANY
// TOOL TIMEOUT UP TO ITS DOCUMENTED MAX (see SHELL_TIMEOUT_SLACK_MS above for
// what is unmeasured past it), and a wedge always clears well inside
// toolRedirect.ts's 15-minute idle TTL. Raise it for legitimately longer
// background work — a LOCAL background Bash has no deadline at all — or to
// restore the ordering against a tool timeout above the documented max,
// knowing the wedge window rises with it either way.
//
// EXPORTED so a test can pin the value and the derivation without waiting either
// out, the same shape as providerSystem.ts's DEFAULT_OP_TIMEOUT_MS. Read HERE
// rather than threaded through src/instances.ts: `commandTimeoutMs` below is a
// test seam beside three equally-unwired siblings in toolRedirect.ts, so this
// env var is the only thing a deployment has.
export const DEFAULT_COMMAND_TIMEOUT_MS =
  Number(process.env.ORCH_SHELL_COMMAND_TIMEOUT_MS) || BASH_TOOL_MAX_TIMEOUT_MS + SHELL_TIMEOUT_SLACK_MS;

// Everything a caller can say about one command. `signal` cancels THIS call;
// `onStart` fires once it owns the shell, which is where a caller learns whether
// the shell it is about to use was reset since the last command.
export interface ShellRunOptions extends ShellStreamSink {
  // HOW LONG THIS CALL WILL WAIT FOR ITS TURN on the shell, and nothing else. It
  // does NOT bound how long the command may run — that is
  // DEFAULT_COMMAND_TIMEOUT_MS above, and no caller can move it. See run().
  timeoutMs?: number;
  signal?: AbortSignal;
  onStart?: () => void;
}

function cancelled(): SystemError {
  return new SystemError('ECANCELLED', 'the command was cancelled by its caller');
}

function overflowed(limit: number | undefined): SystemError {
  return new SystemError('EFBIG', `output exceeded the ${limit}-byte limit — the command was killed`);
}

interface Waiter { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout; drop: () => void }

export class ProviderShell {
  readonly #host: ShellHost;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #commandTimeoutMs: number;
  readonly #maxOutputBytes: number | undefined;

  #cwd: string;
  #busy = false;
  #waiters: Waiter[] = [];
  // Set to a reason when the last command lost the shell it ran in, so the next
  // one can SAY so rather than look continuous.
  #resetReason: string | null = null;

  constructor(host: ShellHost, opts: {
    cwd: string; env?: NodeJS.ProcessEnv; commandTimeoutMs?: number;
    // A FENCE on one command's total output in BYTES, not a truncation: past it the
    // command is killed and the call FAILS. cc accumulates a framed command's
    // bytes in its own heap — the parser's first-match-wins rule is about the
    // whole stream — so without a bound one runaway command takes the
    // orchestrator, and every other session on it, down with it. Omitted means
    // unbounded, which is only safe for a caller that controls the command.
    maxOutputBytes?: number;
  }) {
    this.#host = host;
    this.#cwd = opts.cwd;
    this.#env = opts.env;
    this.#commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#maxOutputBytes = opts.maxOutputBytes;
  }

  // The shell's real cwd, carried from the last command's sentinel.
  get cwd(): string { return this.#cwd; }

  async run(command: string, { timeoutMs, onOut, onErr, signal, onStart }: ShellRunOptions = {}): Promise<ShellResult> {
    // TWO NUMBERS NOW, AND ONLY ONE OF THEM IS THE CALLER'S TO SET.
    //
    // `timeoutMs` is how long THIS CALL is willing to WAIT for its turn on the
    // shell — the caller's own patience, and the same semantic the CLI's Bash
    // `timeout` has: a foreground wait, not a kill order. A call that would only
    // run for 30ms gives up waiting after 30ms; a call willing to run for ten
    // minutes waits that long rather than failing behind a healthy command (a
    // fixed 60s bound made a long command fail every queued call behind it).
    //
    // The RUN bound is cc's ceiling and the caller cannot move it. Mirroring
    // `timeoutMs` onto the deadline turned that foreground wait into a kill: the
    // CLI DETACHES a timed-out forwarder and hands the agent a pointer to output
    // that keeps arriving, and cc killed the command at the same instant, so the
    // pointer was dead. Nothing on the shell path may take its run bound from
    // the caller again (card 2026-0305 §3).
    const waitMs = timeoutMs ?? this.#commandTimeoutMs;
    const deadline = this.#commandTimeoutMs;
    if (signal?.aborted) throw cancelled();
    await this.#acquire(waitMs, signal);
    try {
      // RE-CHECKED AFTER ACQUISITION, and this is the whole of why a cancelled
      // queued call does not run: the caller may have gone away during the
      // wait, and the command's effects would land on the system with nobody
      // left to read the result.
      if (signal?.aborted) throw cancelled();
      onStart?.();
      const sink: ShellStreamSink = { ...(onOut ? { onOut } : {}), ...(onErr ? { onErr } : {}) };
      return await this.#runOneShot(command, deadline, sink, signal);
    } finally {
      this.#releaseTurn();
    }
  }

  // ── Serialisation ──────────────────────────────────────────────────

  #acquire(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.#busy) { this.#busy = true; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          waiter.drop();
          reject(new SystemError('EBUSY', `the shell is busy — waited ${waitMs}ms for its turn`));
        }, waitMs),
        // Leaving the shell UNTOUCHED. A waiter that gives up — timed out or
        // cancelled — has never owned the turn, so it must not release one:
        // #releaseTurn would hand the shell to the next waiter while the
        // in-flight command is still using it.
        drop: () => {
          clearTimeout(waiter.timer);
          this.#waiters = this.#waiters.filter(w => w !== waiter);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = () => { waiter.drop(); reject(cancelled()); };
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #releaseTurn(): void {
    const next = this.#waiters.shift();
    if (!next) { this.#busy = false; return; }
    // `drop()` also detaches its abort listener, so a waiter that has been
    // handed the turn can no longer be cancelled out from under itself — the
    // post-acquisition re-check in run() is what cancels it from here on.
    next.drop();
    next.resolve();
  }

  // The reason the last command lost its shell, or null. Surfaced to the
  // worker: a command that ran on a shell an earlier one destroyed must SAY so
  // rather than look continuous.
  get resetReason(): string | null { return this.#resetReason; }

  // The same reason, CONSUMED. Called from `onStart` — the moment a command owns
  // the shell — so the notice lands on the command that actually runs on the
  // fresh shell. Reading it when the call was merely CONSTRUCTED attaches it to
  // whichever call entered next, which may queue behind others and may never run
  // on that shell at all; the command that did run then says nothing, which is
  // exactly what R5 forbids.
  takeResetReason(): string | null {
    const r = this.#resetReason;
    this.#resetReason = null;
    return r;
  }

  // ── One framed exec per command ────────────────────────────────────

  async #runOneShot(command: string, deadline: number, sink: ShellStreamSink, signal?: AbortSignal): Promise<ShellResult> {
    const nonce = newNonce();
    // Live output rides `exec`'s own streaming hook through the SAME filters the
    // buffered result is parsed with, so the two can never disagree about what
    // the command printed.
    const filters = { out: new FramedStreamFilter(nonce, 'out'), err: new FramedStreamFilter(nonce, 'err') };
    // THE LAST CHECK before the command crosses: nothing cancelled is handed to
    // the far side. Everything between here and the call below is synchronous,
    // so there is no window for an abort to slip through unseen.
    if (signal?.aborted) throw cancelled();
    const r = await this.#host.execOneShot(
      { shell: frameCommand(nonce, command) },
      {
        cwd: this.#cwd, ...(this.#env ? { env: this.#env } : {}),
        timeoutMs: deadline, stdin: 'ignore',
        // THE FENCE, through the accounting `exec` already owns
        // (ExecOutputCollector).
        ...(this.#maxOutputBytes === undefined ? {} : { maxBufferBytes: this.#maxOutputBytes }),
        // CANCELLATION. An abort reaches the far side through `exec` itself —
        // without it the command runs to completion on someone else's machine,
        // bounded only by the deadline, with nobody left to read the result.
        ...(signal ? { signal } : {}),
        ...((sink.onOut || sink.onErr) ? {
          onChunk: (text: string, which: 'out' | 'err') => {
            const safe = filters[which].push(text);
            if (safe) (which === 'out' ? sink.onOut : sink.onErr)?.(safe);
          },
        } : {}),
      },
    );
    // Checked FIRST: a cancelled command's exec was killed, so it also looks
    // timed-out or unframed, and reporting either of those would describe the
    // consequence instead of the cause.
    if (signal?.aborted) {
      flushFilters(filters, sink);
      this.#resetReason = 'the command was interrupted by its caller';
      throw cancelled();
    }
    if (r.outputOverflowed) {
      flushFilters(filters, sink);
      this.#resetReason = 'a command exceeded its output limit';
      throw overflowed(this.#maxOutputBytes);
    }
    if (r.timedOut) {
      flushFilters(filters, sink);
      throw new SystemError('ETIMEDOUT', `the command was still running after ${deadline}ms, cc's per-command ceiling — the shell was reset`);
    }
    if (r.spawnError) {
      // The shell itself never started — a cwd deleted since the last command
      // is the reachable case. That is ENOENT, and saying so beats reporting it
      // as "the command ended the shell", which is not what happened.
      this.#resetReason = r.spawnError;
      // Same rule as ProviderSystem's #derive and runGit: a transport failure is
      // never classified by its text, because that text is the dying provider's
      // own stderr tail.
      if (r.transportFailure) {
        throw new SystemError('ETRANSPORT', `the shell could not start: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
      }
      throw new SystemError(classifySpawnError(r.spawnError), `the shell could not start: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
    }
    const out = parseFramedStdout(r.stdout, nonce);
    const err = parseFramedStderr(r.stderr, nonce);
    if (!out || !err) {
      // The command printed something before it took the shell with it, and no
      // frame survived to carry it in the result.
      flushFilters(filters, sink);
      // No sentinel and the shell is already gone: the command took the shell
      // with it (an `exit`, or a syntax error that never reached the framing).
      this.#resetReason = 'the command ended the shell before it could be framed';
      throw new SystemError(
        'ESHELLGONE',
        `the command ended the shell before it could be framed (exit ${r.code})`,
        { exitCode: r.code, stderr: r.stderr },
      );
    }
    this.#cwd = out.cwd || this.#cwd;
    return { stdout: out.text, stderr: err.text, code: out.code, cwd: this.#cwd };
  }
}

function flushFilters(
  filters: { out: FramedStreamFilter; err: FramedStreamFilter },
  sink: ShellStreamSink,
): void {
  for (const which of ['out', 'err'] as const) {
    const to = which === 'out' ? sink.onOut : sink.onErr;
    if (!to) continue;
    const rest = filters[which].flush();
    if (rest) to(rest);
  }
}
