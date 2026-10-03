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
// The whole line: a URL split across stdout chunks must not be read half-way.
const URL_RE = /visit:\s*(https:\/\/\S+)\r?\n/;

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
  platform, timeoutMs = LOGIN_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS, onStart, onSuccess,
}: { platform: Platform; timeoutMs?: number; killGraceMs?: number; onStart?: () => void; onSuccess?: () => void }): ClaudeLoginFlow {
  let snap: LoginSnapshot = { state: 'idle', url: null, error: null, startedAt: null, endedAt: null };
  // The active flow's child and timeout, or null. Cancel and timeout end the run
  // at once, so a start right after them never meets a stale one, and every
  // handler checks it is still the current run: a late event from a killed
  // child never writes into the next flow.
  let run: { child: ChildProcess; timer: NodeJS.Timeout } | null = null;
  // Every child not yet closed, current or killed. A killed child can outlive its
  // run by up to `killGraceMs`, so cc exiting by any `process.exit` path must
  // still reach it: ONE process-exit hook is held while this set is non-empty.
  const live = new Set<ChildProcess>();
  // The current run's stderr since the last submitted code — the CLI's answer
  // to that code — and whether it has already turned into a complaint.
  let answer = '';
  let complaining = false;
  const killAllSync = (): void => {
    for (const c of live) { try { platform.killProcess(c, 'SIGTERM'); } catch { /* already gone */ } }
  };
  function track(child: ChildProcess): void {
    if (live.size === 0) process.once('exit', killAllSync);
    live.add(child);
  }
  function untrack(child: ChildProcess): void {
    if (!live.delete(child) || live.size > 0) return;
    process.off('exit', killAllSync);
  }

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

  // Ends the run: no more timer, and the child's events stop driving the state.
  // The child itself is killed separately by whichever path needs it, and leaves
  // `live` only when it closes.
  function release(): void {
    if (!run) return;
    clearTimeout(run.timer);
    run = null;
  }

  function finish(state: 'succeeded' | 'failed' | 'cancelled', error: string | null): void {
    snap = { ...snap, state, error, endedAt: Date.now() };
  }

  function start(): LoginSnapshot {
    if (active()) throw httpError(409, 'a Claude login is already in progress');
    const { command, prefixArgs } = resolveClaudeBin(platform);
    snap = { state: 'starting', url: null, error: null, startedAt: Date.now(), endedAt: null };
    answer = '';
    complaining = false;
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
      release();
      kill(child);
    }, timeoutMs);
    timer.unref();
    track(child);
    run = { child, timer };
    // Only once the child is tracked and owned by the run: a throwing hook must
    // not strand a live child no cleanup path can reach. It is a side effect of
    // the start, not a condition of it, so a throw is logged and the flow goes on.
    try { onStart?.(); }
    catch (e) { console.warn(`${new Date().toISOString()} [claudeLogin] onStart hook threw: ${(e as Error)?.message ?? String(e)}`); }

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_CAP) stdout = (stdout + chunk).slice(0, STDOUT_CAP);
      if (run?.child !== child || snap.state !== 'starting') return;
      const m = URL_RE.exec(stdout);
      if (m) snap = { ...snap, state: 'awaiting_code', url: m[1] };
    });

    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      // A complaint while the CLI is still alive after a code is its re-prompt
      // ("Invalid code…"): it keeps reading stdin. Its last line counts even
      // unterminated, and a complaint arriving in pieces keeps updating the
      // error until the next submit.
      if (run?.child !== child || !alive(child)) return;
      if (snap.state !== 'verifying' && !(snap.state === 'awaiting_code' && complaining)) return;
      answer = (answer + chunk).slice(-STDERR_TAIL);
      const last = answer.split('\n').map(l => l.trim()).filter(Boolean).pop();
      if (!last) return;
      complaining = true;
      snap = { ...snap, state: 'awaiting_code', error: last };
    });

    // A write to a child that has just exited is EPIPE; the exit handler reports it.
    child.stdin?.on('error', () => {});

    // A spawn failure (ENOENT) is the one 'error' that ends the run: the child
    // never got a pid. Any other (a failed kill) leaves a live child to close.
    child.on('error', (e) => {
      if (child.pid !== undefined) return;
      untrack(child);
      if (run?.child !== child) return;
      release();
      if (active()) finish('failed', `claude CLI could not be started (${command}): ${e.message}`);
    });

    // 'close', not 'exit': it fires once stderr is drained, so a CLI that writes
    // its reason and exits at once still has that reason read.
    child.on('close', (code, signal) => {
      untrack(child);
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
    // Stderr from here on is the CLI's answer to THIS code.
    answer = '';
    complaining = false;
    snap = { ...snap, state: 'verifying', error: null };
    return view();
  }

  function cancel(): LoginSnapshot {
    if (!active()) return view();
    finish('cancelled', null);
    const child = run?.child;
    release();
    if (child) kill(child);
    return view();
  }

  // Server close: ends any flow and kills every child still alive, with the same
  // SIGKILL backstop as cancel.
  function dispose(): void {
    if (active()) finish('cancelled', null);
    release();
    for (const c of live) kill(c);
  }

  return { start, submitCode, cancel, snapshot: view, dispose };
}
