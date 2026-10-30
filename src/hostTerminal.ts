// `GET /api/terminal` — a terminal on a project's System, or on a System
// addressed directly, for a plugin backend, as a WebSocket
// (docs/plugins.md → Host terminal).
//
// All of it lives here so server.ts's upgrade dispatch stays one branch: the
// Origin refusal, the spec, target resolution (src/hostTarget.ts, shared with
// `POST /api/exec`), the open, and the pump between the socket and the
// Terminal.
//
// THE TERMINAL OPENS BEFORE THE HANDSHAKE COMPLETES, so every refusal — a bad
// spec, an unknown target, a target that cannot start the program — is an HTTP
// answer with a JSON body rather than a socket that opens and dies.
//
// THE TRUST MODEL IS `/api/exec`'s: no caller check. cc listens on loopback,
// and ANY Origin is refused — a browser always sends one on a WebSocket
// handshake, so no page reaches this, same-origin cc pages and plugin iframes
// included, while a plugin backend sends none.

import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PlatformCapabilities } from './platform/index.ts';
import {
  HOST_TARGET_KEYS, invalidArgument, isPlainObject, parseEnvOverlay, parseHostTarget, resolveHostTarget,
  type HostTarget,
} from './hostTarget.ts';
import { errorBody } from './routes.ts';
import { PTY_DIM_MAX, SystemError } from './systems/protocol.ts';
import { TERM_RE, type Terminal, type TerminalEnd, type TerminalHandlers } from './systems/terminal.ts';

// Output sent to the socket and not yet written by it, at which the terminal
// is paused; it is resumed when that reaches 0.
export const TERMINAL_WS_HIGH_WATER_BYTES = 256 * 1024;
// The largest message a client may send; `ws` closes 1009 past it.
export const TERMINAL_WS_MAX_MESSAGE_BYTES = 64 * 1024;
export const TERMINAL_DEFAULT_TERM = 'xterm-256color';

const OP = 'terminal';
const SPEC_KEYS = new Set<string>([...HOST_TARGET_KEYS, 'argv', 'env', 'cols', 'rows', 'term']);

interface TerminalRequest {
  target: HostTarget;
  argv: string[] | undefined;
  env: Record<string, string> | undefined;
  cols: number;
  rows: number;
  term: string;
}

const invalid = (message: string): Error => invalidArgument(OP, message);

const isDim = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PTY_DIM_MAX;

// The `spec` query parameter. Shape only: every refusal is a 400.
function parseSpec(url: string | undefined): TerminalRequest {
  const raw = new URL(url ?? '', 'http://placeholder').searchParams.get('spec');
  if (raw === null) throw invalid('the spec query parameter is required: a URL-encoded JSON object');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw invalid('spec is not JSON'); }
  if (!isPlainObject(body)) throw invalid('spec must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!SPEC_KEYS.has(k)) throw invalid(`unknown field ${JSON.stringify(k)}`);
  }
  const target = parseHostTarget(body, OP);
  let argv: string[] | undefined;
  if (body.argv !== undefined) {
    const a = body.argv;
    if (!Array.isArray(a) || a.length === 0 || a.some(x => typeof x !== 'string' || x.includes('\0')) || a[0] === '') {
      throw invalid('argv must be a non-empty array of strings without NUL, argv[0] non-empty');
    }
    argv = a as string[];
  }
  const env = body.env === undefined ? undefined : parseEnvOverlay(body.env, OP);
  if (!isDim(body.cols) || !isDim(body.rows)) throw invalid(`cols and rows must be integers in 1..${PTY_DIM_MAX}`);
  let term = TERMINAL_DEFAULT_TERM;
  if (body.term !== undefined) {
    if (typeof body.term !== 'string' || !TERM_RE.test(body.term)) throw invalid(`term must match ${TERM_RE}`);
    term = body.term;
  }
  return { target, argv, env, cols: body.cols, rows: body.rows, term };
}

// A failure of the open, as the status and body the handshake is answered with.
function refusalFor(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof SystemError) {
    const subject = `${OP}: ${e.message}`;
    if (e.code === 'ETRANSPORT' || e.code === 'ETIMEDOUT') {
      return { status: 502, body: { error: subject, code: 'SYSTEM_UNREACHABLE' } };
    }
    if (e.code === 'ENOREMOTE') return { status: 502, body: { error: subject, code: 'REMOTE_NOT_FOUND' } };
    return { status: 422, body: { error: subject, code: 'TERMINAL_SPAWN_FAILED', errno: e.code } };
  }
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  if (typeof s === 'number') return { status: s, body: errorBody(e) };
  console.error('GET /api/terminal: unexpected failure opening a terminal:', e);
  return { status: 500, body: errorBody(e) };
}

function refuseUpgrade(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  try {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\n`
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(json)}\r\n`
      + `Connection: close\r\n\r\n${json}`, () => socket.destroy());
  } catch { socket.destroy(); }
}

// ── The pump ─────────────────────────────────────────────────────────

export type BridgeSocket = Pick<WebSocket, 'send' | 'close' | 'pause' | 'resume' | 'on'>;

export interface TerminalBridge {
  // Passed to `openTerminal`. What arrives before `attach` is held.
  handlers: TerminalHandlers;
  attach(ws: BridgeSocket, terminal: Terminal): void;
}

// The resize a text message asks for, or why it breaks the protocol.
function parseControl(data: Buffer): { cols: number; rows: number } | string {
  let m: unknown;
  try { m = JSON.parse(data.toString('utf8')); } catch { return 'a text message must be a JSON control message'; }
  if (!isPlainObject(m) || m.type !== 'resize' || Object.keys(m).some(k => !['type', 'cols', 'rows'].includes(k))) {
    return 'the only control message is {"type":"resize","cols":N,"rows":N}';
  }
  if (!isDim(m.cols) || !isDim(m.rows)) return `resize: cols and rows must be integers in 1..${PTY_DIM_MAX}`;
  return { cols: m.cols, rows: m.rows };
}

function rawToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBuffer);
}

// Binary messages carry terminal bytes both ways; text from the client is a
// control message; text to the client is the one end message, last.
//
// BACKPRESSURE, both ways. Output: bytes handed to `ws.send` whose callback has
// not fired are counted, the terminal paused at TERMINAL_WS_HIGH_WATER_BYTES and
// resumed at 0. Input: a `write` returning false pauses the socket, `onDrain`
// resumes it.
export function createTerminalBridge(): TerminalBridge {
  let ws: BridgeSocket | null = null;
  let terminal: Terminal | null = null;
  const early: Buffer[] = [];
  let earlyEnd: TerminalEnd | null = null;
  let outstanding = 0;
  let paused = false;
  // The terminal reported its end / the bridge or the client closed it.
  let ended = false;
  let closed = false;

  const sendOutput = (s: BridgeSocket, chunk: Buffer): void => {
    outstanding += chunk.length;
    s.send(chunk, { binary: true }, () => {
      outstanding -= chunk.length;
      if (paused && outstanding === 0) {
        paused = false;
        terminal?.resume();
      }
    });
    if (!paused && outstanding >= TERMINAL_WS_HIGH_WATER_BYTES) {
      paused = true;
      terminal?.pause();
    }
  };

  const finish = (s: BridgeSocket, end: TerminalEnd): void => {
    if (end.kind === 'exited') {
      s.send(JSON.stringify({ type: 'exit', code: end.code, signal: end.signal }));
      s.close(1000, 'the program exited');
    } else if (end.kind === 'failed') {
      s.send(JSON.stringify({ type: 'failed', code: end.error.code, error: end.error.message }));
      s.close(1011, 'the terminal was lost');
    }
    // `closed`: the bridge or the client closed it, and the socket is closing.
  };

  return {
    handlers: {
      onData(chunk) {
        if (ws) sendOutput(ws, chunk);
        else early.push(chunk);
      },
      onExit(end) {
        ended = true;
        if (ws) finish(ws, end);
        else earlyEnd = end;
      },
      onDrain() { ws?.resume(); },
    },
    attach(s, term) {
      ws = s;
      terminal = term;
      const closeTerminal = (): void => {
        if (closed || ended) return;
        closed = true;
        term.close();
      };
      s.on('message', (data, isBinary) => {
        if (closed || ended) return;
        const buf = rawToBuffer(data);
        if (isBinary) {
          if (term.write(buf) === false) s.pause();
          return;
        }
        const c = parseControl(buf);
        if (typeof c === 'string') {
          s.close(1008, c);
          closeTerminal();
          return;
        }
        term.resize(c.cols, c.rows);
      });
      s.on('close', closeTerminal);
      s.on('error', closeTerminal);
      for (const chunk of early.splice(0)) sendOutput(s, chunk);
      if (earlyEnd) finish(s, earlyEnd);
    },
  };
}

// ── The endpoint ─────────────────────────────────────────────────────

export function createTerminalEndpoint({ capabilities }: { capabilities: PlatformCapabilities }) {
  const wss = new WebSocketServer({
    noServer: true, maxPayload: TERMINAL_WS_MAX_MESSAGE_BYTES, perMessageDeflate: false, clientTracking: false,
  });

  async function open(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (req.headers.origin !== undefined) {
      refuseUpgrade(socket, 403, {
        error: `${OP}: a request carrying an Origin is refused — a browser page may not open a host terminal`,
        code: 'ORIGIN_REFUSED',
      });
      return;
    }
    // The client going away during the open cancels it.
    const ac = new AbortController();
    const onGone = (): void => ac.abort();
    socket.once('close', onGone);
    const bridge = createTerminalBridge();
    let terminal: Terminal;
    try {
      const r = parseSpec(req.url);
      const { sys, cwd } = await resolveHostTarget(r.target, capabilities, OP);
      terminal = await sys.openTerminal({
        cwd, cols: r.cols, rows: r.rows, term: r.term, signal: ac.signal,
        ...(r.argv ? { argv: r.argv } : {}), ...(r.env ? { env: r.env } : {}),
      }, bridge.handlers);
    } catch (e) {
      socket.off('close', onGone);
      if (socket.destroyed) return;
      const { status, body } = refusalFor(e);
      refuseUpgrade(socket, status, body);
      return;
    }
    socket.off('close', onGone);
    if (socket.destroyed) { terminal.close(); return; }
    // Synchronous with perMessageDeflate off, so nothing reaches the bridge
    // between the open and the attach beyond what it holds. `ws` answers a
    // malformed handshake itself and never calls back: the terminal is closed.
    let attached = false;
    wss.handleUpgrade(req, socket, head, (ws) => {
      attached = true;
      bridge.attach(ws, terminal);
    });
    if (!attached) terminal.close();
  }

  return {
    handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
      open(req, socket, head).catch((e) => {
        console.error('GET /api/terminal: unexpected failure in the upgrade:', e);
        socket.destroy();
      });
    },
  };
}
