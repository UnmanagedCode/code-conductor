// The redirected shell: a sequence of commands with real exit codes and a real
// cwd, carried over `exec`.
//
// There is no shell OPERATION in the protocol. ONE `exec` PER COMMAND, of a
// script cc frames itself (src/systems/shellFraming.ts) — which is the shape a
// LOCAL Bash call already has, where nothing outlives the command either
// (card 2026-0312 §1).
//
// FAILURE MODES, all reachable and all tested:
//   ETIMEDOUT   — the per-command ceiling expired: a command that legitimately
//                 ran that long. The provider is what kills it, through the
//                 `exec` frame's own `timeoutMs`.
//   ESHELLGONE  — the command destroyed its own framing (an `exit`, a syntax
//                 error that takes the shell with it), so no sentinel arrived.
//   ECANCELLED  — the caller went away (an interrupt, a tool timeout). PER
//                 CALL: an unrelated command is untouched, because each command
//                 is its own `exec` with its own never-reused id to signal.
//
// NOTHING SERIALISES. N commands of one session are N independent processes,
// which is exactly what a local fan-out produces and is bounded by the same
// thing that bounds it locally — how many Bash calls the CLI runs at once
// (card 2026-0312 §2 D-b).
//
// CAPTURE, NOT CARRY. `ShellResult.cwd` still reports where the command ENDED,
// read back from the shell's own `$PWD` — but it is never fed into the next
// command, which always starts at the cwd this shell was configured with.
// src/systems/toolRedirect.ts turns the difference into the notice a worker
// reads, which is where a discarded `cd` becomes visible instead of silent.

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
  // WHERE THE COMMAND ENDED, read back from the shell itself and never parsed
  // out of the command. A `cd` inside a function, a `pushd`, a symlinked path —
  // the shell's own answer is the only one that is right. It is a REPORT, not a
  // hand-off: nothing feeds it into the next command.
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

// THE PER-COMMAND CEILING, AND IT NOW DOES EXACTLY ONE JOB: the longest a
// command may run. It used to do three (card 2026-0312 §2 D-d) — it also capped
// how long a WEDGED shell stayed wedged and how long a queued command waited for
// its turn — and both of those went with the long-lived shell and the queue. The
// counter-pressure that made card 2026-0305 say "no value is simply correct" WAS
// those two jobs; for the one that is left, this value simply is correct.
//
// ENFORCED BY THE PROVIDER, not by a cc-side timer: it leaves cc as the `exec`
// frame's `timeoutMs`, which is where every other operation's ceiling already
// lives. At this value cc never kills a command the CLI would still be waiting
// for FOR ANY TOOL TIMEOUT UP TO ITS DOCUMENTED MAX (see SHELL_TIMEOUT_SLACK_MS
// above for what is unmeasured past it). Raise it for legitimately longer
// background work — a LOCAL background Bash has no deadline at all — or to
// restore the ordering against a tool timeout above the documented max.
//
// EXPORTED so a test can pin the value and the derivation without waiting either
// out, the same shape as providerSystem.ts's DEFAULT_OP_TIMEOUT_MS. Read HERE
// rather than threaded through src/instances.ts: `commandTimeoutMs` below is a
// test seam beside three equally-unwired siblings in toolRedirect.ts, so this
// env var is the only thing a deployment has.
export const DEFAULT_COMMAND_TIMEOUT_MS =
  Number(process.env.ORCH_SHELL_COMMAND_TIMEOUT_MS) || BASH_TOOL_MAX_TIMEOUT_MS + SHELL_TIMEOUT_SLACK_MS;

// Everything a caller can say about one command. `signal` cancels THIS call.
//
// NO RUN BOUND HERE, DELIBERATELY. The ceiling is cc's and a caller cannot move
// it: mirroring the tool's own `timeout` onto it killed the command at the same
// instant the CLI DETACHED the forwarder and handed the agent a pointer to
// output that kept arriving, so the pointer was dead (card 2026-0305 §3). The
// CLI DETACHES a timed-out forwarder rather than killing it (measured, card
// 2026-0305 §3), so the command keeps running and cc's ceiling is what bounds
// it. The kill that does come — an interrupt, or a stopped background task —
// closes the socket, which is the cancellation channel and needs no number.
export interface ShellRunOptions extends ShellStreamSink {
  signal?: AbortSignal;
}

function cancelled(): SystemError {
  return new SystemError('ECANCELLED', 'the command was cancelled by its caller');
}

function overflowed(limit: number | undefined): SystemError {
  return new SystemError('EFBIG', `output exceeded the ${limit}-byte limit — the command was killed`);
}

export class ProviderShell {
  readonly #host: ShellHost;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #commandTimeoutMs: number;
  readonly #maxOutputBytes: number | undefined;

  // FIXED, and `readonly` says so. Every command starts here; where the last one
  // ENDED is reported in its own `ShellResult.cwd` and fed to nothing.
  readonly #cwd: string;

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

  async run(command: string, { onOut, onErr, signal }: ShellRunOptions = {}): Promise<ShellResult> {
    if (signal?.aborted) throw cancelled();
    const sink: ShellStreamSink = { ...(onOut ? { onOut } : {}), ...(onErr ? { onErr } : {}) };
    return this.#runOneShot(command, this.#commandTimeoutMs, sink, signal);
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
      // NO RESET REASON. A cancelled command's `exec` was killed and nothing was
      // shared for anyone to have lost, so telling the NEXT command "the shell
      // was restarted, your exports are gone" would be an R5-class false
      // statement about state it never had. With the queue gone this is
      // reachable on the ordinary interrupt path (card 2026-0312 §2 D-b).
      flushFilters(filters, sink);
      throw cancelled();
    }
    if (r.outputOverflowed) {
      flushFilters(filters, sink);
      throw overflowed(this.#maxOutputBytes);
    }
    if (r.timedOut) {
      flushFilters(filters, sink);
      // NOTHING IS RESET — the provider killed the command, and no state was
      // shared for the next one to have lost.
      throw new SystemError('ETIMEDOUT', `the command was still running after ${deadline}ms, cc's per-command ceiling`);
    }
    if (r.spawnError) {
      // The shell itself never started — a cwd deleted under the project is the
      // reachable case. That is ENOENT, and saying so beats reporting it as
      // "the command ended the shell", which is not what happened.
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
      throw new SystemError(
        'ESHELLGONE',
        `the command ended the shell before it could be framed (exit ${r.code})`,
        { exitCode: r.code, stderr: r.stderr },
      );
    }
    // CAPTURED, NEVER CARRIED: this is where the command ENDED, and it is fed
    // to nothing — the next command starts at `#cwd` like this one did.
    return { stdout: out.text, stderr: err.text, code: out.code, cwd: out.cwd || this.#cwd };
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
