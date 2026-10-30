// THE ONE PTY IMPLEMENTATION, shared by both ends: `LocalSystem.openTerminal`
// runs it in cc's process and the reference provider runs it on the far side
// of the wire, so a terminal on a local project and one on a remote project
// are the same code.
//
// A terminal is a python3 helper (src/systems/ptyHelper.py, stdlib only) that
// owns the pseudo-terminal, spoken to over a length-prefixed byte protocol on
// its stdin/stdout. That is what keeps a native npm dependency out of cc:
// `node-pty` builds at install time, which the Windows installer refuses
// (docs/windows.md, C3). The cost is a python3 on the host — detected once per
// process by `probePtyHelper`, so installing one later takes a restart.
//
// Provider-side code imports this file, so it imports nothing of cc's: it is
// copied beside the reference provider wherever that runs.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PTY_HELPER_PATH = path.join(import.meta.dirname, 'ptyHelper.py');

// How long a closed terminal's helper gets to hang its session up and exit
// before it is SIGKILLed. Above the helper's own CLOSE_GRACE_S, so a healthy
// helper always finishes its own kill first.
const HELPER_KILL_GRACE_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;
// Kept of the helper's stderr, so a failure can quote it.
const STDERR_TAIL = 2 * 1024;
// Bytes per `d` frame to the helper.
const WRITE_CHUNK = 64 * 1024;

// ── Probe ────────────────────────────────────────────────────────────

export type PtyProbe = { ok: true; interpreter: string } | { ok: false; reason: string };

const probes = new Map<string, Promise<PtyProbe>>();

// Can this host run the helper? ONCE PER PROCESS per interpreter name — the
// PROMISE is memoised, so concurrent first callers share one spawn. The answer
// is the interpreter's ABSOLUTE path, which is what every terminal then spawns:
// a caller's PATH in the terminal's environment cannot swap it.
export function probePtyHelper({ python = 'python3' }: { python?: string } = {}): Promise<PtyProbe> {
  let p = probes.get(python);
  if (!p) {
    p = runProbe(python);
    probes.set(python, p);
  }
  return p;
}

function runProbe(python: string): Promise<PtyProbe> {
  return new Promise((resolve) => {
    execFile(python, ['-I', '-c', 'import pty,termios,fcntl,select,sys; print(sys.executable)'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            reason: code === 'ENOENT'
              ? `${python} not found on PATH (Termux: \`pkg install python\`)`
              : `${python} cannot run the pty helper: ${(stderr || err.message).trim().slice(-STDERR_TAIL)}`,
          });
          return;
        }
        const interpreter = stdout.trim();
        if (!path.isAbsolute(interpreter)) {
          resolve({ ok: false, reason: `${python} reported no usable sys.executable (${JSON.stringify(interpreter)})` });
          return;
        }
        resolve({ ok: true, interpreter });
      });
  });
}

// The target user's login shell — what a terminal runs when its caller names
// no program.
export function posixLoginShell(): string[] {
  let shell = '';
  try { shell = os.userInfo().shell ?? ''; } catch { /* no passwd entry */ }
  return [shell || process.env.SHELL || '/bin/sh', '-l'];
}

// ── Framing ──────────────────────────────────────────────────────────

export interface HelperFrame { type: string; payload: Buffer }

export function encodeHelperFrame(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export class HelperFrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): HelperFrame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: HelperFrame[] = [];
    let at = 0;
    while (this.#buf.length - at >= 5) {
      const len = this.#buf.readUInt32BE(at + 1);
      if (this.#buf.length - at - 5 < len) break;
      out.push({ type: this.#buf.toString('latin1', at, at + 1), payload: this.#buf.subarray(at + 5, at + 5 + len) });
      at += 5 + len;
    }
    this.#buf = this.#buf.subarray(at);
    return out;
  }
}

// ── spawnPty ─────────────────────────────────────────────────────────

export interface PtySpawnSpec {
  interpreter: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  // Bound on the START: no `S` within it fails the open ETIMEDOUT and kills
  // the helper. Absent → unbounded, for a caller that bounds the open itself.
  startTimeoutMs?: number;
}

export interface PtyHandlers {
  onStarted(): void;
  onData(chunk: Buffer): void;
  onExit(code: number | null, signal: string | null): void;
  // Before `onStarted`: the program never ran. After it: the helper died
  // without reporting an exit. `code` is a protocol code name.
  onFailed(code: string, message: string): void;
}

export interface PtyProcess {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  // No `onData` (nor `onExit`) is delivered between `pause()` and `resume()`.
  // The helper's stdout is paused with it, so pipe backpressure stops the
  // helper reading the terminal and the program blocks on its next write.
  pause(): void;
  resume(): void;
  // Idempotent. Nothing is delivered after it.
  close(): void;
}

// Exactly one of `onExit` / `onFailed` is ever called, and none after `close()`.
export function spawnPty(spec: PtySpawnSpec, h: PtyHandlers): PtyProcess {
  let child: ChildProcess | null = null;
  let done = false;
  let started = false;
  let paused = false;
  let killTimer: NodeJS.Timeout | null = null;
  let stderrTail = '';
  const queue: HelperFrame[] = [];
  const decoder = new HelperFrameDecoder();
  // Bytes written before the spawn happened (the cwd check is async).
  const early: Buffer[] = [];
  // The helper ended without reporting while frames were still queued behind
  // a pause: the failure is reported once they have been delivered.
  let failAfterQueue: (() => void) | null = null;
  const startTimer = spec.startTimeoutMs === undefined ? null : setTimeout(() => {
    if (started || done) return;
    finish(() => h.onFailed('ETIMEDOUT', `the pty helper did not start the program within ${spec.startTimeoutMs}ms`));
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
  }, spec.startTimeoutMs);
  startTimer?.unref();

  const finish = (fn: () => void): void => {
    if (done) return;
    done = true;
    if (startTimer) clearTimeout(startTimer);
    fn();
  };

  // Frame-granular, so a pause lands between two frames of one pipe chunk.
  const pump = (): void => {
    while (!paused && !done && queue.length > 0) {
      const f = queue.shift() as HelperFrame;
      if (f.type === 'S') {
        started = true;
        if (startTimer) clearTimeout(startTimer);
        h.onStarted();
      }
      else if (f.type === 'o') h.onData(f.payload);
      else if (f.type === 'x') {
        const r = parseJson(f.payload);
        finish(() => h.onExit(typeof r.code === 'number' ? r.code : null, typeof r.signal === 'string' ? r.signal : null));
      } else if (f.type === 'e') {
        const r = parseJson(f.payload);
        finish(() => h.onFailed(
          typeof r.code === 'string' && r.code !== '' ? r.code : 'EPTY',
          typeof r.message === 'string' ? r.message : 'the pty helper failed',
        ));
      }
    }
    if (!paused && queue.length === 0) failAfterQueue?.();
  };

  const send = (b: Buffer): void => {
    if (done) return;
    if (!child) { early.push(b); return; }
    if (child.stdin?.writable) child.stdin.write(b);
  };

  const start = (): void => {
    try {
      child = spawn(spec.interpreter, ['-I', PTY_HELPER_PATH, String(spec.cols), String(spec.rows), '--', ...spec.argv], {
        cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // A NUL in an argv entry or the env.
      finish(() => h.onFailed('EINVAL', e instanceof Error ? e.message : String(e)));
      return;
    }
    const c = child;
    c.stdin?.on('error', () => { /* the helper is gone; its exit reports it */ });
    c.stdout?.on('data', (chunk: Buffer) => {
      queue.push(...decoder.push(chunk));
      pump();
    });
    c.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    c.on('error', (e) => finish(() => h.onFailed('EPTY', `cannot start the pty helper: ${e.message}`)));
    c.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      // Frames still queued behind a pause are delivered on resume; only a
      // helper that ended WITHOUT reporting is a failure.
      const report = (): void => finish(() => h.onFailed(started ? 'ETRANSPORT' : 'EPTY',
        `the pty helper exited (${signal ? `signal ${signal}` : `code ${code}`}) without reporting`
        + (stderrTail.trim() ? `: ${stderrTail.trim()}` : '')));
      failAfterQueue = report;
      pump();
    });
    if (paused) c.stdout?.pause();
    for (const b of early.splice(0)) send(b);
  };

  // The cwd is checked FIRST: a missing one would otherwise surface as the
  // helper's own spawn ENOENT, indistinguishable from a missing interpreter.
  fs.stat(spec.cwd).then((st) => {
    if (done) return;
    if (!st.isDirectory()) {
      finish(() => h.onFailed('ENOTDIR', `cwd '${spec.cwd}' is not a directory`));
      return;
    }
    start();
  }, (e: NodeJS.ErrnoException) => {
    finish(() => h.onFailed(e.code ?? 'EUNKNOWN', `cwd '${spec.cwd}': ${e.message}`));
  });

  return {
    write(data) {
      for (let at = 0; at < data.length; at += WRITE_CHUNK) send(encodeHelperFrame('d', data.subarray(at, at + WRITE_CHUNK)));
    },
    resize(cols, rows) {
      const p = Buffer.alloc(4);
      p.writeUInt16BE(cols, 0);
      p.writeUInt16BE(rows, 2);
      send(encodeHelperFrame('r', p));
    },
    pause() {
      paused = true;
      child?.stdout?.pause();
    },
    resume() {
      if (!paused) return;
      paused = false;
      child?.stdout?.resume();
      pump();
    },
    close() {
      if (done) return;
      done = true;
      if (startTimer) clearTimeout(startTimer);
      const c = child;
      if (!c) return;
      // Drain and discard, so a helper blocked writing to a paused pipe reaches
      // the stdin EOF that is its instruction to hang up.
      c.stdout?.removeAllListeners('data');
      c.stdout?.resume();
      try { c.stdin?.end(); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* already gone */ } }, HELPER_KILL_GRACE_MS);
      killTimer.unref();
    },
  };
}

function parseJson(b: Buffer): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {};
  } catch { return {}; }
}
