// The `--replay` process: what `node server.ts --replay [--session <id>]
// [--ui <mode>]` does (src/headless/args.ts). cc boots as a headless server —
// no web build, no resume restore — over a finished run's root, focused on that
// run's session, and serves until a signal.
//   - `--ui view` (the default) is launchless: its InstanceManager refuses
//     every create() (REPLAY_NO_LAUNCH), and its boot starts no plugin backend
//     and forks no CLI.
//   - `--ui interact` / `--ui full` boot a working conductor: the root can be
//     resumed, and spawn, merge and land. The resumed root's tool asks get the
//     headless answers (src/headless/replayRoot.ts), and a signal while it is
//     mid-turn forces its interrupt first (src/headless/rootPolicy.ts).
// The ended session reads from its transcript on disk, so the replay needs the
// run's HOME / CLAUDE_CONFIG_DIR. stdout carries one result object in the
// `json` format (src/headless/result.ts), written on every outcome; logs go
// to stderr.

import { EXIT_CODES, bareResult, renderResult, type HeadlessResult } from './result.ts';
import { headlessUiLines, type HeadlessBoot } from './entry.ts';
import { ENTRY_SYNOPSIS } from './args.ts';
import { forceInterrupt } from './rootPolicy.ts';
import { watchReplayRoot } from './replayRoot.ts';
import type { UiMode } from '../../shared/uiMode.ts';
import { readHeadlessRun } from './lastRun.ts';
import { loadSessions, resolveOwner, type SessionIndex } from '../sessionStore.ts';
import { RootLockHeldError, RootLockUnreadableError } from '../rootLock.ts';
import { errMsg } from '../../shared/basics.ts';

// What every create() of a launchless replay's manager answers (409).
export const REPLAY_NO_LAUNCH = { code: 'VIEW_REPLAY_NO_LAUNCH', message: 'a --replay under --ui view starts no session' } as const;

export interface ReplaySessionDeps {
  requested: string | null;
  readLastRun: () => Promise<{ sessionId: string } | null>;
  loadIndex: () => Promise<SessionIndex>;
}

/** The public session id a replay shows, or the refusal's message. */
export async function resolveReplaySession({ requested, readLastRun, loadIndex }: ReplaySessionDeps): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
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

export interface ReplayEntryDeps {
  // server.ts's start(), already given the replay options.
  start: () => Promise<HeadlessBoot>;
}

export async function replayMain(args: { session: string | null; ui: UiMode }, { start }: ReplayEntryDeps): Promise<void> {
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let chosen: string | null = null;
  let boot: HeadlessBoot | null = null;
  let rootWatch: { detach(): void } | null = null;
  let stopping = false;
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
    rootWatch?.detach();
    writeOut(renderResult(r, 'json').stdout, (err?: Error | null) => {
      if (err) process.stderr.write(`headless: the result was not delivered: stdout closed (${(err as NodeJS.ErrnoException).code ?? errMsg(err)})\n`);
      exitOnce(r.exitCode);
    });
  };
  // The replay's normal end. A root resumed mid-turn (only under interact /
  // full: a launchless replay has none) is force-interrupted first, waiting at
  // most INTERRUPT_WAIT_MS; a second signal during that wait ends at once.
  function onSignal(signal: NodeJS.Signals): void {
    const stopped = (): void => finish({ ...bareResult('stopped', `stopped by ${signal}`, EXIT_CODES.stopped), sessionId: chosen, error: null });
    if (stopping) { stopped(); return; }
    stopping = true;
    console.error(`headless: ${signal}; stopping the replay`);
    const root = chosen !== null ? boot?.instances?.liveForSession(chosen) ?? null : null;
    if (root?.status !== 'turn') { stopped(); return; }
    void forceInterrupt(root).then(stopped, fail);
  }
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, onSignal);
  const fail = (e: unknown): void => {
    console.error('headless: unexpected failure:', e);
    finish(bareResult('boot_failed', `the replay failed: ${errMsg(e)}`, EXIT_CODES.boot_failed));
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  try {
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
    const pick = await resolveReplaySession({ requested: args.session, readLastRun: readHeadlessRun, loadIndex: loadSessions });
    if (written) return;
    if (!pick.ok) {
      process.stderr.write(`${pick.message}\n${ENTRY_SYNOPSIS}\n`);
      finish(bareResult('no_session', pick.message, EXIT_CODES.no_session));
      return;
    }
    if (!boot.focus) throw new Error('the server booted without a focus cell');
    chosen = pick.sessionId;
    boot.focus.sessionId = chosen;
    console.log(`code-conductor listening on http://${boot.host}:${boot.port}`);
    console.log(`headless: replaying session ${chosen} (--ui ${args.ui})`);
    for (const line of headlessUiLines(boot.host, boot.port)) console.log(line);
    // A replay that can launch: the resumed root answers its asks with no person present.
    if (args.ui !== 'view' && boot.instances) {
      rootWatch = watchReplayRoot({ instances: boot.instances, sessionId: chosen, log: (line) => console.error(line) });
    }
    // Serve until a signal: the listening server keeps the process alive.
  } catch (e) {
    fail(e);
  }
}
