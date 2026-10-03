// The browser-driven `claude auth login` flow behind Settings → Account.
//
// Over plain pipes the CLI prints a sign-in URL (`… visit: <url>`), then a
// prompt with no trailing newline, and reads the `<code>#<state>` the callback
// page shows as ONE stdin line. A line without `#` makes it complain on stderr
// and read again; a rejected code is a stderr line and exit 1; success is exit 0.
// Closing stdin does NOT end it — it waits forever — so every way out of a flow
// kills the child.
//
// `BROWSER=true` stops the CLI opening a browser on the server host. No
// CLAUDE_CONFIG_DIR/HOME override: the CLI writes the store worker spawns read.
// cc never touches the credential files itself; a cancelled, failed or
// timed-out login leaves valid credentials untouched, so a re-login runs in
// place with no staging.
//
// One flow per instance (createServer owns one); any client can observe or
// cancel it. The pasted code is written to stdin and never stored.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolveClaudeBin } from './claudeLauncher.ts';
import { cliEnvBase } from './cliEnv.ts';
import { humanizeDuration } from './duration.ts';
import { httpError } from './httpError.ts';
import type { Platform } from './platform/index.ts';

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 2000;
const STDOUT_CAP = 16 * 1024;
const STDERR_TAIL = 4 * 1024;
const MAX_CODE_LEN = 4096;
const URL_RE = /visit:\s*(https:\/\/\S+)/;

export type LoginState = 'idle' | 'starting' | 'awaiting_code' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
export interface LoginSnapshot {
  state: LoginState;
  url: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}
export interface ClaudeLoginFlow {
  start(): LoginSnapshot;
  submitCode(code: unknown): LoginSnapshot;
  cancel(): LoginSnapshot;
  snapshot(): LoginSnapshot;
  dispose(): void;
}

const ACTIVE: ReadonlySet<LoginState> = new Set(['starting', 'awaiting_code', 'verifying']);

export function createClaudeLoginFlow({
  platform, timeoutMs = LOGIN_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS, onSuccess,
}: { platform: Platform; timeoutMs?: number; killGraceMs?: number; onSuccess?: () => void }): ClaudeLoginFlow {
  let snap: LoginSnapshot = { state: 'idle', url: null, error: null, startedAt: null, endedAt: null };
  // The live run, or null. Every handler checks it is still the current run, so
  // a late event from a killed child never writes into the next flow.
  let run: { child: ChildProcess; timer: NodeJS.Timeout; onProcessExit: () => void } | null = null;

  const view = (): LoginSnapshot => ({ ...snap });
  const active = (): boolean => ACTIVE.has(snap.state);
  const alive = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

  function kill(child: ChildProcess): void {
    if (!alive(child)) return;
    try { platform.killProcess(child, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      if (alive(child)) { try { platform.killProcess(child, 'SIGKILL'); } catch { /* already gone */ } }
    }, killGraceMs).unref();
  }

  // Ends the run: no more timer, no process-exit hook. The child itself is
  // killed separately by whichever path needs it.
  function release(): void {
    if (!run) return;
    clearTimeout(run.timer);
    process.off('exit', run.onProcessExit);
    run = null;
  }

  function finish(state: 'succeeded' | 'failed' | 'cancelled', error: string | null): void {
    snap = { ...snap, state, error, endedAt: Date.now() };
  }

  function start(): LoginSnapshot {
    if (active()) throw httpError(409, 'a Claude login is already in progress');
    const { command, prefixArgs } = resolveClaudeBin(platform);
    snap = { state: 'starting', url: null, error: null, startedAt: Date.now(), endedAt: null };
    let child: ChildProcess;
    try {
      child = spawn(command, [...prefixArgs, 'auth', 'login'], {
        ...platform.spawnOptions('child'),
        env: { ...cliEnvBase(platform), BROWSER: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish('failed', `claude CLI could not be started (${command}): ${(e as Error).message}`);
      return view();
    }

    const timer = setTimeout(() => {
      if (run?.child !== child) return;
      finish('failed', `Login timed out after ${humanizeDuration(timeoutMs)}`);
      kill(child);
    }, timeoutMs);
    timer.unref();
    // cc exiting by any `process.exit` path must not leave the child waiting on stdin.
    const onProcessExit = (): void => { try { platform.killProcess(child, 'SIGTERM'); } catch { /* already gone */ } };
    process.once('exit', onProcessExit);
    run = { child, timer, onProcessExit };

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_CAP) stdout = (stdout + chunk).slice(0, STDOUT_CAP);
      if (run?.child !== child || snap.state !== 'starting') return;
      const m = URL_RE.exec(stdout);
      if (m) snap = { ...snap, state: 'awaiting_code', url: m[1] };
    });

    let stderrTail = '';
    let partial = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      // A complaint while the CLI is still alive after a code is its re-prompt
      // ("Invalid code…"): it keeps reading stdin.
      const last = lines.map(l => l.trim()).filter(Boolean).pop();
      if (last && run?.child === child && snap.state === 'verifying' && alive(child)) {
        snap = { ...snap, state: 'awaiting_code', error: last };
      }
    });

    // A write to a child that has just exited is EPIPE; the exit handler reports it.
    child.stdin?.on('error', () => {});

    // A spawn failure (ENOENT) is the one 'error' that ends the run: the child
    // never got a pid. Any other (a failed kill) leaves a live child to close.
    child.on('error', (e) => {
      if (run?.child !== child || child.pid !== undefined) return;
      release();
      if (active()) finish('failed', `claude CLI could not be started (${command}): ${e.message}`);
    });

    // 'close', not 'exit': it fires once stderr is drained, so a CLI that writes
    // its reason and exits at once still has that reason read.
    child.on('close', (code, signal) => {
      if (run?.child !== child) return;
      release();
      // Cancel and timeout already settled the state; the exit they caused keeps it.
      if (!active()) return;
      if (code === 0) {
        finish('succeeded', null);
        onSuccess?.();
        return;
      }
      const lastLine = stderrTail.split('\n').map(l => l.trim()).filter(Boolean).pop();
      finish('failed', lastLine ?? `claude auth login exited (code ${code ?? 'none'} / signal ${signal ?? 'none'})`);
    });

    return view();
  }

  function submitCode(code: unknown): LoginSnapshot {
    if (typeof code !== 'string') throw httpError(400, 'code must be a string');
    const trimmed = code.trim();
    if (!trimmed) throw httpError(400, 'code is empty');
    if (trimmed.length > MAX_CODE_LEN) throw httpError(400, `code is longer than ${MAX_CODE_LEN} characters`);
    // One line, or a paste could feed the CLI a second answer.
    if (/[\r\n]/.test(trimmed)) throw httpError(400, 'code must be a single line');
    if (snap.state !== 'awaiting_code' || !run) throw httpError(409, 'no Claude login is waiting for a code');
    run.child.stdin?.write(trimmed + '\n');
    snap = { ...snap, state: 'verifying', error: null };
    return view();
  }

  function cancel(): LoginSnapshot {
    if (!active()) return view();
    finish('cancelled', null);
    if (run) kill(run.child);
    return view();
  }

  function dispose(): void {
    if (!run) return;
    const { child } = run;
    if (active()) finish('cancelled', null);
    release();
    try { platform.killProcess(child, 'SIGTERM'); } catch { /* already gone */ }
  }

  return { start, submitCode, cancel, snapshot: view, dispose };
}
