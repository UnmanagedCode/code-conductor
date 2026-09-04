// THE REFERENCE PROVIDER: the local machine, spoken over the wire protocol.
//
// It is not a transport (there is none in this project — see docs/systems-
// protocol.md). It is the machine cc already runs on, reached the long way
// round, and it exists for one reason: it makes the protocol's sufficiency
// TESTABLE. The entire cc test suite runs against it in each row of `CONFIGS`
// (`tests/systems-gate.mjs`, which owns the list), so every claim in the spec —
// the three primitives, the exec lifecycle, the derivations, the
// optional-capability fallbacks — is exercised by real callers rather than
// asserted in prose.
//
// It is also the worked example a third-party provider is written from: three
// operations, ~400 lines, no cc imports beyond the shared frame vocabulary.
//
//   node src/systems/referenceProvider.ts [--no-process-group-signal]
//                                         [--remote <id>=<absolute root>]…
//                                         [--mirror <[id=]absolute root>]…
//                                         [--exclude <[id=]absolute path>]…
//                                         [--name <label>]
//
// `--remote` turns one process into an endpoint serving MANY named targets —
// the docker-daemon shape, emulated. Given at least one, the provider
// advertises `remotes`, requires every request to name a known target, and
// scopes each target to its own root. The root scoping is what makes a
// wrong-target bug impossible to mistake for success on a machine where every
// target is in fact the same filesystem: a cross-target read is REFUSED rather
// than answered with plausible bytes.
//
// `--mirror` / `--exclude` are the MIRROR ADVERTISEMENT (§2.1), and they are
// deliberately SEPARATE FLAGS from `--remote`'s root. That root is a FENCE —
// paths outside it are refused EACCES — while an advertised mirror root is a
// claim about geometry cc consumes. Keeping them apart is what lets a test
// advertise a mirror WIDER than the fence and prove cc reads the advertisement
// rather than the fence. Given neither, `remoteDescriptors` is absent, nothing
// is injected, and the wire is byte-identical to a provider that never heard of
// the frame.
//
// Speaks NDJSON on stdin/stdout and EXITS WHEN STDIN CLOSES, which is how a
// provider is reaped when cc goes away.

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BINARY_SNIFF_BYTES, CHUNK_BYTES, MAX_FILE_BYTES, NdjsonDecoder, PROTOCOL_VERSION,
  SystemError, encodeFrame, type AnyFrame, type FsErrorCode, type ProviderFrame, type SystemErrorCode,
} from './protocol.ts';
import { FS_ERROR_CODES } from './protocol.ts';

const KILL_GRACE_MS = 100;

// The frames that OPEN an operation, and therefore the only ones that name a
// remote. Everything else inherits the binding through its `id`.
const REQUEST_FRAMES = new Set(['exec', 'readFile', 'writeFile', 'describeRemote']);

// THE ONE CWD A REMOTE'S ROOT DOES NOT FENCE, and it is cc's, not this
// emulation's: every DERIVED operation (`stat`, `realpath`, `mkdir`, `readDir`,
// `rm`, `unlink`, `chmod`) runs at `/` as a PLACEHOLDER and carries its real
// target in argv — the far side's notion of "here" is not cc's. Fencing it
// would refuse every derivation on any target not rooted at `/` while buying
// nothing, because a provider cannot fence argv.
//
// What guards the derivations instead is the `remoteId` on their frames, and
// that is asserted on the WIRE (tests/systems-remote-id.test.mjs) rather than
// inferred from an operation succeeding.
const PLACEHOLDER_CWD = '/';

// Is `p` the remote's root, or inside it? path.relative rather than a string
// prefix, which claims a merely prefix-SHARING sibling (`<root>-backup`) is
// inside. Resolved first so `<root>/../elsewhere` cannot walk out.
function withinRoot(root: string, p: string): boolean {
  const rel = path.relative(root, path.resolve(p));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

interface Options {
  processGroupSignal: boolean;
  // remote id → the absolute root that target is scoped to. EMPTY means this
  // provider serves exactly one target, does not advertise `remotes`, and
  // behaves byte-identically to one that never heard of them.
  remotes: Map<string, string>;
  // remote id (or '' for the default target) → what that target advertises.
  mirrors: Map<string, { mirrorRoot: string | null; exclude: string[] }>;
  name: string;
}

// `<id>=<path>` or a bare `<path>` for the default target. Shared by --mirror
// and --exclude so the two cannot disagree on the spelling.
function parseTargeted(flag: string, spec: string): { id: string; value: string } {
  const eq = spec.indexOf('=');
  const id = eq === -1 ? '' : spec.slice(0, eq);
  const value = eq === -1 ? spec : spec.slice(eq + 1);
  if (!path.isAbsolute(value)) throw new Error(`${flag} wants <[id=]absolute path>, got ${JSON.stringify(spec)}`);
  return { id, value };
}

export function parseProviderArgs(argv: string[]): Options {
  const o: Options = {
    processGroupSignal: true, remotes: new Map(), mirrors: new Map(),
    name: 'reference-local',
  };
  const mirrorFor = (id: string): { mirrorRoot: string | null; exclude: string[] } => {
    let m = o.mirrors.get(id);
    if (!m) { m = { mirrorRoot: null, exclude: [] }; o.mirrors.set(id, m); }
    return m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-process-group-signal') o.processGroupSignal = false;
    else if (a === '--remote') {
      const spec = argv[++i] ?? '';
      const eq = spec.indexOf('=');
      const id = eq === -1 ? '' : spec.slice(0, eq);
      const root = eq === -1 ? '' : spec.slice(eq + 1);
      if (!id || !path.isAbsolute(root)) {
        throw new Error(`--remote wants <id>=<absolute root>, got ${JSON.stringify(spec)}`);
      }
      o.remotes.set(id, path.resolve(root));
    }
    else if (a === '--mirror') {
      const { id, value } = parseTargeted('--mirror', argv[++i] ?? '');
      mirrorFor(id).mirrorRoot = value;
    }
    else if (a === '--exclude') {
      const { id, value } = parseTargeted('--exclude', argv[++i] ?? '');
      mirrorFor(id).exclude.push(value);
    }
    else if (a === '--name') o.name = argv[++i] ?? o.name;
    else throw new Error(`unknown provider option: ${a}`);
  }
  return o;
}

// A node fs error's `code`, when it is one this protocol names.
function fsCode(e: unknown): FsErrorCode {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && (FS_ERROR_CODES as readonly string[]).includes(c)
    ? c as FsErrorCode
    : 'EUNKNOWN';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ExecState {
  child: ChildProcess;
  seq: number;
  timer: NodeJS.Timeout | null;
  killGraceMs: number;
  timedOut: boolean;
  // The provider terminated this child without process-group reach, so its
  // grandchildren may still be running.
  orphaned: boolean;
  closed: boolean;
}

export class ReferenceProvider {
  readonly #opts: Options;
  readonly #write: (frame: ProviderFrame) => void;
  readonly #execs = new Map<string, ExecState>();
  readonly #writes = new Map<string, { path: string; mode?: number; atomic: boolean; exclusive: boolean; chunks: Buffer[]; bytes: number; failed: boolean }>();
  #greeted = false;
  #onFatal: (msg: string) => void;

  constructor(opts: Options, write: (frame: ProviderFrame) => void, onFatal: (msg: string) => void) {
    this.#opts = opts;
    this.#write = write;
    this.#onFatal = onFatal;
  }

  #fail(id: string | undefined, code: SystemErrorCode, message: string, extra: { exitCode?: number; stderr?: string } = {}): void {
    this.#write({ type: 'error', ...(id ? { id } : {}), code, message, ...extra });
  }

  handle(f: AnyFrame): void {
    if (!this.#greeted) {
      if (f.type !== 'hello') {
        this.#fail(undefined, 'EPROTO', `expected hello, got '${f.type}'`);
        this.#onFatal('client did not open with hello');
        return;
      }
      this.#greeted = true;
      this.#write({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        provider: `${this.#opts.name}/0.1.0`,
        capabilities: {
          processGroupSignal: this.#opts.processGroupSignal,
          remotes: this.#opts.remotes.size > 0,
          remoteDescriptors: this.#opts.mirrors.size > 0,
        },
      });
      return;
    }
    // THE ROUTING GATE, and it is on the three REQUESTS only: every follow-on
    // frame is addressed by an `id` that is already bound to a remote, so
    // re-checking one would ask a question the id has already answered.
    //
    // An absent remoteId is refused exactly as an unknown one is. A provider
    // that serves many targets has no default, and answering from one would be
    // a misroute reported as success — the failure this gate exists for. The
    // refusal is ID-ADDRESSED: an id-less error frame is connection-level and
    // would fail every OTHER target's in-flight work too.
    if (this.#opts.remotes.size > 0 && REQUEST_FRAMES.has(f.type)) {
      const named = typeof f.remoteId === 'string' ? f.remoteId : null;
      if (named === null || !this.#opts.remotes.has(named)) {
        this.#fail(String(f.id), 'ENOREMOTE', named === null
          ? `this provider serves named remotes (${[...this.#opts.remotes.keys()].join(', ')}) and the request named none`
          : `no such remote '${named}' — this provider serves ${[...this.#opts.remotes.keys()].join(', ')}`);
        return;
      }
      // THE ROOT SCOPE. A path or a cwd belonging to another target is refused,
      // never served: on a machine where every target is one filesystem that
      // refusal is the only thing standing between a mis-bound operation and a
      // plausible-looking answer.
      const root = this.#opts.remotes.get(named) as string;
      const reach = f.type === 'exec' ? f.cwd : f.path;
      if (typeof reach === 'string'
        && !(f.type === 'exec' && reach === PLACEHOLDER_CWD)
        && !withinRoot(root, reach)) {
        this.#fail(String(f.id), 'EACCES',
          `'${reach}' is not on remote '${named}' (rooted at '${root}')`);
        return;
      }
    }
    switch (f.type) {
      case 'exec': return this.#exec(f);
      case 'signal': return this.#signal(f);
      case 'close': return this.#close(f);
      case 'readFile': return void this.#readFile(f);
      case 'describeRemote': return this.#describeRemote(f);
      case 'writeFile': return this.#writeOpen(f);
      case 'data': return this.#writeData(f);
      case 'end': return void this.#writeEnd(f);
      // UNKNOWN TYPES ARE IGNORED, not an error: that is the extension point
      // that lets the contract grow without a protocol bump.
      default: return;
    }
  }

  // ── exec ───────────────────────────────────────────────────────────

  #exec(f: AnyFrame): void {
    const id = String(f.id);
    const cwd = typeof f.cwd === 'string' ? f.cwd : process.cwd();
    const [cmd, args] = typeof f.shell === 'string'
      ? ['bash', ['-lc', f.shell]]
      : [String((f.argv as string[])?.[0]), ((f.argv as string[]) ?? []).slice(1)];
    const stdinMode = f.stdin === 'ignore' ? 'ignore' as const : 'pipe' as const;
    // POSITIVE ROUTING EVIDENCE. On a machine where every target is the same
    // filesystem, "the command worked" is what a MISROUTE also looks like, so
    // the child is told which remote it is on and a test can assert on that
    // rather than on success.
    const baseEnv = (f.env as NodeJS.ProcessEnv | undefined) ?? process.env;
    const remoteId = typeof f.remoteId === 'string' ? f.remoteId : null;
    const env = remoteId === null ? baseEnv : { ...baseEnv, CC_REMOTE: remoteId };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        // detached makes the child its own process-GROUP leader, which is the
        // whole of the `processGroupSignal` capability: without it one kill
        // cannot reach a grandchild.
        detached: this.#opts.processGroupSignal,
        stdio: [stdinMode, 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn throws SYNCHRONOUSLY for an invalid argument (a NUL byte in an
      // argv entry). Either way the command never started, which is an `error`
      // frame, not an `exit`.
      this.#fail(id, fsCode(e), errMsg(e));
      return;
    }
    const state: ExecState = {
      child, seq: 0, timer: null, timedOut: false, orphaned: false, closed: false,
      killGraceMs: typeof f.killGraceMs === 'number' ? f.killGraceMs : KILL_GRACE_MS,
    };
    this.#execs.set(id, state);

    child.stdout?.on('data', (b: Buffer) => {
      if (!state.closed) this.#write({ type: 'stdout', id, seq: state.seq++, dataB64: b.toString('base64') });
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (!state.closed) this.#write({ type: 'stderr', id, seq: state.seq++, dataB64: b.toString('base64') });
    });
    child.on('error', (e) => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      this.#execs.delete(id);
      this.#fail(id, fsCode(e), e.message);
    });
    child.on('close', (code, signal) => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      this.#execs.delete(id);
      this.#write({
        type: 'exit', id,
        // 124 on timeout, matching timeout(1) — the convention cc's callers
        // already branch on.
        code: state.timedOut ? 124 : code ?? 1,
        signal: signal ?? null,
        timedOut: state.timedOut,
        ...(state.orphaned ? { descendantsMaySurvive: true } : {}),
      });
    });

    if (typeof f.timeoutMs === 'number') {
      state.timer = setTimeout(() => {
        state.timedOut = true;
        this.#terminate(state, 'SIGTERM', true);
      }, f.timeoutMs);
    }
  }

  // SIGTERM now, SIGKILL after the grace — a script that traps or ignores
  // SIGTERM would otherwise never die.
  #terminate(state: ExecState, signal: NodeJS.Signals, group: boolean): void {
    const reach = group && this.#opts.processGroupSignal;
    if (!reach) state.orphaned = true;
    const send = (sig: NodeJS.Signals): void => {
      if (state.closed) return;
      try {
        if (reach && state.child.pid) process.kill(-state.child.pid, sig);
        else state.child.kill(sig);
      } catch { /* already gone */ }
    };
    send(signal);
    if (signal === 'SIGTERM') setTimeout(() => send('SIGKILL'), state.killGraceMs).unref();
  }

  #signal(f: AnyFrame): void {
    const state = this.#execs.get(String(f.id));
    if (!state) return;
    const sig = (typeof f.signal === 'string' ? f.signal : 'SIGTERM') as NodeJS.Signals;
    this.#terminate(state, sig, f.processGroup === true);
  }

  // cc abandons the operation: kill hard and go quiet on this id.
  #close(f: AnyFrame): void {
    const id = String(f.id);
    const state = this.#execs.get(id);
    if (state) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      this.#execs.delete(id);
      this.#terminate({ ...state, closed: false }, 'SIGKILL', true);
    }
    this.#writes.delete(id);
  }

  // ── describeRemote ─────────────────────────────────────────────────

  // The mirror advertisement for ONE target. A target with nothing configured
  // answers with an empty descriptor rather than an error: "I advertise
  // nothing" is a valid answer and is what every other target on a
  // partly-configured endpoint gives.
  #describeRemote(f: AnyFrame): void {
    const key = typeof f.remoteId === 'string' ? f.remoteId : '';
    const m = this.#opts.mirrors.get(key);
    this.#write({
      type: 'remoteDescriptor', id: String(f.id),
      ...(m?.mirrorRoot ? { mirrorRoot: m.mirrorRoot } : {}),
      ...(m && m.exclude.length > 0 ? { exclude: m.exclude } : {}),
    });
  }

  // ── readFile ───────────────────────────────────────────────────────

  async #readFile(f: AnyFrame): Promise<void> {
    const id = String(f.id);
    const p = String(f.path);
    const offset = typeof f.offset === 'number' ? f.offset : 0;
    const length = typeof f.length === 'number' ? f.length : undefined;
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${p}'`), { code: 'EISDIR' });
      const want = length === undefined ? Math.max(0, st.size - offset) : length;
      if (want > MAX_FILE_BYTES) {
        this.#fail(id, 'EFBIG', `'${p}' is ${want} bytes, above the ${MAX_FILE_BYTES}-byte protocol cap`);
        return;
      }
      const fh = await fs.open(p, 'r');
      let data: Buffer;
      try {
        const buf = Buffer.alloc(want);
        const { bytesRead } = want === 0 ? { bytesRead: 0 } : await fh.read(buf, 0, want, offset);
        data = buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
      this.#write({
        type: 'readFileResult', id,
        size: st.size, mode: st.mode,
        // Sniffed on the bytes actually returned: cc's only reader asks for the
        // head of the file, which is where a NUL lives if there is one.
        isBinary: data.subarray(0, BINARY_SNIFF_BYTES).includes(0),
      });
      for (let at = 0, seq = 0; at < data.length; at += CHUNK_BYTES, seq++) {
        this.#write({ type: 'data', id, seq, dataB64: data.subarray(at, at + CHUNK_BYTES).toString('base64') });
      }
      this.#write({ type: 'end', id });
    } catch (e) {
      this.#fail(id, fsCode(e), errMsg(e));
    }
  }

  // ── writeFile ──────────────────────────────────────────────────────

  #writeOpen(f: AnyFrame): void {
    this.#writes.set(String(f.id), {
      path: String(f.path),
      ...(typeof f.mode === 'number' ? { mode: f.mode } : {}),
      atomic: f.atomic === true,
      exclusive: f.exclusive === true,
      chunks: [], bytes: 0, failed: false,
    });
  }

  #writeData(f: AnyFrame): void {
    const w = this.#writes.get(String(f.id));
    if (!w || w.failed) return;
    const b = Buffer.from(String(f.dataB64 ?? ''), 'base64');
    w.bytes += b.length;
    if (w.bytes > MAX_FILE_BYTES) {
      w.failed = true;
      w.chunks = [];
      this.#fail(String(f.id), 'EFBIG', `write to '${w.path}' exceeds the ${MAX_FILE_BYTES}-byte protocol cap`);
      return;
    }
    w.chunks.push(b);
  }

  async #writeEnd(f: AnyFrame): Promise<void> {
    const id = String(f.id);
    const w = this.#writes.get(id);
    if (!w) return;
    this.#writes.delete(id);
    if (w.failed) return;
    const data = Buffer.concat(w.chunks);
    try {
      if (w.atomic) {
        // Temp-then-rename, so a reader never sees a torn write. The temp name
        // is unique per call (pid + counter) because a shared one lets one
        // writer's rename delete another's source file.
        await fs.mkdir(path.dirname(w.path), { recursive: true });
        const tmp = `${w.path}.${process.pid}.${atomicSeq++}.tmp`;
        try {
          await fs.writeFile(tmp, data);
          if (w.mode !== undefined) await fs.chmod(tmp, w.mode & 0o7777);
          await fs.rename(tmp, w.path);
        } catch (e) {
          await fs.unlink(tmp).catch(() => {});
          throw e;
        }
      } else {
        await fs.writeFile(w.path, data, w.exclusive ? { flag: 'wx' } : {});
        if (w.mode !== undefined) await fs.chmod(w.path, w.mode & 0o7777);
      }
      this.#write({ type: 'writeFileResult', id, ok: true });
    } catch (e) {
      this.#fail(id, fsCode(e), errMsg(e));
    }
  }

  // Kill everything still running. Called when stdin closes.
  shutdown(): void {
    for (const [, state] of this.#execs) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      try {
        if (this.#opts.processGroupSignal && state.child.pid) process.kill(-state.child.pid, 'SIGKILL');
        else state.child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    this.#execs.clear();
  }
}

let atomicSeq = 0;

// ── Entry point ──────────────────────────────────────────────────────

export function runReferenceProvider(argv: string[]): void {
  const opts = parseProviderArgs(argv);
  // EPIPE on stdout means cc is gone; there is nobody left to tell.
  process.stdout.on('error', () => process.exit(0));
  const write = (frame: ProviderFrame): void => { process.stdout.write(encodeFrame(frame)); };
  const decoder = new NdjsonDecoder();
  let provider: ReferenceProvider;
  const fatal = (msg: string): void => {
    process.stderr.write(`reference-provider: ${msg}\n`);
    provider.shutdown();
    process.exit(1);
  };
  provider = new ReferenceProvider(opts, write, fatal);

  process.stdin.on('data', (chunk: Buffer) => {
    let frames: AnyFrame[];
    try { frames = decoder.push(chunk); }
    catch (e) {
      write({ type: 'error', code: e instanceof SystemError ? e.code : 'EPROTO', message: errMsg(e) });
      fatal(errMsg(e));
      return;
    }
    for (const f of frames) provider.handle(f);
  });
  // A PROVIDER EXITS WHEN ITS STDIN CLOSES. That is the whole of provider
  // lifecycle management on cc's side: cc closes the pipe (or dies), the
  // provider and everything it started go away.
  process.stdin.on('end', () => { provider.shutdown(); process.exit(0); });
  process.stdin.on('close', () => { provider.shutdown(); process.exit(0); });
}

// `import.meta.filename` is the module's own path; this runs the provider only
// when the file IS the entry point, so importing it in a test does not start it.
if (process.argv[1] === import.meta.filename) runReferenceProvider(process.argv.slice(2));
