// The System provider protocol — frame vocabulary, NDJSON codec and error
// taxonomy. The WIRE contract lives in docs/systems-protocol.md; this module is
// its executable half, shared by both ends (cc's ProviderSystem and the
// reference provider), so a frame shape cannot drift between them.
//
// NDJSON — one JSON object per line, UTF-8, over the provider's stdin/stdout —
// because providers are written by other people in other languages. Binary
// payloads ride as base64 in `dataB64`.

// Bumped only for a BREAKING change. Unknown capability keys and unknown frame
// types are ignored by both ends, so the contract can GROW without a bump.
export const PROTOCOL_VERSION = 1;

// Raw bytes per data chunk BEFORE base64 (which inflates ~33%). Spec-fixed so a
// provider never has to guess what cc can hold, and so a conformance test can
// assert chunking happens at all.
export const CHUNK_BYTES = 64 * 1024;

// Per-file ceiling for readFile/writeFile. Above it the provider refuses with
// EFBIG rather than streaming a payload nobody budgeted for across a link whose
// bandwidth is not cc's to spend.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

// Bytes sniffed for a NUL to answer `isBinary`.
export const BINARY_SNIFF_BYTES = 8 * 1024;

// A single NDJSON line longer than this is EPROTO. It is a framing fence, not a
// payload budget: MAX_FILE_BYTES caps content, and one chunk frame is
// CHUNK_BYTES * 4/3 plus a small envelope, so this leaves an order of magnitude
// of headroom while still catching a provider that never emits a newline.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

// ── Error taxonomy ───────────────────────────────────────────────────
//
// Split by LAYER, which is the only split that survives contact with a shell:
// the first group are properties of the CHANNEL and are emitted as `error`
// frames; the second are cc's INTERPRETATION of an exit code plus stderr text
// from a derived command, and never appear on the wire.
export const PROTOCOL_ERROR_CODES = [
  'EPROTO',        // malformed frame, or a frame that violates the state machine
  'ETRANSPORT',    // the connection is gone (provider exited, pipe broke)
  'ETIMEDOUT',     // a bounded wait elapsed
  'EUNSUPPORTED',  // an optional capability the provider does not advertise
  'EBUSY',         // shell serialisation: the wait for the shell exceeded its bound
  'ESHELLGONE',    // the long-lived shell died or never framed the command
  'EFBIG',         // a file above MAX_FILE_BYTES
] as const;

export const FS_ERROR_CODES = [
  'ENOENT', 'EACCES', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC',
  // The catch-all. It carries the exit code and the RAW stderr verbatim and is
  // surfaced to the user: cc never guesses silently at a message it does not
  // know.
  'EUNKNOWN',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type FsErrorCode = (typeof FS_ERROR_CODES)[number];
export type SystemErrorCode = ProtocolErrorCode | FsErrorCode;

const ALL_CODES: readonly string[] = [...PROTOCOL_ERROR_CODES, ...FS_ERROR_CODES];

export function isSystemErrorCode(v: unknown): v is SystemErrorCode {
  return typeof v === 'string' && ALL_CODES.includes(v);
}

// The one error type this layer throws. `code` is what callers branch on —
// src/conventionsImport.ts reads EEXIST off it exactly as it reads it off a
// Node fs error, which is why the field is named `code` and carries the same
// strings.
export class SystemError extends Error {
  readonly code: SystemErrorCode;
  // Present on EUNKNOWN (and on any derived failure): what the command actually
  // did, so the user sees the truth rather than cc's guess.
  readonly exitCode: number | null;
  readonly stderr: string | null;

  constructor(
    code: SystemErrorCode,
    message: string,
    { exitCode = null, stderr = null }: { exitCode?: number | null; stderr?: string | null } = {},
  ) {
    super(message);
    this.name = 'SystemError';
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// stderr text → code, for a DERIVED command (§4.6) that ran and exited
// non-zero. Substring matching, deliberately: the prefix varies by tool and
// even by implementation (`stat: cannot statx 'p':`, `bfs: error: p:`) but the
// strerror() tail does not, and the derived commands run under LC_ALL=C so it
// is not localised.
const STDERR_TABLE: ReadonlyArray<readonly [string, FsErrorCode]> = [
  ['No such file or directory', 'ENOENT'],
  ['Permission denied', 'EACCES'],
  ['File exists', 'EEXIST'],
  ['Not a directory', 'ENOTDIR'],
  ['Is a directory', 'EISDIR'],
  ['No space left on device', 'ENOSPC'],
];

export function classifyStderr(stderr: string): FsErrorCode {
  for (const [needle, code] of STDERR_TABLE) {
    if (stderr.includes(needle)) return code;
  }
  return 'EUNKNOWN';
}

// Build the SystemError for a derived command that failed. An UNMATCHED
// failure keeps its exit code and its raw stderr in the message, because the
// alternative — a tidy generic message — is cc inventing a diagnosis.
export function execFailure(what: string, exitCode: number, stderr: string): SystemError {
  const code = classifyStderr(stderr);
  const detail = stderr.trim() || `exit ${exitCode}`;
  return new SystemError(code, `${what}: ${detail}`, { exitCode, stderr });
}

// ── Capabilities ─────────────────────────────────────────────────────
//
// EXACTLY TWO, both optional, both with a fallback cc implements and a test
// that runs it. A missing key is `false`; an unknown key is ignored.
export interface Capabilities {
  // exec supports a long-lived child whose stdin cc keeps writing into
  // (`stdin`/`stdinClose` frames). Absent → the redirected shell degrades to
  // one framed exec per command: cwd still carries, exports do not.
  persistentShell: boolean;
  // A `signal` frame with `processGroup:true` reaches the child's whole process
  // GROUP. Absent → the direct child only, and any result cc terminated carries
  // `descendantsMaySurvive`.
  processGroupSignal: boolean;
}

export const NO_CAPABILITIES: Capabilities = { persistentShell: false, processGroupSignal: false };

export function readCapabilities(v: unknown): Capabilities {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    persistentShell: o.persistentShell === true,
    processGroupSignal: o.processGroupSignal === true,
  };
}

// What the provider tells cc about the far side at handshake. cc uses `shell`
// to open the long-lived shell and reports the rest.
export interface SystemDescriptor {
  os: string;
  pathSep: string;
  shell: string;
  home: string;
}

// ── Frames ───────────────────────────────────────────────────────────

export interface HelloClientFrame { type: 'hello'; protocol: number; client: string }
export interface HelloProviderFrame {
  type: 'hello';
  protocol: number;
  provider: string;
  capabilities?: Record<string, unknown>;
  system?: Partial<SystemDescriptor>;
}

export interface ExecFrame {
  type: 'exec';
  id: string;
  cwd: string;
  argv?: string[];
  shell?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  killGraceMs?: number;
  stdin?: 'ignore' | 'pipe';
}
export interface StdinFrame { type: 'stdin'; id: string; dataB64: string }
export interface StdinCloseFrame { type: 'stdinClose'; id: string }
export interface SignalFrame { type: 'signal'; id: string; signal: string; processGroup: boolean }
export interface CloseFrame { type: 'close'; id: string }
export interface ReadFileFrame { type: 'readFile'; id: string; path: string; offset?: number; length?: number }
export interface WriteFileFrame {
  type: 'writeFile'; id: string; path: string;
  mode?: number; atomic?: boolean; exclusive?: boolean;
}

export interface StreamFrame { type: 'stdout' | 'stderr'; id: string; seq: number; dataB64: string }
export interface ExitFrame {
  type: 'exit'; id: string; code: number; signal: string | null; timedOut: boolean;
  descendantsMaySurvive?: boolean;
}
export interface ReadFileResultFrame {
  type: 'readFileResult'; id: string; size: number; mode: number; isBinary: boolean;
}
export interface WriteFileResultFrame { type: 'writeFileResult'; id: string; ok: true }
// Carries content for BOTH directions: provider→cc for readFile, cc→provider
// for writeFile. `end` terminates the run of data frames.
export interface DataFrame { type: 'data'; id: string; seq: number; dataB64: string }
export interface EndFrame { type: 'end'; id: string }
// `id` absent = a CONNECTION-level error: every in-flight operation fails with
// this code and the connection is torn down.
export interface ErrorFrame {
  type: 'error'; id?: string; code: SystemErrorCode; message: string;
  exitCode?: number; stderr?: string;
}

export type ClientFrame =
  | HelloClientFrame | ExecFrame | StdinFrame | StdinCloseFrame | SignalFrame | CloseFrame
  | ReadFileFrame | WriteFileFrame | DataFrame | EndFrame;

export type ProviderFrame =
  | HelloProviderFrame | StreamFrame | ExitFrame
  | ReadFileResultFrame | WriteFileResultFrame | DataFrame | EndFrame | ErrorFrame;

// Any decoded line. Both ends decode into this and narrow on `type`; a frame
// whose `type` neither end knows is still a valid frame and is IGNORED, which
// is the extension point that lets the contract grow without a version bump.
export type AnyFrame = { type: string } & Record<string, unknown>;

// ── Codec ────────────────────────────────────────────────────────────

export function encodeFrame(frame: ClientFrame | ProviderFrame | AnyFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

// Line-buffered NDJSON decoder.
//
// A malformed line is FATAL, not skipped: `push` throws SystemError('EPROTO')
// and the caller tears the connection down. A decoder that skipped would keep
// answering questions from a stream it has already proved it cannot read.
//
// Bytes are buffered rather than decoded per chunk so a multi-byte character
// split across a chunk boundary still decodes; the split point is found on the
// RAW bytes, which is safe because 0x0A cannot occur inside a UTF-8 multi-byte
// sequence.
export class NdjsonDecoder {
  #buf: Buffer = Buffer.alloc(0);
  readonly #maxLineBytes: number;

  constructor({ maxLineBytes = MAX_LINE_BYTES }: { maxLineBytes?: number } = {}) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer): AnyFrame[] {
    try { return this.#push(chunk); }
    catch (e) {
      // Any EPROTO drops the buffer. The caller tears the connection down; a
      // decoder that kept its bytes would hand the next push a frame boundary
      // it has already proved it cannot find.
      this.#buf = Buffer.alloc(0);
      throw e;
    }
  }

  #push(chunk: Buffer): AnyFrame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: AnyFrame[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length > this.#maxLineBytes) {
        throw new SystemError('EPROTO', `provider frame exceeded ${this.#maxLineBytes} bytes`);
      }
      // A blank line (or a stray \r\n) is not a frame and not an error — it is
      // whitespace between frames, which a hand-written provider will emit.
      const text = line.toString('utf8').trim();
      if (text === '') continue;
      out.push(decodeFrame(text));
    }
    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);
    if (this.#buf.length > this.#maxLineBytes) {
      throw new SystemError('EPROTO', `provider frame exceeded ${this.#maxLineBytes} bytes`);
    }
    return out;
  }

  // Bytes held back waiting for a newline. A non-zero value at end-of-stream is
  // a truncated final frame.
  get pending(): number { return this.#buf.length; }
}

export function decodeFrame(text: string): AnyFrame {
  let v: unknown;
  try { v = JSON.parse(text); }
  catch { throw new SystemError('EPROTO', `not JSON: ${clip(text)}`); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SystemError('EPROTO', `frame is not an object: ${clip(text)}`);
  }
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string' || o.type === '') {
    throw new SystemError('EPROTO', `frame has no type: ${clip(text)}`);
  }
  return o as AnyFrame;
}

function clip(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

// The `id` of a frame, or null when it carries none (a connection-level error,
// or the handshake).
export function frameId(f: AnyFrame): string | null {
  return typeof f.id === 'string' ? f.id : null;
}
