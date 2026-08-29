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

import {
  CHUNK_BYTES, MAX_FILE_BYTES, SystemError, execFailure, isSystemErrorCode,
  type AnyFrame, type Capabilities, type ClientFrame, type SystemDescriptor,
} from './protocol.ts';
import { ExecOutputCollector } from './execCollector.ts';
import { ProviderConnection, type ConnectionOptions, type Handshake } from './providerConnection.ts';
import { ProviderShell, type ShellHost, type ShellStream, type ShellStreamHandlers } from './providerShell.ts';
import type {
  ExecOptions, ExecResult, ExecSpec, System, SystemDirent, SystemEntryKind, SystemStat, WriteFileOptions,
} from './system.ts';

// Extra time cc waits for an `exit` frame past the deadline the provider was
// given, before declaring the operation timed out itself. The provider owns the
// timeout; this only stops a WEDGED provider from turning a bounded command
// into an unbounded wait.
const EXEC_TIMEOUT_SLACK_MS = 5_000;

export interface ProviderSystemOptions extends ConnectionOptions {
  id: string;
}

export class ProviderSystem implements System, ShellHost {
  readonly id: string;
  readonly #conn: ProviderConnection;
  #shell: ProviderShell | null = null;

  constructor({ id, ...connOpts }: ProviderSystemOptions) {
    this.id = id;
    this.#conn = new ProviderConnection(connOpts);
  }

  // The negotiated contract. Null until the first operation connects.
  get handshake(): Handshake | null { return this.#conn.handshake; }

  async connect(): Promise<Handshake> { return this.#conn.ensureUp(); }

  dispose(): void {
    this.#shell?.forget();
    this.#shell = null;
    this.#conn.dispose();
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
    return this.#exec(spec, opts, opts.env ?? process.env);
  }

  async #exec(spec: ExecSpec, opts: ExecOptions, env: NodeJS.ProcessEnv | null): Promise<ExecResult> {
    const started = Date.now();
    let hs: Handshake;
    try { hs = await this.#conn.ensureUp(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new ExecOutputCollector({}, () => {}).result(1, {
        timedOut: false, spawnError: msg, durationMs: Date.now() - started,
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
        timedOut: boolean; spawnError?: string; descendantsMaySurvive?: boolean;
      }): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.#conn.close(id);
        resolve(collector.result(code, { ...extra, durationMs: Date.now() - started }));
      };

      const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
        this.#conn.send({ type: 'close', id });
        finish(124, { timedOut: true, descendantsMaySurvive: !hs.capabilities.processGroupSignal });
      }, opts.timeoutMs + EXEC_TIMEOUT_SLACK_MS);
      timer?.unref?.();

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
            // An error frame on an exec id means the command NEVER STARTED.
            finish(1, { timedOut: false, spawnError: frameMessage(f) });
          }
        },
        down: (err) => finish(1, { timedOut: false, spawnError: err.message }),
      });
      this.#conn.send(execFrame(id, spec, opts, env));
    });
  }

  // ── readFile / writeFile: the other two primitives ─────────────────

  async readFile(filePath: string): Promise<string> {
    const { data } = await this.#read(filePath, {});
    return data.toString('utf8');
  }

  async readFileBytes(filePath: string, { length }: { length?: number } = {}): Promise<Buffer> {
    const { data } = await this.#read(filePath, length === undefined ? {} : { length });
    return data;
  }

  async writeFile(filePath: string, data: string, opts: WriteFileOptions = {}): Promise<void> {
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
      type: 'writeFile', id, path: filePath,
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
    const data = await this.#request<Buffer>('r', (id) => ({
      type: 'readFile', id, path: filePath, ...(range.length === undefined ? {} : { length: range.length }),
    }), (_id, f, resolve) => {
      if (f.type === 'readFileResult') {
        meta = {
          size: typeof f.size === 'number' ? f.size : 0,
          mode: typeof f.mode === 'number' ? f.mode : 0,
          isBinary: f.isBinary === true,
        };
      } else if (f.type === 'data') {
        chunks.push(decodeData(f));
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
    onFrame: (id: string, f: AnyFrame, resolve: (v: T) => void) => void,
    afterOpen?: (id: string) => void,
  ): Promise<T> {
    await this.#conn.ensureUp();
    const id = this.#conn.nextId(prefix);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.#conn.close(id);
        fn();
      };
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
          onFrame(id, f, (v) => done(() => resolve(v)));
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
    if (r.spawnError) throw new SystemError('EUNKNOWN', `${what}: ${r.spawnError}`, { exitCode: r.code, stderr: r.stderr });
    return r;
  }

  async #deriveOk(what: string, argv: string[]): Promise<ExecResult> {
    const r = await this.#derive(what, argv);
    if (r.code !== 0) throw execFailure(what, r.code, r.stderr);
    return r;
  }

  async stat(p: string): Promise<SystemStat | null> {
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
    // The trailing `/.` is what makes a FILE report ENOTDIR rather than an
    // empty listing — `find <file> -mindepth 1` exits 0 with no output, which
    // would read as "an empty directory".
    const r = await this.#derive(`readDir '${p}'`, ['find', `${p}/.`, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%f\\n']);
    if (r.code !== 0) throw execFailure(`readDir '${p}'`, r.code, r.stderr);
    return parseFindLines(r.stdout, p);
  }

  async realpath(p: string): Promise<string> {
    // `-e` requires every component to exist, matching fs.realpath — the
    // default would happily canonicalise a path that is not there.
    const r = await this.#deriveOk(`realpath '${p}'`, ['realpath', '-e', '--', p]);
    return r.stdout.replace(/\n$/, '');
  }

  async mkdir(p: string, { recursive = false }: { recursive?: boolean } = {}): Promise<void> {
    await this.#deriveOk(`mkdir '${p}'`, recursive ? ['mkdir', '-p', '--', p] : ['mkdir', '--', p]);
  }

  async removeTree(p: string): Promise<void> {
    await this.#deriveOk(`removeTree '${p}'`, ['rm', '-rf', '--', p]);
  }

  async unlink(p: string): Promise<void> {
    // ONE directory entry, never followed and never recursed — the shape the
    // `.external/<name>` record is deleted with.
    await this.#deriveOk(`unlink '${p}'`, ['unlink', '--', p]);
  }

  async chmod(p: string, mode: number): Promise<void> {
    // Callers pass a mode read back from stat, which carries the file-type
    // bits; chmod(1) wants permission bits only.
    const octal = (mode & 0o7777).toString(8).padStart(4, '0');
    await this.#deriveOk(`chmod '${p}'`, ['chmod', octal, '--', p]);
  }

  // ── ShellHost: what ProviderShell needs and nothing more ───────────

  get capabilities(): Capabilities {
    return this.#conn.handshake?.capabilities ?? { persistentShell: false, processGroupSignal: false };
  }

  get descriptor(): SystemDescriptor | null { return this.#conn.handshake?.system ?? null; }

  execOneShot(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult> { return this.exec(spec, opts); }

  async openStream(spec: ExecSpec, opts: ExecOptions, handlers: ShellStreamHandlers): Promise<ShellStream> {
    const hs = await this.#conn.ensureUp();
    if (!hs.capabilities.persistentShell) {
      throw new SystemError('EUNSUPPORTED', `system '${this.id}' does not support a persistent shell`);
    }
    const id = this.#conn.nextId('s');
    // keepAlive:false — the shell is idle between commands and must never hold
    // the event loop open on its own; ProviderShell retains around each command.
    this.#conn.open(id, {
      frame: (f) => {
        if (f.type === 'stdout') handlers.onStdout(decodeData(f));
        else if (f.type === 'stderr') handlers.onStderr(decodeData(f));
        else if (f.type === 'exit') handlers.onExit(typeof f.code === 'number' ? f.code : 1);
        else if (f.type === 'error') handlers.onDown(new SystemError('ESHELLGONE', frameMessage(f)));
      },
      down: (err) => handlers.onDown(err),
    }, { keepAlive: false });
    this.#conn.send(execFrame(id, spec, opts, opts.env ?? process.env));
    return {
      write: (text) => this.#conn.send({ type: 'stdin', id, dataB64: Buffer.from(text, 'utf8').toString('base64') }),
      close: () => { this.#conn.send({ type: 'close', id }); this.#conn.close(id, { keepAlive: false }); },
      retain: () => this.#conn.retain(),
      release: () => this.#conn.releaseRetain(),
    };
  }

  // The long-lived shell that carries `Bash` continuity for this system. One
  // per system handle; opened lazily on the first command.
  shell(opts: { cwd: string; env?: NodeJS.ProcessEnv } & Partial<{ commandTimeoutMs: number; busyWaitMs: number }>): ProviderShell {
    if (!this.#shell) this.#shell = new ProviderShell(this, opts);
    return this.#shell;
  }
}

function execFrame(id: string, spec: ExecSpec, opts: ExecOptions, env: NodeJS.ProcessEnv | null): ClientFrame {
  return {
    type: 'exec', id, cwd: opts.cwd,
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
