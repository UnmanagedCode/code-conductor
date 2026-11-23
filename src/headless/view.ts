// The `--view` process: what `node server.ts --view [--session <id>]` does
// (src/headless/args.ts). cc boots as a headless server — no web build, no
// resume restore — over a finished run's root, view-only and focused on that
// run's session, and serves until a signal. It starts no session: its
// InstanceManager refuses every create() (VIEW_NO_LAUNCH), and its boot starts
// no plugin backend and forks no CLI. The ended session reads from its
// transcript on disk, so the replay needs the run's HOME / CLAUDE_CONFIG_DIR.
// stdout carries one result object in the `json` format
// (src/headless/result.ts), written on every outcome; logs go to stderr.

import { EXIT_CODES, bareResult, renderResult, type HeadlessResult } from './result.ts';
import { headlessUiLines, type HeadlessBoot } from './entry.ts';
import { HEADLESS_SYNOPSIS } from './args.ts';
import { readHeadlessRun } from './lastRun.ts';
import { loadSessions, resolveOwner, type SessionIndex } from '../sessionStore.ts';
import { RootLockHeldError, RootLockUnreadableError } from '../rootLock.ts';
import { errMsg } from '../../shared/basics.ts';

// What every create() of a replay's manager answers (409).
export const VIEW_NO_LAUNCH = { code: 'VIEW_REPLAY_NO_LAUNCH', message: 'a --view replay starts no session' } as const;

export interface ViewSessionDeps {
  requested: string | null;
  readLastRun: () => Promise<{ sessionId: string } | null>;
  loadIndex: () => Promise<SessionIndex>;
}

/** The public session id a replay shows, or the refusal's message. */
export async function resolveViewSession({ requested, readLastRun, loadIndex }: ViewSessionDeps): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const index = await loadIndex();
  if (requested !== null) {
    const owner = resolveOwner(index, requested);
    return owner === null
      ? { ok: false, message: `no session '${requested}' in this root's session store` }
      : { ok: true, sessionId: owner };
  }
  let last: { sessionId: string } | null;
  try { last = await readLastRun(); }
  catch (e) { return { ok: false, message: errMsg(e) }; }
  if (last === null) return { ok: false, message: 'no headless run has recorded a session on this root; pass --session <id>' };
  const owner = resolveOwner(index, last.sessionId);
  return owner === null
    ? { ok: false, message: `the last headless run's session ${last.sessionId} is no longer in this root's session store` }
    : { ok: true, sessionId: owner };
}

export interface ViewEntryDeps {
  // server.ts's start(), already given the replay options.
  start: () => Promise<HeadlessBoot>;
}

export async function viewMain(args: { session: string | null }, { start }: ViewEntryDeps): Promise<void> {
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let chosen: string | null = null;
  let written = false;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  const finish = (r: HeadlessResult): void => {
    if (written) return;
    written = true;
    for (const s of ['SIGINT', 'SIGTERM'] as const) process.off(s, onSignal);
    writeOut(renderResult(r, 'json').stdout, (err?: Error | null) => {
      if (err) process.stderr.write(`headless: the result was not delivered: stdout closed (${(err as NodeJS.ErrnoException).code ?? errMsg(err)})\n`);
      exitOnce(r.exitCode);
    });
  };
  // The replay's normal end.
  function onSignal(signal: NodeJS.Signals): void {
    console.error(`headless: ${signal}; stopping the viewer`);
    finish({ ...bareResult('stopped', `stopped by ${signal}`, EXIT_CODES.stopped), sessionId: chosen, error: null });
  }
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, onSignal);
  const fail = (e: unknown): void => {
    console.error('headless: unexpected failure:', e);
    finish(bareResult('boot_failed', `the viewer failed: ${errMsg(e)}`, EXIT_CODES.boot_failed));
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  try {
    let boot: HeadlessBoot;
    try {
      boot = await start();
    } catch (e) {
      if (e instanceof RootLockHeldError || e instanceof RootLockUnreadableError) {
        console.error(e.message);
        finish(bareResult('root_held', e.message, EXIT_CODES.root_held));
      } else {
        console.error('failed to start:', e);
        finish(bareResult('boot_failed', `failed to start: ${errMsg(e)}`, EXIT_CODES.boot_failed));
      }
      return;
    }
    if (written) return;
    const pick = await resolveViewSession({ requested: args.session, readLastRun: readHeadlessRun, loadIndex: loadSessions });
    if (written) return;
    if (!pick.ok) {
      process.stderr.write(`${pick.message}\n${HEADLESS_SYNOPSIS}\n`);
      finish(bareResult('no_session', pick.message, EXIT_CODES.no_session));
      return;
    }
    if (!boot.focus) throw new Error('the server booted without a focus cell');
    chosen = pick.sessionId;
    boot.focus.sessionId = chosen;
    console.log(`code-conductor listening on http://${boot.host}:${boot.port}`);
    console.log(`headless: viewing session ${chosen} (view-only)`);
    for (const line of headlessUiLines(boot.host, boot.port)) console.log(line);
    // Serve until a signal: the listening server keeps the process alive.
  } catch (e) {
    fail(e);
  }
}
