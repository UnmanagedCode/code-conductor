// The supervised connection to a provider process: spawn, handshake,
// multiplexing, teardown, restart.
//
// One responsibility — keeping a usable NDJSON channel to a provider, or saying
// honestly that there isn't one. It knows nothing about what the frames MEAN;
// src/systems/providerSystem.ts owns that.
//
// SUPERVISION IS RESTART-WITH-BACKOFF PLUS FAIL-FAST REFUSAL. When the provider
// dies, every in-flight operation is rejected with ETRANSPORT immediately —
// never left hanging on a channel that will not answer — and the next operation
// reconnects. While a backoff window is open the operation is REFUSED rather
// than queued, because a caller holding a request open across a restart storm
// is a worse failure than a caller told "unreachable" now.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  NdjsonDecoder, PROTOCOL_VERSION, SystemError, encodeFrame, isSystemErrorCode,
  readCapabilities, type AnyFrame, type Capabilities, type ClientFrame,
} from './protocol.ts';

export interface ProviderLaunch {
  // argv[0] is the executable. cc never runs the launch through a shell: a
  // provider command is configuration, and a shell in the middle would make
  // quoting part of the contract.
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Handshake {
  provider: string;
  capabilities: Capabilities;
}

export interface OpHandlers {
  frame(f: AnyFrame): void;
  // Called once when the channel dies under an open operation.
  down(err: SystemError): void;
}

// Injected in tests so a restart-storm assertion costs no wall clock. Only
// `now` — the backoff is a REFUSAL WINDOW, not a sleep, so there is nothing to
// fake out.
export interface ConnectionClock { now(): number }

const REAL_CLOCK: ConnectionClock = { now: () => Date.now() };

export interface ConnectionOptions {
  launch: ProviderLaunch;
  clock?: ConnectionClock;
  handshakeTimeoutMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
  // Provider stderr is DIAGNOSTICS, never parsed. This much of its tail is kept
  // so an ETRANSPORT can quote why the provider died instead of just that it
  // did.
  stderrTailBytes?: number;
  // How long a provider gets to honour the EOF it was just sent before cc
  // SIGKILLs it. See #reap.
  shutdownGraceMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_BASE_MS = 100;
const DEFAULT_RESTART_MAX_MS = 5_000;
const DEFAULT_STDERR_TAIL = 4 * 1024;
// Chosen from the BROKEN case, not the healthy one (card 2026-0268 §B.2). Too
// short and a healthy-but-stalled provider is killed before it can shut down,
// and the orphan bug returns silently; too long and a provider already in breach
// of the protocol delays only its own reaping. The healthy exit measured ~15ms
// (worst 22ms under load), so this absorbs a two-order-of-magnitude stall, and
// it stays under DEFAULT_HANDSHAKE_TIMEOUT_MS so a misbehaving provider's whole
// lifecycle is bounded by limits this file already sets.
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export class ProviderConnection {
  readonly #launch: ProviderLaunch;
  readonly #clock: ConnectionClock;
  readonly #handshakeTimeoutMs: number;
  readonly #restartBaseMs: number;
  readonly #restartMaxMs: number;
  readonly #stderrTailBytes: number;
  readonly #shutdownGraceMs: number;

  #child: ChildProcess | null = null;
  #decoder = new NdjsonDecoder();
  #hello: Handshake | null = null;
  // Set SYNCHRONOUSLY when the hello frame is read, not when #connect resumes
  // after its await: the two MUST checks in #onData run inside the same
  // synchronous pass over a chunk that may also carry the hello.
  #greeted = false;
  #connecting: Promise<Handshake> | null = null;
  #ops = new Map<string, OpHandlers>();
  #keepAlive = 0;
  #stderrTail = '';
  // Why the channel last went down, so a connect racing the teardown reports
  // the real cause rather than a generic one.
  #lastTeardown: SystemError | null = null;
  #failures = 0;
  // TERMINAL, and the reason it exists: `disposeSystemHandle`
  // (src/systems/registry.ts) drops the registry's entry, but a live worker
  // session RETAINS the handle it was created with (SessionRedirect's
  // `#system`, src/systems/toolRedirect.ts) and that retention is out of the
  // registry's reach. Without this flag `#teardown` leaves a deliberately-closed
  // connection indistinguishable from one whose provider merely died —
  // `#failures` was reset by the last successful connect, so there is no backoff
  // window either — and the next `ensureUp()` SILENTLY RESPAWNS THE OLD ARGV,
  // running a session's commands on the pre-swap machine and reporting exit 0
  // (card 2026-0347).
  //
  // SET IN `dispose()`, NEVER IN `#teardown`: a crash must still reconnect,
  // which is this class's whole supervision contract. Only cc closing the
  // channel is terminal.
  #disposed = false;
  #nextAttemptAt = 0;
  #idSeq = 0;

  constructor(opts: ConnectionOptions) {
    this.#launch = opts.launch;
    this.#clock = opts.clock ?? REAL_CLOCK;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#restartBaseMs = opts.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
    this.#restartMaxMs = opts.restartMaxMs ?? DEFAULT_RESTART_MAX_MS;
    this.#stderrTailBytes = opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL;
    this.#shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  }

  // Ids are per-connection and monotonic. They are never reused, so a late
  // frame from an abandoned operation can always be recognised as late.
  nextId(prefix: string): string {
    return `${prefix}${++this.#idSeq}`;
  }

  get up(): boolean { return this.#hello !== null; }
  get handshake(): Handshake | null { return this.#hello; }

  async ensureUp(): Promise<Handshake> {
    if (this.#disposed) {
      throw new SystemError(
        'ETRANSPORT',
        `provider '${this.#launch.argv[0]}' was disposed when its system's registration changed — `
        + `this handle is dead and is never reconnected. Start a NEW session on the project: `
        + `respawn, rewind and prune all relaunch through this same session's retained handle `
        + `and fail identically`,
      );
    }
    if (this.#hello) return this.#hello;
    if (this.#connecting) return this.#connecting;
    const now = this.#clock.now();
    if (this.#failures > 0 && now < this.#nextAttemptAt) {
      throw new SystemError(
        'ETRANSPORT',
        `provider '${this.#launch.argv[0]}' is unreachable — `
        + `${this.#failures} failed attempt(s), next retry in ${this.#nextAttemptAt - now}ms`
        + (this.#stderrTail ? `; last stderr: ${this.#stderrTail.trim()}` : ''),
      );
    }
    this.#connecting = this.#connect();
    try {
      const hello = await this.#connecting;
      this.#failures = 0;
      return hello;
    } catch (e) {
      this.#failures += 1;
      const backoff = Math.min(this.#restartMaxMs, this.#restartBaseMs * 2 ** (this.#failures - 1));
      this.#nextAttemptAt = this.#clock.now() + backoff;
      throw e;
    } finally {
      this.#connecting = null;
    }
  }

  async #connect(): Promise<Handshake> {
    this.#decoder = new NdjsonDecoder();
    this.#greeted = false;
    this.#lastTeardown = null;
    this.#stderrTail = '';
    let child: ChildProcess;
    try {
      child = spawn(this.#launch.argv[0], this.#launch.argv.slice(1), {
        cwd: this.#launch.cwd,
        env: this.#launch.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new SystemError('ETRANSPORT', `cannot launch provider: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.#child = child;
    // Unref'd by default so an idle connection can never hold the event loop
    // open; retained (ref'd) only while an operation is actually in flight.
    this.#ref(false);
    if (this.#keepAlive > 0) this.#ref(true);

    child.stdout?.on('data', (chunk: Buffer) => this.#onData(child, chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-this.#stderrTailBytes);
    });
    // A dead pipe is the same event as a dead provider; the exit handler below
    // is the single teardown path, so this only has to not crash the process.
    child.stdin?.on('error', () => {});
    child.on('error', (e) => this.#teardown(child, new SystemError('ETRANSPORT', `provider failed: ${e.message}`)));
    child.on('exit', (code, signal) => this.#teardown(child, new SystemError(
      'ETRANSPORT',
      `provider exited (${signal ? `signal ${signal}` : `code ${code}`})`
      + (this.#stderrTail ? `: ${this.#stderrTail.trim()}` : ''),
    )));

    const hello = await this.#shakeHands(child);
    // The handshake resolving and this line are separated by a microtask, and a
    // provider can die — or violate a MUST — inside it: a second hello, or an
    // immediate exit, arriving in the SAME chunk as the hello tears the channel
    // down before it is ever recorded. Recording it anyway would mark the
    // connection up with no child behind it, and every later operation would be
    // sent into a closed pipe and wait out its deadline.
    if (this.#child !== child) {
      throw this.#lastTeardown ?? new SystemError('ETRANSPORT', 'the provider went away during the handshake');
    }
    this.#hello = hello;
    return hello;
  }

  #shakeHands(child: ChildProcess): Promise<Handshake> {
    return new Promise<Handshake>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#ops.delete(HELLO_ID);
        this.#release();
        fn();
      };
      const timer = setTimeout(() => done(() => {
        this.#teardown(child, new SystemError('ETIMEDOUT', 'provider did not answer the handshake'));
        reject(new SystemError('ETIMEDOUT', `provider did not answer the handshake within ${this.#handshakeTimeoutMs}ms`));
      }), this.#handshakeTimeoutMs);
      timer.unref?.();
      // The handshake reply carries no id, so it is registered under a reserved
      // one that #onData routes id-less non-error frames to.
      this.#retain();
      this.#ops.set(HELLO_ID, {
        frame: (f) => done(() => {
          this.#greeted = f.type === 'hello';
          if (f.type !== 'hello') {
            const err = new SystemError('EPROTO', `expected a hello frame, got '${f.type}'`);
            this.#teardown(child, err);
            reject(err);
            return;
          }
          if (f.protocol !== PROTOCOL_VERSION) {
            const err = new SystemError(
              'EPROTO',
              `provider speaks protocol ${String(f.protocol)}, cc speaks ${PROTOCOL_VERSION}`,
            );
            this.#teardown(child, err);
            reject(err);
            return;
          }
          resolve({
            provider: typeof f.provider === 'string' ? f.provider : 'unknown',
            capabilities: readCapabilities(f.capabilities),
          });
        }),
        down: (err) => done(() => reject(err)),
      });
      this.send({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'code-conductor' });
    });
  }

  #onData(child: ChildProcess, chunk: Buffer): void {
    if (this.#child !== child) return;
    let frames: AnyFrame[];
    try { frames = this.#decoder.push(chunk); }
    catch (e) {
      // A malformed line is FATAL: the stream has proved it cannot be framed,
      // so nothing later on it can be trusted either.
      this.#teardown(child, e instanceof SystemError ? e : new SystemError('EPROTO', String(e)));
      return;
    }
    for (const f of frames) {
      if (this.#child !== child) return;
      const id = typeof f.id === 'string' ? f.id : null;
      // MUST: a provider answers cc's hello BEFORE any other frame, and answers
      // it exactly once. Both halves are enforced rather than assumed — an
      // unenforced MUST is a line in a document, and a provider that streams
      // output for an id cc has not opened is not one cc can reason about.
      if (!this.#greeted && id !== null) {
        this.#teardown(child, new SystemError('EPROTO', `provider sent a '${f.type}' frame for id '${id}' before its hello`));
        return;
      }
      if (this.#greeted && f.type === 'hello') {
        this.#teardown(child, new SystemError('EPROTO', 'provider sent a second hello'));
        return;
      }
      if (id === null) {
        if (f.type === 'error') {
          // An id-less error is CONNECTION-level: it fails everything.
          const code = isSystemErrorCode(f.code) ? f.code : 'EPROTO';
          const msg = typeof f.message === 'string' ? f.message : 'provider reported a connection error';
          this.#teardown(child, new SystemError(code, `provider: ${msg}`));
          return;
        }
        this.#ops.get(HELLO_ID)?.frame(f);
        continue;
      }
      // A frame for an id cc has already closed is DROPPED, not an error: cc's
      // `close` and the provider's last frames cross on the wire by design.
      this.#ops.get(id)?.frame(f);
    }
  }

  #teardown(child: ChildProcess, err: SystemError): void {
    if (this.#child !== child) return;
    this.#lastTeardown = err;
    this.#child = null;
    this.#hello = null;
    this.#greeted = false;
    const ops = [...this.#ops.values()];
    this.#ops.clear();
    this.#keepAlive = 0;
    this.#reap(child);
    for (const op of ops) op.down(err);
  }

  // How a provider is REAPED, and it is the protocol's own answer: stdin EOF,
  // with SIGKILL only as the fallback for a provider that ignores it.
  //
  // SIGKILL alone is not enough and never was (card 2026-0268 §A). A SIGKILLed
  // provider runs no shutdown code, so a login shell that is BUSY — not reading
  // its stdin, because a foreground command holds it — never sees the pipe close
  // and survives with its command. An IDLE shell is reaped either way, which is
  // why only a live operation at teardown ever leaked.
  #reap(child: ChildProcess): void {
    // Nothing to reap: the spawn itself failed (no pid), or the child is the
    // thing that told us it was gone. Arming a deadline here would hold the
    // event loop open on the one path where there is no process at all.
    if (child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Safe into a corpse: writing to a broken pipe surfaces as an ASYNCHRONOUS
    // 'error' on the stream, which the stdin handler installed in #connect
    // absorbs — measured, not assumed.
    try { child.stdin?.end(); } catch { /* the pipe is already gone */ }
    const kill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, this.#shutdownGraceMs);
    child.once('exit', () => clearTimeout(kill));
  }

  // Open a multiplexed operation. `keepAlive:false` is for a LONG-LIVED
  // operation that is idle most of the time (the shell): it must not hold the
  // event loop open between commands, so its owner retains the connection
  // around each command instead.
  open(id: string, handlers: OpHandlers, { keepAlive = true }: { keepAlive?: boolean } = {}): void {
    this.#ops.set(id, handlers);
    if (keepAlive) this.#retain();
  }

  close(id: string, { keepAlive = true }: { keepAlive?: boolean } = {}): void {
    if (!this.#ops.delete(id)) return;
    if (keepAlive) this.#release();
  }

  retain(): void { this.#retain(); }
  releaseRetain(): void { this.#release(); }

  #retain(): void {
    this.#keepAlive += 1;
    if (this.#keepAlive === 1) this.#ref(true);
  }

  #release(): void {
    if (this.#keepAlive === 0) return;
    this.#keepAlive -= 1;
    if (this.#keepAlive === 0) this.#ref(false);
  }

  // The child's stdio are pipes (net.Socket), which carry ref/unref even though
  // the ChildProcess type only promises Readable/Writable.
  #ref(on: boolean): void {
    const c = this.#child;
    if (!c) return;
    for (const s of [c.stdout, c.stderr, c.stdin, c] as unknown as Refable[]) {
      if (on) s?.ref?.(); else s?.unref?.();
    }
  }

  // Writes one frame. Silently drops when the channel is down: the operation
  // that cares has already been rejected through `down`, and a second error
  // from the write would be noise on a path that is already failing.
  send(frame: ClientFrame): void {
    const c = this.#child;
    if (!c?.stdin?.writable) return;
    c.stdin.write(encodeFrame(frame));
  }

  // Shut the provider down deliberately. In-flight operations are failed with
  // ETRANSPORT, same as a crash — the caller asked for the channel to go away.
  // TERMINAL, unlike a crash: this connection is never reconnected afterwards.
  dispose(): void {
    // SET FIRST AND UNCONDITIONALLY. A connection that is currently DOWN has no
    // `#child` to tear down, and returning before the flag would leave exactly
    // the handle this guard exists for: one that respawns on next use.
    this.#disposed = true;
    const c = this.#child;
    if (!c) return;
    this.#teardown(c, new SystemError('ETRANSPORT', 'provider connection closed'));
  }
}

type Refable = { ref?: () => void; unref?: () => void };

// Reserved op id for the handshake, which is the one exchange with no id of its
// own. It cannot collide with a generated id (those are `<prefix><number>`).
const HELLO_ID = ' hello';
