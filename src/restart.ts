// The relaunch behind POST /api/admin/restart and the stop behind
// POST /api/admin/shutdown — the sidebar power menu's Restart and Shut down.
//
// runRestart drives both. Each drains every live turn to idle and writes the
// resume manifest (src/resumeRestart.ts), so the next boot restores the same
// sessions; then a restart spawns a replacement node process with the same
// argv/env/cwd and exits (under a restart supervisor it exits with the
// supervisor's relaunch code instead), and a shutdown exits with nothing to
// replace it (under a supervisor, with the code that parks it).
// Before a restart drains, the relaunch is prepared in THIS process
// (src/relaunchPrep.ts): node_modules is installed when it does not satisfy
// package.json and the web build is staged. A failed step refuses the
// relaunch, so cc keeps serving.
//
// The replacement polls EADDRINUSE while binding (listenWithRetry in
// server.ts), which handles the race where our listening socket hasn't fully
// released yet.
import { spawn } from 'node:child_process';
import { hostPlatform } from './platform/index.ts';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { drainToIdle, finishDrain, abortDrain } from './resumeRestart.ts';
import { relaunchPrep, type RelaunchPrep } from './relaunchPrep.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';
import type { Deliver } from './resumeManifest.ts';
import type { RunningRecorder } from './runningRecord.ts';
import { SUPERVISED_RESTART_EXIT, SUPERVISED_SHUTDOWN_EXIT } from './restartSupervisor.ts';
import { ROOT_LOCK_HANDOVER_ENV, ROOT_LOCK_HANDOVER_WAIT_MS, type RootLock } from './rootLock.ts';
import { mintLockToken } from './storeLock.ts';

interface RestartLog {
  warn?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

// Close the WebSocket server (terminating held-open sockets) and stop accepting
// HTTP connections. Not awaited: server.close() would wait on the very
// connections being terminated.
export function teardownNetworking({ server, wss }: { server?: Server | null; wss?: WebSocketServer | null } = {}): void {
  if (wss) {
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    try { wss.close(); } catch { /* ignore */ }
  }
  if (server) { try { server.close(); } catch { /* ignore */ } }
}

export type RestartPhase = 'deps' | 'npm' | 'build' | 'drain';

export interface RestartCtx {
  server?: Server | null;
  wss?: WebSocketServer | null;
  instances?: InstanceManagerLike | null;
  log?: RestartLog;
  graceMs?: number;
}

export type ExitForShutdown = (opts: { log?: RestartLog; rootLock?: RootLock | null; supervised?: boolean }) => void | Promise<void>;

/**
 * One Restart or Shut down. Both drain every live turn to idle and finish the
 * drain into the resume manifest (`deliver` says how the next boot delivers
 * the continue notices; a shutdown's is always `gated`). The running recorder
 * is paused for the drain, so the closing CLIs' status events cannot rewrite
 * the record finishDrain removes after stopping them.
 *
 * A restart is prepared first. When node_modules needs no change every failure
 * is found before any session is touched:
 *
 * - in sync: stage the web build, then drain, close networking, finish the
 *   drain and relaunch;
 * - drift: drain to idle, install, stage, then close networking, finish the
 *   drain and relaunch — a failure there hands the sessions back (abortDrain)
 *   with networking still up, and the recorder resumes.
 *
 * A shutdown prepares nothing: it drains, closes networking, finishes the
 * drain and exits through `exitForShutdown`.
 *
 * A failure throws and nothing is relaunched. `onCommit` fires once the step
 * can no longer be refused, before networking goes down, so the caller can
 * still answer its client. `flags` turn steps off: `buildWeb` the stage,
 * `syncDeps` the dependency check.
 */
export async function runRestart({
  action, deliver = 'gated', ctx, flags, prep = relaunchPrep, onChunk = () => {}, onCommit,
  spawnAndExit = spawnReplacementAndExit, exitForShutdown = exitAfterShutdown, rootLock = null, supervised = false, recorder = null,
}: {
  action: 'restart' | 'shutdown';
  // How the next boot delivers the continue notices of a restart.
  deliver?: Deliver;
  ctx: RestartCtx;
  flags: { buildWeb: boolean; syncDeps: boolean };
  prep?: RelaunchPrep;
  onChunk?: (phase: RestartPhase, text: string) => void;
  onCommit?: () => void;
  spawnAndExit?: (opts: { log?: RestartLog; rootLock?: RootLock | null; supervised?: boolean }) => void | Promise<void>;
  exitForShutdown?: ExitForShutdown;
  // The projects-root lock this server holds, handed over to the replacement.
  rootLock?: RootLock | null;
  // A restart supervisor relaunches this server: exit for it instead of spawning.
  supervised?: boolean;
  recorder?: Pick<RunningRecorder, 'pause' | 'resume'> | null;
}): Promise<void> {
  const log = ctx.log ?? console;
  const { instances } = ctx;
  const drain = async () => {
    recorder?.pause();
    onChunk('drain', 'Winding live sessions down to idle\n');
    return drainToIdle({ instances: instances!, log, graceMs: ctx.graceMs });
  };

  if (action === 'shutdown') {
    const idle = instances ? await drain() : null;
    onCommit?.();
    teardownNetworking(ctx);
    if (instances && idle) finishDrain({ instances, log }, idle, { deliver: 'gated' });
    await exitForShutdown({ log, rootLock, supervised });
    return;
  }

  const drift = flags.syncDeps ? prep.drift() : null;
  const stage = async () => {
    if (!flags.buildWeb) return;
    onChunk('build', 'Building the web UI if its sources changed\n');
    await prep.stageWeb((t) => onChunk('build', t));
  };
  const install = async () => {
    onChunk('deps', `node_modules does not satisfy package.json (${drift!.reason}) — running npm install\n`);
    await prep.installDeps((t) => onChunk('npm', t));
  };
  if (!drift) await stage();

  if (instances) {
    const idle = await drain();
    if (drift) {
      try { await install(); await stage(); }
      catch (e) { abortDrain({ instances, log }, idle); recorder?.resume(); throw e; }
    }
    onCommit?.();
    teardownNetworking(ctx);
    finishDrain({ instances, log }, idle, { deliver });
  } else {
    if (drift) { await install(); await stage(); }
    onCommit?.();
    teardownNetworking(ctx);
  }
  await spawnAndExit({ log, rootLock, supervised });
}

// The end of a shutdown: release the projects-root lock and exit — 0, or
// SUPERVISED_SHUTDOWN_EXIT under a restart supervisor, which parks rather than
// relaunching or exiting (src/restartSupervisor.ts).
export async function exitAfterShutdown({
  log = console, rootLock = null, supervised = false, exit = (code: number) => process.exit(code),
}: { log?: RestartLog; rootLock?: RootLock | null; supervised?: boolean; exit?: (code: number) => void } = {}): Promise<void> {
  rootLock?.releaseSync();
  const code = supervised ? SUPERVISED_SHUTDOWN_EXIT : 0;
  log.log?.(`shutdown: exiting pid=${process.pid} with ${code}`);
  await new Promise<void>(r => setTimeout(r, 50));
  exit(code);
}

// The supervised relaunch: release the projects-root lock and exit with the
// code the supervisor relaunches on (src/restartSupervisor.ts). No offer and no
// adoption wait: this process is gone before the replacement starts, so two
// servers never hold the root at once.
export async function exitToSupervisor({
  log = console, rootLock = null, exit = (code: number) => process.exit(code),
}: { log?: RestartLog; rootLock?: RootLock | null; exit?: (code: number) => void } = {}): Promise<void> {
  rootLock?.releaseSync();
  log.log?.(`restart: exiting pid=${process.pid} with ${SUPERVISED_RESTART_EXIT} for the restart supervisor to relaunch`);
  await new Promise<void>(r => setTimeout(r, 50));
  exit(SUPERVISED_RESTART_EXIT);
}

// Spawn a detached replacement node process (same execPath + argv + cwd + env)
// and exit this one. The child's listen-with-retry (server.ts) handles the
// EADDRINUSE race while our socket releases.
//
// With a root lock the lock is handed over, never dropped: the offer is
// written into our record BEFORE the spawn, and this process — whose lock
// socket keeps answering — exits only once the child has taken the next
// generation (or the wait runs out). Exiting first would leave a record naming
// a dead socket, and a third server could take the root in that gap.
//
// The relaunch is committed by now (networking is down), so an offer that
// cannot be written must not strand a process serving nothing: the lock is
// released instead and the child takes the root like any boot, which leaves
// that one gap open rather than leaving no app at all.
export async function spawnReplacementAndExit({
  log = console, rootLock = null, spawnChild = spawn, exit = (code: number) => process.exit(code),
  handoverWaitMs = ROOT_LOCK_HANDOVER_WAIT_MS, supervised = false,
}: {
  log?: RestartLog; rootLock?: RootLock | null; supervised?: boolean;
  spawnChild?: typeof spawn; exit?: (code: number) => void; handoverWaitMs?: number;
} = {}): Promise<void> {
  if (supervised) return exitToSupervisor({ log, rootLock, exit });
  const args = [process.argv[1], ...process.argv.slice(2)];
  let next: string | null = null;
  if (rootLock) {
    const offer = mintLockToken();
    try {
      if (rootLock.offerHandover(offer)) next = offer;
      else log.warn?.('restart: the projects-root lock record is no longer ours; relaunching without a handover');
    } catch (e) {
      log.warn?.('restart: could not offer the projects-root lock to the replacement; releasing it instead', e);
    }
    if (!next) rootLock.releaseSync();
  }
  const handingOver = rootLock !== null && next !== null;
  const childExited = new AbortController();
  try {
    const child = spawnChild(process.execPath, args, {
      ...hostPlatform.spawnOptions('daemon'),
      stdio: 'inherit',
      cwd: process.cwd(),
      env: next ? { ...process.env, [ROOT_LOCK_HANDOVER_ENV]: next } : process.env,
    });
    child.once('exit', () => childExited.abort());
    child.unref();
    log.log?.(`restart: spawned replacement pid=${child.pid}; exiting current pid=${process.pid}`);
  } catch (e) {
    log.error?.('restart: spawn failed', e);
    // Networking is already down, so this process serves nothing: let the next
    // server that starts take the root (releasing also drops the offer).
    if (handingOver) rootLock?.releaseSync();
    // No replacement — don't exit, or the user is left with a dead app.
    return;
  }

  const minExit = new Promise<void>(r => setTimeout(r, 50));
  if (rootLock && handingOver) {
    // The relaunch is committed: whatever the wait reports, this process exits.
    const adopted = await rootLock.awaitAdoption({ timeoutMs: handoverWaitMs, signal: childExited.signal })
      .catch((e: unknown) => { log.warn?.('restart: reading the projects-root lock failed', e); return false; });
    if (!adopted) log.warn?.('restart: the replacement did not adopt the projects-root lock; exiting anyway');
  }
  await minExit;
  exit(0);
}
