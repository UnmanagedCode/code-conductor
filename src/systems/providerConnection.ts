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
  readCapabilities, type AnyFrame, type Capabilities, type ClientFrame, type SystemDescriptor,
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
  system: SystemDescriptor;
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
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_BASE_MS = 100;
const DEFAULT_RESTART_MAX_MS = 5_000;
const DEFAULT_STDERR_TAIL = 4 * 1024;

export class ProviderConnection {
  readonly #launch: ProviderLaunch;
  readonly #clock: ConnectionClock;
  readonly #handshakeTimeoutMs: number;
  readonly #restartBaseMs: number;
  readonly #restartMaxMs: number;
  readonly #stderrTailBytes: number;

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
  #nextAttemptAt = 0;
  #idSeq = 0;

  constructor(opts: ConnectionOptions) {
    this.#launch = opts.launch;
    this.#clock = opts.clock ?? REAL_CLOCK;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#restartBaseMs = opts.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
    this.#restartMaxMs = opts.restartMaxMs ?? DEFAULT_RESTART_MAX_MS;
    this.#stderrTailBytes = opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL;
  }

  // Ids are per-connection and monotonic. They are never reused, so a late
  // frame from an abandoned operation can always be recognised as late.
  nextId(prefix: string): string {
    return `${prefix}${++this.#idSeq}`;
  }

  get up(): boolean { return this.#hello !== null; }
  get handshake(): Handshake | null { return this.#hello; }

  async ensureUp(): Promise<Handshake> {
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
          const sys = (typeof f.system === 'object' && f.system !== null ? f.system : {}) as Partial<SystemDescriptor>;
          // `system.shell` is the only field cc ACTS on — it is what a
          // redirected shell is opened with. An empty or relative value is
          // accepted silently here and then explodes much later as an obscure
          // spawn failure inside a shell session, so it is refused at the
          // handshake, where the message can still name the field.
          if (typeof sys.shell !== 'string' || !sys.shell.startsWith('/')) {
            const err = new SystemError(
              'EPROTO',
              `provider hello has no absolute system.shell (got ${JSON.stringify(sys.shell)})`,
            );
            this.#teardown(child, err);
            reject(err);
            return;
          }
          resolve({
            provider: typeof f.provider === 'string' ? f.provider : 'unknown',
            capabilities: readCapabilities(f.capabilities),
            system: {
              os: sys.os ?? 'unknown',
              pathSep: sys.pathSep ?? '/',
              shell: sys.shell,
              home: sys.home ?? '/',
            },
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
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    for (const op of ops) op.down(err);
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
  dispose(): void {
    const c = this.#child;
    if (!c) return;
    this.#teardown(c, new SystemError('ETRANSPORT', 'provider connection closed'));
  }
}

type Refable = { ref?: () => void; unref?: () => void };

// Reserved op id for the handshake, which is the one exchange with no id of its
// own. It cannot collide with a generated id (those are `<prefix><number>`).
const HELLO_ID = ' hello';
