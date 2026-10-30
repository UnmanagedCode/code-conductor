// The terminal primitive on `System` (`openTerminal`): its types, its per-system
// cap, its spec validation and its three named refusals. Both implementations —
// LocalSystem in-process and ProviderSystem over the protocol's `pty` exec
// (docs/systems-protocol.md §5) — share every line of this.
//
// cc is the BYTE PIPE and nothing else: the caller owns the session, its
// scrollback and its reconnects, and a terminal dying with cc, a plugin or a
// provider is accepted.
//
// THE REFUSALS ARE `httpError`s, statusCode + code, the shape `capabilityRefusal`
// has, so a REST or MCP surface wrapping this renders them unchanged. A failure
// ABOUT the target — no such cwd, no such program, no tty — is a SystemError
// with its protocol code instead, exactly what `exec` and the file primitives
// raise.

import { httpError } from '../httpError.ts';
import { assertEnvOverlay } from './execWrap.ts';
import { PTY_DIM_MAX, SystemError } from './protocol.ts';
import { requireAbsolute } from './system.ts';

export interface TerminalSpec {
  // Absolute, on the system.
  cwd: string;
  // Absent → the TARGET user's login shell.
  argv?: string[];
  // ADDED to the target's own environment, never a replacement — the caller
  // cannot know a remote target's HOME, PATH or LANG. ENV_NAME_RE names, no NUL.
  env?: Record<string, string>;
  // Integers in 1..PTY_DIM_MAX.
  cols: number;
  rows: number;
  // Becomes TERM, over `env.TERM`. TERM_RE.
  term: string;
  // Aborting is `close()`; aborting before the open resolves rejects ECANCELLED.
  signal?: AbortSignal;
}

// Passed AT OPEN, because a shell's first prompt can arrive in the same tick the
// open resolves and a handler registered afterwards would miss it.
export interface TerminalHandlers {
  // Raw bytes: a UTF-8 sequence may be split across two chunks.
  onData(chunk: Buffer): void;
  // Exactly once.
  onExit(end: TerminalEnd): void;
}

export type TerminalEnd =
  // The program ended. `code` is null when a signal ended it.
  | { kind: 'exited'; code: number | null; signal: string | null }
  // The owner closed it, or aborted its signal.
  | { kind: 'closed' }
  // It was lost under the owner — the provider died (ETRANSPORT), say.
  | { kind: 'failed'; error: SystemError };

export interface Terminal {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  // No `onData` between `pause()` and `resume()`: the backpressure lever a
  // WebSocket owner drives from its `bufferedAmount`. The program blocks on its
  // writes meanwhile, so nothing is dropped.
  pause(): void;
  resume(): void;
  // Idempotent. Kills the program's session; `onExit({kind:'closed'})` follows.
  close(): void;
}

// Open terminals per system — per HOST for the in-process `local`, per provider
// PIPE for a provider (every `bindRemote` view shares its owner's).
export const MAX_TERMINALS_PER_SYSTEM = 16;

// What a TERM value may be: a terminfo name.
export const TERM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export const PTY_UNAVAILABLE = 'PTY_UNAVAILABLE';
export const SYSTEM_NO_PTY = 'SYSTEM_NO_PTY';
export const TERMINAL_LIMIT = 'TERMINAL_LIMIT';

// cc's OWN host cannot run a terminal: no helper on this platform, or no
// python3. `reason` names which, and how to fix it.
export function ptyUnavailable(reason: string): Error & { statusCode: number } {
  return httpError(501,
    `terminals are not available on this host: ${reason}. cc checks once per process, so restart it after fixing this`,
    { code: PTY_UNAVAILABLE });
}

export function systemNoPty(systemId: string, provider: string): Error & { statusCode: number } {
  return httpError(501,
    `system '${systemId}' is served by ${provider}, which does not support terminals (no \`pty\` capability)`,
    { code: SYSTEM_NO_PTY });
}

export function terminalLimit(systemId: string, max: number): Error & { statusCode: number } {
  return httpError(429,
    `system '${systemId}' already has ${max} open terminals, the most it allows — close one first`,
    { code: TERMINAL_LIMIT });
}

// The open-terminal count for one system. A slot is taken before anything is
// spawned or sent, and its release is idempotent so every exit path can call it.
export class TerminalSlots {
  readonly #max: number;
  #open = 0;

  constructor(max: number = MAX_TERMINALS_PER_SYSTEM) { this.#max = max; }

  acquire(systemId: string): () => void {
    if (this.#open >= this.#max) throw terminalLimit(systemId, this.#max);
    this.#open += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#open -= 1;
    };
  }
}

// A bad spec is cc's OWN bug — the surface that takes one from a client
// validates it first — so this throws, like `requireAbsolute`.
export function validateTerminalSpec(spec: TerminalSpec): void {
  requireAbsolute('openTerminal', 'cwd', spec.cwd);
  assertDims('openTerminal', spec.cols, spec.rows);
  if (typeof spec.term !== 'string' || !TERM_RE.test(spec.term)) {
    throw new Error(`openTerminal: term ${JSON.stringify(spec.term)} does not match ${TERM_RE}`);
  }
  if (spec.argv !== undefined) {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv[0] === ''
      || spec.argv.some(a => typeof a !== 'string' || a.includes('\0'))) {
      throw new Error('openTerminal: argv must be a non-empty array of strings without NUL');
    }
  }
  if (spec.env !== undefined) assertEnvOverlay(spec.env);
}

export function assertDims(op: string, cols: number, rows: number): void {
  for (const [name, v] of [['cols', cols], ['rows', rows]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > PTY_DIM_MAX) {
      throw new Error(`${op}: ${name} must be an integer in 1..${PTY_DIM_MAX}, got ${String(v)}`);
    }
  }
}

export function openCancelled(): SystemError {
  return new SystemError('ECANCELLED', 'openTerminal: the signal was aborted before the terminal opened');
}

export function toBuffer(data: Buffer | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}
