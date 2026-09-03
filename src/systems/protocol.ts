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

// The most `exclude` entries cc will accept in one mirror advertisement
// (docs/systems-protocol.md §2.1). A FENCE WITH HEADROOM, not a performance
// budget: containment is one `path.posix.relative` per entry per file op,
// measured at 0.34 microseconds, so even a full list is ~22 microseconds
// against a cross-machine round trip. Spec-fixed so a provider knows the bound
// rather than discovering it as a refusal.
export const MIRROR_EXCLUDE_MAX = 64;

// The longest path cc will accept in a mirror advertisement. A fence on what cc
// will HOLD AND REPEAT — the root is carried into the session-root manifest,
// into every path the map composes, and verbatim into refusal prose a model
// reads — not a claim about any filesystem's PATH_MAX, which it sits far above.
export const MIRROR_PATH_MAX = 4096;

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
  // providerShell.ts: one shell serialises its commands and a wait past its
  // bound is refused rather than queued forever. It never reaches a worker as a
  // protocol error frame — it surfaces as a non-zero exit with the reason on
  // stderr.
  'EBUSY',
  'ESHELLGONE',    // the shell died or never framed the command
  'EFBIG',         // a file above MAX_FILE_BYTES, or output above a caller's fence
  'ECANCELLED',    // the caller went away: an interrupt, or a tool timeout
  'ENOREMOTE',     // the named remote is not one this provider serves
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

// A spawn failure's message ('spawn /bin/sh ENOENT') carries its errno as a
// TOKEN rather than as strerror() text, so it needs its own reader. Used where
// a command that never started has to be reported as a named failure rather
// than as an opaque one.
export function classifySpawnError(message: string): FsErrorCode {
  for (const code of FS_ERROR_CODES) {
    if (code !== 'EUNKNOWN' && new RegExp(`\\b${code}\\b`).test(message)) return code;
  }
  return 'EUNKNOWN';
}

// ── Capabilities ─────────────────────────────────────────────────────
//
// Every one of them optional, and every one carrying a fallback cc implements
// plus a test that runs it. A missing key is `false`; an unknown key is
// ignored, which is the extension point that lets this list grow without a
// protocol bump.
export interface Capabilities {
  // A `signal` frame with `processGroup:true` reaches the child's whole process
  // GROUP. Absent → the direct child only, and any result cc terminated carries
  // `descendantsMaySurvive`.
  processGroupSignal: boolean;
  // This endpoint serves MANY named targets, selected per request by `remoteId`.
  // Absent → it serves exactly one, and a project naming a remote on it is
  // refused SYSTEM_NO_REMOTES with the field never sent.
  //
  // A CAPABILITY RATHER THAN AN OPTIMISTICALLY-SENT FIELD, and this is the one
  // place the difference is safety-critical: unknown keys are ignored by
  // contract, so a provider that predates this would take a `remoteId` and
  // answer from its own default target — a misroute reported as success, which
  // is the worst failure available here.
  remotes: boolean;
  // The provider answers `describeRemote` with the MIRROR ADVERTISEMENT for a
  // target — how much of its filesystem cc's session root is the local image
  // of, and which prefixes cc must not carry (§2.1). Absent → cc never sends
  // the frame, the session root is the project root's image exactly as before,
  // and no path is excluded.
  //
  // On the handshake rather than in it because the descriptor there describes
  // ONE target and a `remotes` provider has many, whose layouts differ.
  remoteDescriptors: boolean;
}

export const NO_CAPABILITIES: Capabilities = {
  processGroupSignal: false, remotes: false, remoteDescriptors: false,
};

export function readCapabilities(v: unknown): Capabilities {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    processGroupSignal: o.processGroupSignal === true,
    remotes: o.remotes === true,
    remoteDescriptors: o.remoteDescriptors === true,
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
  // REQUIRED, and `shell` within it must be an absolute path: it is the only
  // descriptor field cc acts on, and a hello without it is refused EPROTO at
  // the handshake. The rest of the descriptor is advisory and defaulted.
  system: { shell: string } & Partial<SystemDescriptor>;
}

// ── The four REQUEST frames, and the one field they share ────────────
//
// `remoteId` names which of the provider's targets the operation is for. It is
// carried by the four REQUESTS only (`exec`, `readFile`, `writeFile`,
// `describeRemote`): every follow-on frame (`signal`, `close`, `data`, `end`)
// is addressed by `id`, and AN ID IS BOUND TO ONE REMOTE FOR ITS WHOLE LIFETIME. The FIELD goes out only to
// a provider that advertises `remotes`; `describeRemote` — the fourth — is
// itself sent only to one that advertises `remoteDescriptors`.
export interface ExecFrame {
  type: 'exec';
  id: string;
  remoteId?: string;
  cwd: string;
  argv?: string[];
  shell?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  killGraceMs?: number;
  stdin?: 'ignore' | 'pipe';
}
export interface SignalFrame { type: 'signal'; id: string; signal: string; processGroup: boolean }
export interface CloseFrame { type: 'close'; id: string }
export interface ReadFileFrame {
  type: 'readFile'; id: string; remoteId?: string; path: string; offset?: number; length?: number;
}
export interface WriteFileFrame {
  type: 'writeFile'; id: string; remoteId?: string; path: string;
  mode?: number; atomic?: boolean; exclusive?: boolean;
}

// The FOURTH request frame carrying `remoteId`, and the only one with no
// follow-on frames: it opens and closes in one exchange, so §4's
// an-id-is-bound-to-one-remote rule has nothing to bind.
export interface DescribeRemoteFrame { type: 'describeRemote'; id: string; remoteId?: string }
// Both fields OPTIONAL. A descriptor with neither is a valid "I advertise
// nothing" and takes the same path as a provider that never heard of the frame.
export interface RemoteDescriptorFrame {
  type: 'remoteDescriptor'; id: string; mirrorRoot?: string | null; exclude?: string[];
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
  | HelloClientFrame | ExecFrame | SignalFrame | CloseFrame
  | ReadFileFrame | WriteFileFrame | DescribeRemoteFrame | DataFrame | EndFrame;

export type ProviderFrame =
  | HelloProviderFrame | StreamFrame | ExitFrame
  | ReadFileResultFrame | WriteFileResultFrame | RemoteDescriptorFrame
  | DataFrame | EndFrame | ErrorFrame;

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
  // A PAYLOAD IS PART OF THE FRAME, so a bad payload is a bad frame.
  //
  // `Buffer.from(s, 'base64')` is lenient: it stops at the first character it
  // cannot read and returns what it got. Decoding without this check turns a
  // corrupted chunk into a SILENT PARTIAL ANSWER — a writeFile that reports
  // success having dropped its tail, or a command whose stdout is quietly
  // truncated with exit 0. That is the wrong-answer-over-named-refusal the
  // taxonomy exists to prevent, so it is checked here, once, for both ends and
  // both directions.
  if (PAYLOAD_FRAMES.has(o.type)) {
    if (typeof o.dataB64 !== 'string') {
      throw new SystemError('EPROTO', `'${o.type}' frame has no dataB64: ${clip(text)}`);
    }
    if (!isBase64(o.dataB64)) {
      throw new SystemError('EPROTO', `'${o.type}' frame carries invalid base64: ${clip(text)}`);
    }
  }
  return o as AnyFrame;
}

// The frame types whose meaning IS their payload. A type not listed here may
// carry a `dataB64` cc does not know about; unknown fields stay ignorable.
const PAYLOAD_FRAMES = new Set(['stdout', 'stderr', 'data']);

// Strict base64: canonical alphabet, correct padding, length a multiple of 4.
// Deliberately two linear tests rather than one regex with a `*` group, so a
// megabyte of garbage cannot become a backtracking cost.
const B64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64(v: string): boolean {
  return v.length % 4 === 0 && B64_CHARS.test(v);
}

function clip(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

// The `id` of a frame, or null when it carries none (a connection-level error,
// or the handshake).
export function frameId(f: AnyFrame): string | null {
  return typeof f.id === 'string' ? f.id : null;
}
