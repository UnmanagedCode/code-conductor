// The redirected shell: a sequence of commands with real exit codes and a real
// cwd, carried over `exec`.
//
// There is no shell OPERATION in the protocol. With `persistentShell` this is
// ONE `exec` of `$SHELL -l` that cc keeps open and writes framed commands into;
// without it, each command is its own `exec` of the identical framing. Both
// modes share src/systems/shellFraming.ts, so the fallback cannot parse
// differently from the path it falls back from — and the fallback's user-
// visible difference is exactly the local CLI's own behaviour: cwd carries,
// exports do not.
//
// FOUR FAILURE MODES, all reachable and all tested:
//   EBUSY       — cc serialises per shell; a wait past its bound is refused
//                 rather than queued forever.
//   ETIMEDOUT   — the per-command ceiling expired. TWO CAUSES, one outcome: a
//                 wedge (an unterminated quote leaves the shell reading input
//                 that will never come, so no sentinel can arrive) or a command
//                 that legitimately ran that long. RESETS the shell either way;
//                 the next command gets a fresh one.
//   ESHELLGONE  — the shell died, or the command destroyed the framing (an
//                 `exit`, a syntax error that takes the shell with it), so no
//                 sentinel can arrive. Also a reset.
//   EUNSUPPORTED— asking for a persistent shell on a provider that has none.
//   ECANCELLED  — the caller went away (an interrupt, a tool timeout). PER
//                 CALL, not per shell: a cancelled call that was still QUEUED
//                 never runs at all, and an unrelated in-flight command is
//                 untouched. Cancelling the in-flight one does reset the shell,
//                 because a framed command shares the shell's process group and
//                 has no exec id of its own to signal — see the deviation note
//                 on background jobs in docs/architecture.md.

import { StringDecoder } from 'node:string_decoder';
import {
  FS_ERROR_CODES, SystemError, classifySpawnError,
  type Capabilities, type SystemDescriptor, type SystemErrorCode,
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

export interface ShellStreamHandlers {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
  onExit(code: number): void;
  onDown(err: SystemError): void;
}

export interface ShellStream {
  write(text: string): void;
  close(): void;
  // Hold the connection's event-loop reference for the span of one command.
  retain(): void;
  release(): void;
}

// What the shell needs from a system, and nothing more — so it can be driven by
// a fake in tests without a provider process.
export interface ShellHost {
  readonly capabilities: Capabilities;
  readonly descriptor: SystemDescriptor | null;
  execOneShot(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult>;
  openStream(spec: ExecSpec, opts: ExecOptions, handlers: ShellStreamHandlers): Promise<ShellStream>;
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

// Extra time cc keeps a command past the CLI's own ceiling, so the CLI's timer
// always expires first and cc's is never what decides the outcome. Same value
// and same reason as providerSystem.ts's EXEC_TIMEOUT_SLACK_MS, which is not
// shared because providerSystem.ts imports THIS module.
const SHELL_TIMEOUT_SLACK_MS = 5_000;

// THE PER-COMMAND CEILING, AND IT IS ONE NUMBER DOING THREE JOBS: the longest a
// command may run, the longest a WEDGED shell stays wedged, and the longest a
// queued command waits for its turn on that agent's shell. So it is not "as
// large as possible". Unbounded is what the output fence below rules out for a
// caller that does not control the command — and here the MODEL writes the
// command: an unterminated quote is enough to wedge a shell, and nothing clears
// it early (the idle sweep is armed only after a command finishes). At this
// value cc never kills a command the CLI itself would still be waiting for, and
// a wedge always clears well inside toolRedirect.ts's 15-minute idle TTL. Raise
// it for legitimately longer background work — a LOCAL background Bash has no
// deadline at all — knowing the wedge window rises with it.
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
  #stream: ShellStream | null = null;
  #busy = false;
  #waiters: Waiter[] = [];
  // Non-null only while a command is in flight. Everything that arrives while
  // it is null is DISCARDED — that is rule 2's "stop parsing until cc writes
  // the next command", and it is what keeps a forged sentinel from shifting the
  // boundary of the NEXT command.
  #pending: PendingCommand | null = null;
  #outDecoder = new StringDecoder('utf8');
  #errDecoder = new StringDecoder('utf8');
  // Set to a reason when the stream died, so the next run() opens a fresh one.
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

  // True while a long-lived shell process is live. False in the fallback mode
  // (there is nothing to keep alive) and after a reset.
  get open(): boolean { return this.#stream !== null; }

  // Whether this shell carries state between commands. The one user-visible
  // difference of the fallback, so it is readable rather than inferred.
  get persistent(): boolean { return this.#host.capabilities.persistentShell; }

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
      return this.persistent
        ? await this.#runPersistent(command, deadline, sink, signal)
        : await this.#runOneShot(command, deadline, sink, signal);
    } finally {
      this.#releaseTurn();
    }
  }

  // Close the shell. Idempotent.
  async close(): Promise<void> {
    this.#tearDown('closed by cc');
  }

  // Drop the shell without touching the connection (the connection is already
  // gone). Used by ProviderSystem.dispose.
  forget(): void {
    this.#stream = null;
    this.#pending?.fail(new SystemError('ESHELLGONE', 'the shell was discarded'));
    this.#pending = null;
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

  // ── Persistent mode ────────────────────────────────────────────────

  async #runPersistent(command: string, deadline: number, sink: ShellStreamSink, signal?: AbortSignal): Promise<ShellResult> {
    const stream = await this.#ensureStream();
    const r = await this.#exchange(stream, command, deadline, sink, signal);
    this.#cwd = r.cwd || this.#cwd;
    return { ...r, cwd: this.#cwd };
  }

  // One framed command over an open shell.
  async #exchange(stream: ShellStream, command: string, deadline: number, sink: ShellStreamSink, signal?: AbortSignal): Promise<ShellResult> {
    const nonce = newNonce();
    const pending = new PendingCommand(nonce, sink, this.#maxOutputBytes, () => {
      // Killing the shell is what stops the command — it has no exec id of its
      // own — so the fence is a reset, exactly like a deadline.
      this.#tearDown('a command exceeded its output limit', overflowed(this.#maxOutputBytes));
    });
    this.#pending = pending;
    stream.retain();
    let timer: NodeJS.Timeout | null = null;
    // Installed ONLY for the span this command owns the shell. Closing the
    // shell is the only way to stop a framed command — it shares the shell's
    // process group and has no exec id of its own — so a cancellation here is a
    // reset, and it is scoped to the caller that asked for it.
    const onAbort = () => this.#tearDown('the command was interrupted by its caller', cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // THE LAST CHECK, and the one that closes the gap the two in run() cannot.
      // run() checks before acquiring and again after, then awaits
      // #ensureStream() — opening a shell is I/O, and it happens on every first
      // command and on every reopen after a wedge, deadline, idle sweep, abort or
      // output-fence reset. An abort landing in that await was seen by neither
      // check, and `{once:true}` on an already-fired signal never fires either —
      // so the cancelled command was written to the shell and became permanently
      // un-cancellable, its effects landing on the system.
      //
      // Here it is airtight: the listener above is already armed, and everything
      // between this line and the write below is synchronous, so an abort either
      // fired before this check (caught here) or after the write (caught by the
      // listener). There is no third case.
      if (signal?.aborted) throw cancelled();
      const settled = new Promise<ShellResult>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
        timer = setTimeout(() => {
          // Either a wedge — an unterminated quote leaves the shell waiting for
          // input that will never come — or a command that really ran this
          // long. Reset either way: a shell that cannot frame a command cannot
          // frame the next one either, and a command with no exec id of its own
          // can only be stopped by closing the shell it shares a process group
          // with. The reset is what fails this command, with ETIMEDOUT rather
          // than the generic shell-gone code, because the deadline is what it
          // was.
          this.#tearDown(
            'a command exceeded its deadline',
            new SystemError('ETIMEDOUT', `the command was still running after ${deadline}ms, cc's per-command ceiling — the shell was reset`),
          );
        }, deadline);
        timer.unref?.();
      });
      stream.write(frameCommand(nonce, command));
      return await settled;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (this.#pending === pending) this.#pending = null;
      stream.release();
    }
  }

  async #ensureStream(): Promise<ShellStream> {
    if (this.#stream) return this.#stream;
    const shellPath = this.#host.descriptor?.shell ?? '/bin/bash';
    this.#outDecoder = new StringDecoder('utf8');
    this.#errDecoder = new StringDecoder('utf8');
    const stream = await this.#host.openStream(
      { argv: [shellPath, '-l'] },
      { cwd: this.#cwd, ...(this.#env ? { env: this.#env } : {}) },
      {
        onStdout: (b) => this.#pending?.pushOut(this.#outDecoder.write(b)),
        onStderr: (b) => this.#pending?.pushErr(this.#errDecoder.write(b)),
        onExit: (code) => this.#down(`the shell exited (code ${code})`),
        // An FS code is preserved: a shell that could not START because its cwd
        // is gone is ENOENT, not "the shell died".
        onDown: (err) => this.#down(err.message, isFsErrorCode(err.code) ? err.code : 'ESHELLGONE'),
      },
    );
    this.#stream = stream;
    this.#resetReason = null;
    return stream;
  }

  #down(reason: string, code: SystemErrorCode = 'ESHELLGONE'): void {
    this.#stream = null;
    this.#resetReason = reason;
    this.#pending?.fail(new SystemError(code, `${reason} — the shell was reset`));
    this.#pending = null;
  }

  // FAILS the in-flight command, never drops it. A close that lands while a
  // command is running is the ordinary case, not the freak one — an interrupt
  // kills the forwarder mid-command, and an idle sweep can race a slow one — and
  // dropping the pending request leaves its caller awaiting a promise nothing
  // will ever settle, so the session wedges with no error anywhere to read.
  #tearDown(reason: string, failWith?: SystemError): void {
    const s = this.#stream;
    this.#stream = null;
    this.#resetReason = reason;
    this.#pending?.fail(failWith ?? new SystemError('ESHELLGONE', `${reason} — the shell was reset`));
    this.#pending = null;
    try { s?.close(); } catch { /* already gone */ }
  }

  // The reason the shell was last reset, or null. Phase 5 surfaces this to the
  // worker: a reconnected shell must SAY it lost its state rather than restore
  // cwd and look continuous.
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

  // ── Fallback mode: one framed exec per command ─────────────────────

  async #runOneShot(command: string, deadline: number, sink: ShellStreamSink, signal?: AbortSignal): Promise<ShellResult> {
    const nonce = newNonce();
    // The SAME filters the persistent path uses, over `exec`'s own streaming
    // hook — so the fallback is not a version of the feature with the live
    // output quietly missing, and it cannot filter differently from the path it
    // falls back from.
    const filters = { out: new FramedStreamFilter(nonce, 'out'), err: new FramedStreamFilter(nonce, 'err') };
    // The same last check as the persistent path's, for the same reason: nothing
    // cancelled is handed to the far side. There is no `#ensureStream` await
    // here, so the window is narrower — but stating it once per mode is what
    // keeps the two from diverging on the property that matters.
    if (signal?.aborted) throw cancelled();
    const r = await this.#host.execOneShot(
      { shell: frameCommand(nonce, command) },
      {
        cwd: this.#cwd, ...(this.#env ? { env: this.#env } : {}),
        timeoutMs: deadline, stdin: 'ignore',
        // The SAME fence, through the accounting the buffered path already owns
        // (ExecOutputCollector), so the fallback cannot bound differently from
        // the path it falls back from.
        ...(this.#maxOutputBytes === undefined ? {} : { maxBufferBytes: this.#maxOutputBytes }),
        // THE FALLBACK'S CANCELLATION. There is no live stream here to close,
        // so an abort has to reach the far side through `exec` itself — without
        // it the command runs to completion on someone else's machine, bounded
        // only by the deadline, with nobody left to read the result.
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
      // own stderr tail. Dormant today — nothing drives the persistent shell yet
      // — and fixed here so the phase that does drive it does not inherit a
      // known instance of a defect it will not be looking for.
      if (r.transportFailure) {
        throw new SystemError('ETRANSPORT', `the shell could not start: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
      }
      throw new SystemError(classifySpawnError(r.spawnError), `the shell could not start: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
    }
    const out = parseFramedStdout(r.stdout, nonce);
    const err = parseFramedStderr(r.stderr, nonce);
    if (!out || !err) {
      // Same reason as the persistent path's fail(): the command printed
      // something before it took the shell with it, and no frame survived to
      // carry it in the result.
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

// One in-flight command's accumulating streams. It owns the parse so the
// first-match-wins rule lives in exactly one place per stream.
class PendingCommand {
  readonly nonce: string;
  resolve: (r: ShellResult) => void = () => {};
  reject: (e: Error) => void = () => {};
  #out = '';
  #err = '';
  #outDone: { text: string; code: number; cwd: string } | null = null;
  #errDone: string | null = null;
  #settled = false;
  // The accumulated buffers above are what the PARSER reads, and they stay:
  // first-match-wins is a rule about the whole stream. These two answer the
  // other question — what is safe to hand a live consumer right now — from the
  // same rules, so the two can never disagree.
  readonly #filters: { out: FramedStreamFilter; err: FramedStreamFilter };
  readonly #sink: ShellStreamSink;
  // The fence, and the bytes seen against it across BOTH streams. Once it fires
  // nothing more is accumulated OR streamed: a live consumer must not see
  // output the result does not contain.
  readonly #maxBytes: number | undefined;
  readonly #onOverflow: () => void;
  #bytes = 0;
  #overflowed = false;

  constructor(nonce: string, sink: ShellStreamSink = {}, maxBytes?: number, onOverflow: () => void = () => {}) {
    this.nonce = nonce;
    this.#sink = sink;
    this.#maxBytes = maxBytes;
    this.#onOverflow = onOverflow;
    this.#filters = { out: new FramedStreamFilter(nonce, 'out'), err: new FramedStreamFilter(nonce, 'err') };
  }

  // True once the fence has fired. Everything after it is dropped, so the heap
  // this command can cost is bounded by the fence plus one chunk.
  #past(text: string): boolean {
    if (this.#maxBytes === undefined || this.#overflowed) return this.#overflowed;
    // BYTES, not UTF-16 units. `text.length` counts characters, so multibyte
    // output rode up to ~4x past the limit — and the fallback path counts bytes
    // through ExecOutputCollector, so the two modes disagreed about the one
    // number that keeps cc's heap bounded. The decoder hands whole characters
    // across chunk boundaries, so this is the exact byte count that arrived.
    this.#bytes += Buffer.byteLength(text, 'utf8');
    if (this.#bytes <= this.#maxBytes) return false;
    this.#overflowed = true;
    this.#onOverflow();
    return true;
  }

  pushOut(text: string): void {
    if (this.#settled || this.#outDone || text === '') return;
    if (this.#past(text)) return;
    this.#out += text;
    this.#emit('out', text);
    const m = parseFramedStdout(this.#out, this.nonce);
    if (!m) return;
    this.#outDone = { text: m.text, code: m.code, cwd: m.cwd };
    this.#maybeSettle();
  }

  pushErr(text: string): void {
    if (this.#settled || this.#errDone !== null || text === '') return;
    if (this.#past(text)) return;
    this.#err += text;
    this.#emit('err', text);
    const m = parseFramedStderr(this.#err, this.nonce);
    if (!m) return;
    this.#errDone = m.text;
    this.#maybeSettle();
  }

  // BEFORE the parse, so the last chunk of a command — the one carrying its
  // final bytes AND the sentinel — is still delivered live rather than only in
  // the result. The filter stops itself at the boundary.
  #emit(which: 'out' | 'err', text: string): void {
    const to = which === 'out' ? this.#sink.onOut : this.#sink.onErr;
    if (!to) return;
    const safe = this.#filters[which].push(text);
    if (safe) to(safe);
  }

  #maybeSettle(): void {
    if (this.#settled || !this.#outDone || this.#errDone === null) return;
    this.#settled = true;
    this.resolve({ stdout: this.#outDone.text, stderr: this.#errDone, code: this.#outDone.code, cwd: this.#outDone.cwd });
  }

  fail(e: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    // Release what the command printed before it died. There is no frame to
    // parse it out of, so the rejected result carries none of it — the stream
    // is the only channel it has.
    this.#flush();
    this.reject(e);
  }

  #flush(): void {
    for (const which of ['out', 'err'] as const) {
      const to = which === 'out' ? this.#sink.onOut : this.#sink.onErr;
      if (!to) continue;
      const rest = this.#filters[which].flush();
      if (rest) to(rest);
    }
  }
}
