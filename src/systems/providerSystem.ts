// The System implementation that speaks the wire protocol to a provider
// process. It is the mirror of LocalSystem: same interface, same observable
// behaviour, reached over NDJSON instead of node:fs.
//
// THE THREE PRIMITIVES ARE ALL THE PROVIDER OWES: `exec`, `readFile`,
// `writeFile`. Everything else on `System` is DERIVED here from `exec` —
// `stat -c`, `find -printf`, `mkdir -p`, `rm -rf`, `unlink`, `realpath -e`,
// `chmod` — which is what shrinks the contract a third party has to implement
// from fifteen operations to three. The cost is that structured errors become
// text: src/systems/protocol.ts's `classifyStderr` owns that translation, and
// an unmatched failure surfaces raw rather than being guessed at.
//
// Derived commands run under `env LC_ALL=C …` rather than an `env` field on the
// frame, so they inherit the far side's PATH while still producing the
// untranslated strerror() text `classifyStderr` matches on. `env` on the frame
// REPLACES the environment, exactly as node's spawn does, because the local and
// wire implementations of one primitive cannot differ on what an option means.

import path from 'node:path';
import {
  CHUNK_BYTES, MAX_FILE_BYTES, NO_CAPABILITIES, SystemError, classifySpawnError, execFailure, isSystemErrorCode,
  type AnyFrame, type Capabilities, type ClientFrame, type SystemDescriptor, type SystemErrorCode,
} from './protocol.ts';
import { ExecOutputCollector } from './execCollector.ts';
import { NO_ADVERTISEMENT, validateAdvertisement, type MirrorAdvertisement } from './mirror.ts';
import { ProviderConnection, type ConnectionOptions, type Handshake } from './providerConnection.ts';
import { ProviderShell, type ShellHost, type ShellStream, type ShellStreamHandlers } from './providerShell.ts';
import { requireAbsolute } from './system.ts';
import type {
  ExecOptions, ExecResult, ExecSpec, System, SystemDirent, SystemEntryKind, SystemStat, WriteFileOptions,
} from './system.ts';

// Extra time cc waits for an `exit` frame past the deadline the provider was
// given, before declaring the operation timed out itself. The provider owns the
// timeout; this only stops a WEDGED provider from turning a bounded command
// into an unbounded wait.
const EXEC_TIMEOUT_SLACK_MS = 5_000;

// THE CEILING ON EVERY OPERATION THE CALLER DID NOT BOUND ITSELF.
//
// A provider that completes the handshake and then goes mute would otherwise
// wedge a caller for ever — with no ETRANSPORT, no refusal, just a promise that
// never settles. That is reachable from project listing and git status, which
// run at boot, and it is not a bound the caller can supply: `runGit` and the
// derived operations deliberately carry no timeout, because locally there is
// nothing to time out against.
//
// A liveness fence, not a performance budget: it has to sit above the slowest
// legitimate operation cc issues so it can never turn a slow answer into a
// wrong one. MEASURED (card 2026-0299 §2): the slowest unbounded operation is a
// `git worktree add` checking out a 100k-file repo, ~3.7 s; `git worktree
// remove --force` and an `rm -rf` of the same tree are ~1.2 s and ~0.9 s, and
// every other unbounded operation measured under half a second. 60 s is 16x
// the worst of them.
//
// SIZE FENCES COVER SOME OF THEM, NOT ALL — the distinction matters, because
// for the uncovered ones this ceiling is the ONLY bound. `readFile`/`writeFile`
// are capped by MAX_FILE_BYTES, `runGit` by GIT_OUTPUT_LIMIT_BYTES, and the
// session-root listing by its own fence; but `#derive` passes no
// `maxBufferBytes` (nor `cap`/`headCapBytes`), and ExecOutputCollector fences
// only when one is given (src/systems/execCollector.ts), so no §7 derivation is
// output-fenced. `readDir` is the one whose output scales with its target — a
// `find -maxdepth 1` over a directory with very many entries accumulates in
// cc's own process, and only time stops it.
//
// NOT a clone: nothing reaches `exec` by that route — cloning is cc-level and
// local, through `runGitLive`'s own CLONE_TIMEOUT_MS.
//
// ORCH_OP_TIMEOUT_MS is the knob for the case those measurements do not cover:
// a real transport's per-frame latency, a cold cache, a network filesystem, or
// a tree large enough to push a checkout or an `rm -rf` past the bound. Raise
// it there rather than editing this number.
//
// EXPORTED so a test can pin the value. `bindRemote` passes the field on as a
// constructor argument rather than exposing it, and ViewOptions is not
// exported, so nothing outside this class can read what a handle was built
// with. Injectable so a test can assert the fence without waiting for it.
export const DEFAULT_OP_TIMEOUT_MS = Number(process.env.ORCH_OP_TIMEOUT_MS) || 60_000;

export interface ProviderSystemOptions extends ConnectionOptions {
  id: string;
  // The target this handle is bound to. Omit for the provider's own default.
  remoteId?: string | null;
  // Ceiling for an operation the caller did not bound. Tests shrink it.
  defaultOpTimeoutMs?: number;
}

// What a BOUND VIEW is built from: the OWNER's live connection rather than a
// launch spec. Not exported — `bindRemote` is the only way to make one, because
// a second handle that shared a connection without being marked as a view would
// kill the provider out from under every other target on `dispose()`.
interface ViewOptions {
  id: string;
  remoteId: string;
  defaultOpTimeoutMs: number;
  conn: ProviderConnection;
}

export class ProviderSystem implements System, ShellHost {
  readonly id: string;
  readonly remoteId: string | null;
  readonly #conn: ProviderConnection;
  readonly #defaultOpTimeoutMs: number;
  // Whether this handle OWNS the connection. False for a bound view, which
  // shares the owner's — one endpoint, many targets, one process.
  readonly #owns: boolean;
  #shell: ProviderShell | null = null;
  // The handshake this view's remote was last confirmed against. Object
  // identity is the connection GENERATION: ProviderConnection replaces it on
  // every successful re-handshake, so a provider restart re-probes and nothing
  // else does.
  #probedAgainst: Handshake | null = null;
  // The same generation key for the mirror advertisement, kept separate from
  // #probedAgainst because the two probes are independent and either may run
  // without the other.
  #mirrorAgainst: Handshake | null = null;
  #mirror: MirrorAdvertisement | null = null;

  constructor(opts: ProviderSystemOptions | ViewOptions) {
    this.id = opts.id;
    this.remoteId = opts.remoteId ?? null;
    if ('conn' in opts) {
      this.#owns = false;
      this.#conn = opts.conn;
      this.#defaultOpTimeoutMs = opts.defaultOpTimeoutMs;
      return;
    }
    const { id: _id, remoteId: _remoteId, defaultOpTimeoutMs, ...connOpts } = opts;
    this.#owns = true;
    this.#defaultOpTimeoutMs = defaultOpTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    this.#conn = new ProviderConnection(connOpts);
  }

  // A handle onto ANOTHER target of the same endpoint, sharing this one's
  // connection. Multiplexing already carries it: every operation is addressed
  // by a per-connection id, and the remote is a property of the OPERATION, not
  // of the channel — so many targets need one process, not one each.
  bindRemote(remoteId: string): ProviderSystem {
    return new ProviderSystem({
      id: this.id, remoteId, defaultOpTimeoutMs: this.#defaultOpTimeoutMs, conn: this.#conn,
    });
  }

  // The negotiated contract. Null until the first operation connects.
  get handshake(): Handshake | null { return this.#conn.handshake; }

  async connect(): Promise<Handshake> { return this.#conn.ensureUp(); }

  dispose(): void {
    this.#shell?.forget();
    this.#shell = null;
    // A VIEW DOES NOT OWN THE CONNECTION: disposing one forgets its own shell
    // and leaves the process serving every other target on it. Only the owner's
    // dispose kills the provider.
    if (this.#owns) this.#conn.dispose();
  }

  // Ask the provider ONE question — do you serve this remote? — and accept only
  // one answer as no.
  //
  // ENOREMOTE is the sole failure. EACCES, ENOENT, a non-zero exit and a
  // timeout are all PASSES, because each of them is the provider answering
  // ABOUT that remote, which is itself proof it serves it. That is what lets
  // the probe be a fixed `true` at `/`: cc has no generic notion of a remote's
  // root — that is emulation detail, not protocol — so there is no path every
  // provider would accept, and `/` is chosen precisely because cc has no
  // expectation about it.
  async assertRemoteKnown(): Promise<void> {
    if (this.remoteId === null) return;
    const hs = await this.#conn.ensureUp();
    if (!hs.capabilities.remotes) {
      throw new SystemError(
        'EUNSUPPORTED',
        `system '${this.id}' is served by ${hs.provider}, which does not support named remotes`,
      );
    }
    if (this.#probedAgainst === hs) return;
    const r = await this.#exec({ argv: ['true'] }, { cwd: '/', stdin: 'ignore' }, null);
    if (r.spawnErrorCode === 'ENOREMOTE') {
      throw new SystemError('ENOREMOTE', `system '${this.id}' does not serve remote '${this.remoteId}': ${r.spawnError}`);
    }
    this.#probedAgainst = hs;
  }

  // ── The mirror advertisement ───────────────────────────────────────

  // What this target says about how much of its filesystem cc mirrors.
  //
  // MEMOISED ON THE HANDSHAKE OBJECT — the same mechanism assertRemoteKnown
  // uses, and for the same reason: object identity IS the connection
  // generation, so this costs one round trip per connection and re-asks after a
  // provider restart, when the answer really can have changed.
  //
  // DELIBERATELY NOT FOLDED INTO assertRemoteKnown, whose ENOREMOTE means the
  // same thing. Both memoise on the same key, so the cost is two round trips
  // per connection generation rather than per operation, and the two probes
  // have different absent-behaviours: one refuses, this one shrugs.
  async mirror(): Promise<MirrorAdvertisement> {
    const hs = await this.#conn.ensureUp();
    // THE GATE. A provider that never heard of this frame gets `false` from
    // readCapabilities and is never sent one — byte-identical wire traffic to
    // before the frame existed.
    if (!hs.capabilities.remoteDescriptors) return NO_ADVERTISEMENT;
    if (this.#mirrorAgainst === hs && this.#mirror !== null) return this.#mirror;
    let raw: { mirrorRoot?: unknown; exclude?: unknown };
    try {
      raw = await this.#request<{ mirrorRoot?: unknown; exclude?: unknown }>('m', (id) => ({
        type: 'describeRemote', id, ...this.#binding(),
      }), (id, f, resolve) => {
        if (f.type === 'remoteDescriptor') resolve({ mirrorRoot: f.mirrorRoot, exclude: f.exclude });
      });
    } catch (e) {
      // BELT AND BRACES: a provider that advertises the capability and then
      // refuses the frame is a provider that advertises nothing, not a failed
      // spawn. Any other failure — a dead transport, an unknown remote — is the
      // caller's to see.
      if (e instanceof SystemError && e.code === 'EUNSUPPORTED') return NO_ADVERTISEMENT;
      throw e;
    }
    const advertisement = validateAdvertisement(this.id, raw);
    this.#mirrorAgainst = hs;
    this.#mirror = advertisement;
    return advertisement;
  }

  // ── exec: the primitive ────────────────────────────────────────────
  //
  // NEVER REJECTS, matching runGroupedCommand: every failure mode — a missing
  // binary, a timeout, a dead provider — resolves to a result. Callers branch on
  // `spawnError` / `timedOut` / `code`, and one of them throwing instead would
  // be a behaviour difference between the two implementations of one primitive.
  //
  // `env` DEFAULTS TO cc's OWN process env, exactly as runGroupedCommand does,
  // and is sent explicitly on every call: a caller that mutates process.env and
  // then runs a command expects the command to see it, and inheriting whatever
  // the provider was launched with would silently answer from a snapshot taken
  // at boot.
  async exec(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult> {
    requireAbsolute('exec', 'cwd', opts.cwd);
    return this.#exec(spec, opts, opts.env ?? process.env);
  }

  async #exec(spec: ExecSpec, opts: ExecOptions, env: NodeJS.ProcessEnv | null): Promise<ExecResult> {
    const started = Date.now();
    let hs: Handshake;
    try { hs = await this.#conn.ensureUp(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // TRANSPORT: cc never reached the far side. Flagged as such rather than
      // left to be classified from `msg`, which embeds the provider's own
      // dying stderr and may name any errno at all.
      return new ExecOutputCollector({}, () => {}).result(1, {
        timedOut: false, spawnError: msg, transportFailure: true, durationMs: Date.now() - started,
      });
    }
    // THE WIRE-LEVEL BACKSTOP for row 3 of the capability matrix. The named
    // HTTP refusal is raised at resolution (src/systems/registry.ts) and is
    // what a user sees; this is what guarantees the FIELD NEVER GOES OUT even
    // if a handle is bound some other way. Reported as a command that never
    // started rather than thrown, because `exec` never rejects.
    if (this.remoteId !== null && !hs.capabilities.remotes) {
      return new ExecOutputCollector({}, () => {}).result(1, {
        timedOut: false,
        spawnError: `system '${this.id}' is served by ${hs.provider}, which does not support named remotes`,
        spawnErrorCode: 'EUNSUPPORTED',
        durationMs: Date.now() - started,
      });
    }
    const id = this.#conn.nextId('e');
    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      const collector = new ExecOutputCollector(opts, () => {
        // The max-buffer fence fired: kill the command, then wait for the exit
        // frame so the result still reports what actually happened.
        this.#conn.send({
          type: 'signal', id, signal: 'SIGTERM', processGroup: hs.capabilities.processGroupSignal,
        });
      });
      const finish = (code: number, extra: {
        timedOut: boolean; spawnError?: string; spawnErrorCode?: SystemErrorCode;
        transportFailure?: true; descendantsMaySurvive?: boolean;
      }): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.#conn.close(id);
        resolve(collector.result(code, { ...extra, durationMs: Date.now() - started }));
      };

      // Cancellation: `close` is the provider's instruction to kill the command
      // hard (docs/systems-protocol.md), which is the same lever the abandon
      // timer below pulls. The result still resolves — `exec` never rejects —
      // and the caller decides what an aborted command means.
      const onAbort = () => {
        this.#conn.send({ type: 'close', id });
        finish(130, { timedOut: false, descendantsMaySurvive: !hs.capabilities.processGroupSignal });
      };
      if (opts.signal) {
        if (opts.signal.aborted) queueMicrotask(onAbort);
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      // ARMED UNCONDITIONALLY. When the caller named a deadline the provider
      // owns it and this is only slack; when the caller named none, this is the
      // whole bound, and without it a mute provider is an unbounded wait.
      // Abandoning sends `close`, which is the provider's instruction to kill
      // the command — so cc does not need to have sent a `timeoutMs` for the
      // command to actually stop.
      const timer = setTimeout(() => {
        this.#conn.send({ type: 'close', id });
        finish(124, { timedOut: true, descendantsMaySurvive: !hs.capabilities.processGroupSignal });
      }, opts.timeoutMs === undefined ? this.#defaultOpTimeoutMs : opts.timeoutMs + EXEC_TIMEOUT_SLACK_MS);
      timer.unref?.();

      this.#conn.open(id, {
        frame: (f) => {
          if (f.type === 'stdout' || f.type === 'stderr') {
            collector.push(f.type === 'stdout' ? 'out' : 'err', decodeData(f));
          } else if (f.type === 'exit') {
            finish(typeof f.code === 'number' ? f.code : 1, {
              timedOut: f.timedOut === true,
              descendantsMaySurvive: f.descendantsMaySurvive === true,
            });
          } else if (f.type === 'error') {
            // An error frame on an exec id means the command NEVER STARTED. Its
            // CODE is kept beside the message: the far side answered, so its own
            // classification is the answer, and re-deriving one from the prose
            // loses every reason that has no errno in its wording.
            finish(1, {
              timedOut: false, spawnError: frameMessage(f),
              ...(isSystemErrorCode(f.code) ? { spawnErrorCode: f.code } : {}),
            });
          }
        },
        // TRANSPORT: the connection went away mid-command — see the ensureUp
        // path above. The `error` FRAME beside it is the other kind: the far
        // side answering about the command, which keeps FS classification.
        down: (err) => finish(1, { timedOut: false, spawnError: err.message, transportFailure: true }),
      });
      this.#conn.send(execFrame(id, this.remoteId, spec, opts, env));
    });
  }

  // ── readFile / writeFile: the other two primitives ─────────────────

  async readFile(filePath: string): Promise<string> {
    requireAbsolute('readFile', 'path', filePath);
    const { data } = await this.#read(filePath, {});
    return data.toString('utf8');
  }

  async readFileBytes(filePath: string, { length }: { length?: number } = {}): Promise<Buffer> {
    requireAbsolute('readFileBytes', 'path', filePath);
    const { data } = await this.#read(filePath, length === undefined ? {} : { length });
    return data;
  }

  async writeFile(filePath: string, data: string, opts: WriteFileOptions = {}): Promise<void> {
    requireAbsolute('writeFile', 'path', filePath);
    if (opts.atomic && opts.exclusive) {
      // Same refusal as LocalSystem: an atomic write ends in a rename, which
      // overwrites by definition, so the combination has no honest meaning.
      throw new Error('writeFile: atomic and exclusive are mutually exclusive');
    }
    const buf = Buffer.from(data, 'utf8');
    if (buf.length > MAX_FILE_BYTES) {
      throw new SystemError('EFBIG', `writeFile '${filePath}': ${buf.length} bytes exceeds the ${MAX_FILE_BYTES}-byte protocol cap`);
    }
    await this.#request<void>('w', (id) => ({
      type: 'writeFile', id, ...this.#binding(), path: filePath,
      ...(opts.mode === undefined ? {} : { mode: opts.mode & 0o7777 }),
      ...(opts.atomic ? { atomic: true } : {}),
      ...(opts.exclusive ? { exclusive: true } : {}),
    }), (id, f, resolve) => {
      if (f.type === 'writeFileResult') resolve();
    }, (id) => {
      let seq = 0;
      for (let at = 0; at < buf.length; at += CHUNK_BYTES) {
        this.#conn.send({
          type: 'data', id, seq: seq++,
          dataB64: buf.subarray(at, at + CHUNK_BYTES).toString('base64'),
        });
      }
      this.#conn.send({ type: 'end', id });
    });
  }

  async #read(filePath: string, range: { length?: number }): Promise<{ data: Buffer; stat: { size: number; mode: number; isBinary: boolean } }> {
    const chunks: Buffer[] = [];
    let meta: { size: number; mode: number; isBinary: boolean } | null = null;
    // THE FENCE ON WHAT CC KEEPS, which is a different question from the length
    // cc ASKS for. `length` is validated up front, but the accumulation below
    // happens in cc's own heap and a provider is not trusted to honour a bound
    // it was merely told — nor can it, for a file that grew since the stat. A
    // caller's own cap (the file bridge's 1 MB, say) protects the WORKER; this
    // protects the orchestrator, and every other session on it.
    const fence = Math.min(range.length ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
    let kept = 0;
    const data = await this.#request<Buffer>('r', (id) => ({
      type: 'readFile', id, ...this.#binding(), path: filePath, ...(range.length === undefined ? {} : { length: range.length }),
    }), (id, f, resolve, fail) => {
      if (f.type === 'readFileResult') {
        meta = {
          size: typeof f.size === 'number' ? f.size : 0,
          mode: typeof f.mode === 'number' ? f.mode : 0,
          isBinary: f.isBinary === true,
        };
      } else if (f.type === 'data') {
        const chunk = decodeData(f);
        kept += chunk.length;
        if (kept > fence) {
          // `close` tells the provider to stop; the refusal is what the caller
          // sees, because a clipped read reported as success is the failure this
          // whole taxonomy exists to avoid.
          this.#conn.send({ type: 'close', id });
          fail(new SystemError('EFBIG', `readFile '${filePath}': the provider sent more than ${fence} bytes`));
          return;
        }
        chunks.push(chunk);
      } else if (f.type === 'end') {
        resolve(Buffer.concat(chunks));
      }
    });
    return { data, stat: meta ?? { size: data.length, mode: 0, isBinary: false } };
  }

  // One request/response operation over the multiplexed channel. `onFrame`
  // resolves; an `error` frame rejects with its taxonomy code; a dead channel
  // rejects with ETRANSPORT.
  async #request<T>(
    prefix: string,
    open: (id: string) => ClientFrame,
    // `fail` is for an operation that must refuse on a frame the provider was
    // entitled to send — a payload past the consumer's own fence — as opposed to
    // an `error` frame, which #request answers itself. Both go through the same
    // `done()`, so the id is closed exactly once either way.
    onFrame: (id: string, f: AnyFrame, resolve: (v: T) => void, fail: (e: Error) => void) => void,
    afterOpen?: (id: string) => void,
  ): Promise<T> {
    const hs = await this.#conn.ensureUp();
    // The backstop again — see #exec. These two DO reject, so here it throws.
    if (this.remoteId !== null && !hs.capabilities.remotes) {
      throw new SystemError(
        'EUNSUPPORTED',
        `system '${this.id}' is served by ${hs.provider}, which does not support named remotes`,
      );
    }
    const id = this.#conn.nextId(prefix);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#conn.send({ type: 'close', id });
        this.#conn.close(id);
        fn();
      };
      // The same fence `exec` carries. readFile and writeFile have no
      // caller-supplied deadline anywhere in cc, so without this a provider
      // that answers nothing leaves them pending for ever.
      const timer = setTimeout(() => done(() => reject(new SystemError(
        'ETIMEDOUT',
        `the provider did not answer a '${prefix}' operation within ${this.#defaultOpTimeoutMs}ms`,
      ))), this.#defaultOpTimeoutMs);
      timer.unref?.();
      this.#conn.open(id, {
        frame: (f) => {
          if (f.type === 'error') {
            done(() => reject(new SystemError(
              isSystemErrorCode(f.code) ? f.code : 'EUNKNOWN',
              frameMessage(f),
              { exitCode: typeof f.exitCode === 'number' ? f.exitCode : null, stderr: typeof f.stderr === 'string' ? f.stderr : null },
            )));
            return;
          }
          onFrame(id, f, (v) => done(() => resolve(v)), (e) => done(() => reject(e)));
        },
        down: (err) => done(() => reject(err)),
      });
      this.#conn.send(open(id));
      afterOpen?.(id);
    });
  }

  // ── Derived from exec (§4.6) ───────────────────────────────────────

  // `env LC_ALL=C` rather than a frame `env`: the far side keeps its own PATH,
  // and the strerror() text stays untranslated for classifyStderr.
  async #derive(what: string, argv: string[], cwd = '/'): Promise<ExecResult> {
    // No `env` on the frame: a derived command is CC's OWN plumbing, not the
    // caller's, so it inherits the far side's environment (its PATH, its
    // toolchain) rather than importing cc's. Absolute paths only — the cwd is a
    // placeholder, since the far side's notion of "here" is not cc's.
    const r = await this.#exec({ argv: ['env', 'LC_ALL=C', ...argv] }, { cwd, stdin: 'ignore' }, null);
    if (r.timedOut) {
      throw new SystemError('ETIMEDOUT', `${what}: no answer within ${this.#defaultOpTimeoutMs}ms`);
    }
    if (r.spawnError) {
      // A derived command that never started names its errno in the spawn
      // message rather than in strerror() text.
      // TRANSPORT FIRST, and never classified by text. `spawnError` carries the
      // dying provider's stderr TAIL, so a provider that dies of — or merely
      // logs — an errno would be read as the far side answering about the
      // operation: `realpath` would raise ENOENT and adoptProject would assert
      // TARGET_NOT_FOUND about a tree that was there all along, `mkdir` would
      // raise EEXIST and createProject would report a path as taken on a system
      // that is dead. The flag is set on this very result by the wire paths that
      // know which of them produced the failure; only the id-addressed `error`
      // frame — the far side genuinely answering — reaches the classifier.
      if (r.transportFailure) {
        throw new SystemError('ETRANSPORT', `${what}: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
      }
      // The far side's own code when it sent one; the message parse only when it
      // did not. For every code that predates this field the two agree — the
      // provider sends fsCode(e) and the classifier reads the same errno token
      // back out of the message — so this preserves behaviour and stops a
      // STRUCTURED code being re-derived from prose.
      throw new SystemError(
        r.spawnErrorCode ?? classifySpawnError(r.spawnError),
        `${what}: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr },
      );
    }
    return r;
  }

  async #deriveOk(what: string, argv: string[]): Promise<ExecResult> {
    const r = await this.#derive(what, argv);
    if (r.code !== 0) throw execFailure(what, r.code, r.stderr);
    return r;
  }

  async stat(p: string): Promise<SystemStat | null> {
    requireAbsolute('stat', 'path', p);
    // `-L` follows symlinks, matching fs.stat: a broken link is ENOENT on both.
    // `%f` is the RAW mode including the file-type bits, so `kind` is derived
    // from the same number fs.Stats.mode carries rather than from `%F`, whose
    // words are a locale away from changing.
    const r = await this.#derive(`stat '${p}'`, ['stat', '-L', '-c', '%f %s %.3Y', '--', p]);
    if (r.code !== 0) {
      // ABSENCE IS A VALUE, NOT AN ERROR — matching resolveProjectDir's
      // ENOENT→null contract. Every other failure throws, because reading a
      // broken installation as "no such file" turns one fixable fault into a
      // fleet of misses.
      const err = execFailure(`stat '${p}'`, r.code, r.stderr);
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const m = /^([0-9a-f]+) (\d+) (\d+(?:\.\d+)?)\s*$/.exec(r.stdout);
    if (!m) throw new SystemError('EUNKNOWN', `stat '${p}': unparseable output: ${JSON.stringify(r.stdout)}`, { exitCode: 0, stderr: r.stderr });
    const mode = parseInt(m[1], 16);
    return {
      kind: kindFromMode(mode),
      size: Number(m[2]),
      mode,
      mtimeMs: Math.round(Number(m[3]) * 1000),
    };
  }

  async readDir(p: string): Promise<SystemDirent[]> {
    requireAbsolute('readDir', 'path', p);
    // The trailing `/.` is what makes a FILE report ENOTDIR rather than an
    // empty listing — `find <file> -mindepth 1` exits 0 with no output, which
    // would read as "an empty directory".
    const r = await this.#derive(`readDir '${p}'`, ['find', `${p}/.`, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%f\\n']);
    if (r.code !== 0) throw execFailure(`readDir '${p}'`, r.code, r.stderr);
    return parseFindLines(r.stdout, p);
  }

  async realpath(p: string): Promise<string> {
    requireAbsolute('realpath', 'path', p);
    // `-e` requires every component to exist, matching fs.realpath — the
    // default would happily canonicalise a path that is not there.
    const r = await this.#deriveOk(`realpath '${p}'`, ['realpath', '-e', '--', p]);
    return r.stdout.replace(/\n$/, '');
  }

  async mkdir(p: string, { recursive = false }: { recursive?: boolean } = {}): Promise<void> {
    requireAbsolute('mkdir', 'path', p);
    await this.#deriveOk(`mkdir '${p}'`, recursive ? ['mkdir', '-p', '--', p] : ['mkdir', '--', p]);
  }

  async removeTree(p: string): Promise<void> {
    requireAbsolute('removeTree', 'path', p);
    await this.#deriveOk(`removeTree '${p}'`, ['rm', '-rf', '--', p]);
  }

  async unlink(p: string): Promise<void> {
    requireAbsolute('unlink', 'path', p);
    // ONE directory entry, never followed and never recursed — the shape the
    // `.external/<name>` record is deleted with.
    await this.#deriveOk(`unlink '${p}'`, ['unlink', '--', p]);
  }

  async chmod(p: string, mode: number): Promise<void> {
    requireAbsolute('chmod', 'path', p);
    // Callers pass a mode read back from stat, which carries the file-type
    // bits; chmod(1) wants permission bits only.
    const octal = (mode & 0o7777).toString(8).padStart(4, '0');
    await this.#deriveOk(`chmod '${p}'`, ['chmod', octal, '--', p]);
  }

  // The `remoteId` field for a request frame, or nothing when this handle is
  // bound to the provider's default target. Spread rather than set so an
  // unbound handle's frames stay byte-identical to what cc sent before remotes
  // existed.
  #binding(): { remoteId?: string } {
    return this.remoteId === null ? {} : { remoteId: this.remoteId };
  }

  // ── ShellHost: what ProviderShell needs and nothing more ───────────

  get capabilities(): Capabilities {
    return this.#conn.handshake?.capabilities ?? NO_CAPABILITIES;
  }

  get descriptor(): SystemDescriptor | null { return this.#conn.handshake?.system ?? null; }

  execOneShot(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult> { return this.exec(spec, opts); }

  async openStream(spec: ExecSpec, opts: ExecOptions, handlers: ShellStreamHandlers): Promise<ShellStream> {
    // The SECOND way a cwd reaches an `exec` frame. The one-shot fallback goes
    // through `exec` and is guarded there; this is the persistent-shell path,
    // and it is the one a redirected Bash session drives every command through.
    requireAbsolute('openStream', 'cwd', opts.cwd);
    const hs = await this.#conn.ensureUp();
    if (!hs.capabilities.persistentShell) {
      throw new SystemError('EUNSUPPORTED', `system '${this.id}' does not support a persistent shell`);
    }
    if (this.remoteId !== null && !hs.capabilities.remotes) {
      throw new SystemError(
        'EUNSUPPORTED',
        `system '${this.id}' is served by ${hs.provider}, which does not support named remotes`,
      );
    }
    const id = this.#conn.nextId('s');
    // keepAlive:false — the shell is idle between commands and must never hold
    // the event loop open on its own; ProviderShell retains around each command.
    this.#conn.open(id, {
      frame: (f) => {
        if (f.type === 'stdout') handlers.onStdout(decodeData(f));
        else if (f.type === 'stderr') handlers.onStderr(decodeData(f));
        else if (f.type === 'exit') handlers.onExit(typeof f.code === 'number' ? f.code : 1);
        // The provider's own code is preserved so the shell can tell "could
        // not start" (ENOENT on a vanished cwd) from "died".
        else if (f.type === 'error') handlers.onDown(new SystemError(isSystemErrorCode(f.code) ? f.code : 'ESHELLGONE', frameMessage(f)));
      },
      down: (err) => handlers.onDown(err),
    }, { keepAlive: false });
    this.#conn.send(execFrame(id, this.remoteId, spec, opts, opts.env ?? process.env));
    return {
      write: (text) => this.#conn.send({ type: 'stdin', id, dataB64: Buffer.from(text, 'utf8').toString('base64') }),
      close: () => { this.#conn.send({ type: 'close', id }); this.#conn.close(id, { keepAlive: false }); },
      retain: () => this.#conn.retain(),
      release: () => this.#conn.releaseRetain(),
    };
  }

  // The long-lived shell that carries `Bash` continuity for this system. One
  // per system handle; opened lazily on the first command.
  shell(opts: { cwd: string; env?: NodeJS.ProcessEnv } & Partial<{ commandTimeoutMs: number; maxOutputBytes: number }>): ProviderShell {
    if (!this.#shell) this.#shell = new ProviderShell(this, opts);
    return this.#shell;
  }
}

function execFrame(
  id: string, remoteId: string | null, spec: ExecSpec, opts: ExecOptions, env: NodeJS.ProcessEnv | null,
): ClientFrame {
  return {
    type: 'exec', id, ...(remoteId === null ? {} : { remoteId }), cwd: opts.cwd,
    ...('shell' in spec ? { shell: spec.shell } : { argv: spec.argv }),
    ...(env ? { env: stringEnv(env) } : {}),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.killGraceMs === undefined ? {} : { killGraceMs: opts.killGraceMs }),
    ...(opts.stdin === 'ignore' ? { stdin: 'ignore' as const } : {}),
  };
}

// process.env carries `string | undefined`; the wire carries strings. An unset
// var is ABSENT, which is what spawn does with it too.
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function decodeData(f: AnyFrame): Buffer {
  return Buffer.from(typeof f.dataB64 === 'string' ? f.dataB64 : '', 'base64');
}

function frameMessage(f: AnyFrame): string {
  return typeof f.message === 'string' ? f.message : `provider error (${String(f.code)})`;
}

// POSIX file-type bits, the same ones fs.Stats.mode carries.
export function kindFromMode(mode: number): SystemEntryKind {
  switch (mode & 0o170000) {
    case 0o040000: return 'dir';
    case 0o100000: return 'file';
    case 0o120000: return 'symlink';
    default: return 'other';
  }
}

const FIND_TYPES: Record<string, SystemEntryKind> = { f: 'file', d: 'dir', l: 'symlink' };

// `find -printf '%y\t%f\n'` output. A filename containing a newline produces a
// line with no tab, and that is an ERROR, never a silent skip: a listing that
// quietly drops an entry is indistinguishable from one that does not have it.
export function parseFindLines(stdout: string, dir: string): SystemDirent[] {
  const out: SystemDirent[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab !== 1) {
      throw new SystemError('EUNKNOWN', `readDir '${dir}': unparseable entry ${JSON.stringify(line)} — a filename containing a newline cannot be listed`);
    }
    out.push({ name: line.slice(2), kind: FIND_TYPES[line[0]] ?? 'other' });
  }
  return out;
}
