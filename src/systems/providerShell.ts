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
//   ETIMEDOUT   — no sentinel inside the deadline (an unterminated quote leaves
//                 the shell reading input that will never come). RESETS the
//                 shell; the next command gets a fresh one.
//   ESHELLGONE  — the shell died, or the command destroyed the framing (an
//                 `exit`, a syntax error that takes the shell with it), so no
//                 sentinel can arrive. Also a reset.
//   EUNSUPPORTED— asking for a persistent shell on a provider that has none.

import { StringDecoder } from 'node:string_decoder';
import {
  FS_ERROR_CODES, SystemError, classifySpawnError,
  type Capabilities, type SystemDescriptor, type SystemErrorCode,
} from './protocol.ts';
import { frameCommand, newNonce, parseFramedStderr, parseFramedStdout } from './shellFraming.ts';
import type { ExecOptions, ExecResult, ExecSpec } from './system.ts';

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

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_BUSY_WAIT_MS = 60_000;

interface Waiter { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class ProviderShell {
  readonly #host: ShellHost;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #commandTimeoutMs: number;
  readonly #busyWaitMs: number;

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
    cwd: string; env?: NodeJS.ProcessEnv; commandTimeoutMs?: number; busyWaitMs?: number;
  }) {
    this.#host = host;
    this.#cwd = opts.cwd;
    this.#env = opts.env;
    this.#commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#busyWaitMs = opts.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS;
  }

  // The shell's real cwd, carried from the last command's sentinel.
  get cwd(): string { return this.#cwd; }

  // True while a long-lived shell process is live. False in the fallback mode
  // (there is nothing to keep alive) and after a reset.
  get open(): boolean { return this.#stream !== null; }

  // Whether this shell carries state between commands. The one user-visible
  // difference of the fallback, so it is readable rather than inferred.
  get persistent(): boolean { return this.#host.capabilities.persistentShell; }

  async run(command: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<ShellResult> {
    await this.#acquire();
    try {
      const deadline = timeoutMs ?? this.#commandTimeoutMs;
      return this.persistent
        ? await this.#runPersistent(command, deadline)
        : await this.#runOneShot(command, deadline);
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

  #acquire(): Promise<void> {
    if (!this.#busy) { this.#busy = true; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          this.#waiters = this.#waiters.filter(w => w !== waiter);
          reject(new SystemError('EBUSY', `the shell is busy — waited ${this.#busyWaitMs}ms for its turn`));
        }, this.#busyWaitMs),
      };
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  #releaseTurn(): void {
    const next = this.#waiters.shift();
    if (!next) { this.#busy = false; return; }
    clearTimeout(next.timer);
    next.resolve();
  }

  // ── Persistent mode ────────────────────────────────────────────────

  async #runPersistent(command: string, deadline: number): Promise<ShellResult> {
    const stream = await this.#ensureStream();
    const r = await this.#exchange(stream, command, deadline);
    this.#cwd = r.cwd || this.#cwd;
    return { ...r, cwd: this.#cwd };
  }

  // One framed command over an open shell.
  async #exchange(stream: ShellStream, command: string, deadline: number): Promise<ShellResult> {
    const nonce = newNonce();
    const pending = new PendingCommand(nonce);
    this.#pending = pending;
    stream.retain();
    let timer: NodeJS.Timeout | null = null;
    try {
      const settled = new Promise<ShellResult>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
        timer = setTimeout(() => {
          // A wedge — an unterminated quote leaves the shell waiting for input
          // that will never come. Reset rather than hang: a shell that cannot
          // frame a command cannot frame the next one either.
          this.#tearDown('a command exceeded its deadline');
          reject(new SystemError('ETIMEDOUT', `no shell sentinel within ${deadline}ms — the shell was reset`));
        }, deadline);
        timer.unref?.();
      });
      stream.write(frameCommand(nonce, command));
      return await settled;
    } finally {
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

  #tearDown(reason: string): void {
    const s = this.#stream;
    this.#stream = null;
    this.#resetReason = reason;
    this.#pending = null;
    try { s?.close(); } catch { /* already gone */ }
  }

  // The reason the shell was last reset, or null. Phase 5 surfaces this to the
  // worker: a reconnected shell must SAY it lost its state rather than restore
  // cwd and look continuous.
  get resetReason(): string | null { return this.#resetReason; }

  // ── Fallback mode: one framed exec per command ─────────────────────

  async #runOneShot(command: string, deadline: number): Promise<ShellResult> {
    const nonce = newNonce();
    const r = await this.#host.execOneShot(
      { shell: frameCommand(nonce, command) },
      {
        cwd: this.#cwd, ...(this.#env ? { env: this.#env } : {}),
        timeoutMs: deadline, stdin: 'ignore',
      },
    );
    if (r.timedOut) {
      throw new SystemError('ETIMEDOUT', `no shell sentinel within ${deadline}ms — the shell was reset`);
    }
    if (r.spawnError) {
      // The shell itself never started — a cwd deleted since the last command
      // is the reachable case. That is ENOENT, and saying so beats reporting it
      // as "the command ended the shell", which is not what happened.
      this.#resetReason = r.spawnError;
      throw new SystemError(classifySpawnError(r.spawnError), `the shell could not start: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
    }
    const out = parseFramedStdout(r.stdout, nonce);
    const err = parseFramedStderr(r.stderr, nonce);
    if (!out || !err) {
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

  constructor(nonce: string) { this.nonce = nonce; }

  pushOut(text: string): void {
    if (this.#settled || this.#outDone || text === '') return;
    this.#out += text;
    const m = parseFramedStdout(this.#out, this.nonce);
    if (!m) return;
    this.#outDone = { text: m.text, code: m.code, cwd: m.cwd };
    this.#maybeSettle();
  }

  pushErr(text: string): void {
    if (this.#settled || this.#errDone !== null || text === '') return;
    this.#err += text;
    const m = parseFramedStderr(this.#err, this.nonce);
    if (!m) return;
    this.#errDone = m.text;
    this.#maybeSettle();
  }

  #maybeSettle(): void {
    if (this.#settled || !this.#outDone || this.#errDone === null) return;
    this.#settled = true;
    this.resolve({ stdout: this.#outDone.text, stderr: this.#errDone, code: this.#outDone.code, cwd: this.#outDone.cwd });
  }

  fail(e: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.reject(e);
  }
}
