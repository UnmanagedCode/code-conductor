// The relaunch behind POST /api/admin/restart. Spawns a detached child node
// process with the same argv/env/cwd and exits this one, so editing server code
// + clicking the sidebar's "Restart server" button reloads everything without
// the user having to ctrl+C in their shell.
//
// runRestart drives it, in two modes:
//   - plain: archive temps and stop the instances (teardownInstances), close the
//     WS + HTTP servers (teardownNetworking), spawn the replacement, exit;
//   - resume: drain every live turn to idle and write the resume manifest
//     (src/resumeRestart.ts) instead of stopping the instances outright.
// Before either, the relaunch is prepared in THIS process (src/relaunchPrep.ts):
// node_modules is installed when it differs from package-lock.json and the web
// build is staged. A failed step refuses the relaunch, so cc keeps serving.
//
// The replacement polls EADDRINUSE while binding (listenWithRetry in
// server.ts), which handles the race where our listening socket hasn't fully
// released yet.
import { spawn } from 'node:child_process';
import { hostPlatform } from './platform/index.ts';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { writePendingTempCleanup } from './tempCleanup.ts';
import { orphanedTempIdsSync } from './sessionStore.ts';
import { retireSegments } from './sessionLineage.ts';
import { drainToIdle, finishDrain, abortDrain } from './resumeRestart.ts';
import { relaunchPrep, type RelaunchPrep } from './relaunchPrep.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

// The InstanceManager surface the plain restart path reads. Every method is
// optional because runTempCleanup/teardownInstances guard each call (the
// routes inject the real manager; tests pass stubs). `tempCleanupSnapshot`
// returns {cwd, sessionId} rows — only sessionId is consumed here.
interface RestartManagerLike {
  shutdownTempSync?(): void;
  tempCleanupSnapshot?(): Array<{ sessionId: string }>;
  shutdown?(): Promise<unknown> | void;
  stopLiveSync?(): void;
}

interface RestartLog {
  warn?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

// Archive every temp session on a plain restart: live-attached ones (via
// instances.shutdownTempSync()) AND crash-orphaned ones: a temp segment in the
// session store with no live instance (e.g. a prior hard crash).
// Kept separate from teardownInstances so it's
// directly unit-testable, mirroring how shutdownTempSync/writePendingTempCleanup
// /sweepPendingTempCleanup are already tested standalone.
export function runTempCleanup({ instances, log = console }: { instances?: RestartManagerLike | null; log?: RestartLog } = {}): void {
  if (!instances || typeof instances.shutdownTempSync !== 'function') return;

  // Capture the temp session set *before* shutdownTempSync runs, then
  // write a manifest that the next boot will replay. This is defence
  // in depth: orphaned subagent processes (claude forks them for Task
  // calls, we don't track them) can keep writing to the jsonl after
  // our parent has exited, so the in-process cleanup alone isn't
  // enough — the post-restart sweep wipes anything that reappeared.
  let snapshot: Array<{ sessionId: string }> = [];
  try {
    if (typeof instances.tempCleanupSnapshot === 'function') {
      snapshot = instances.tempCleanupSnapshot();
    }
  } catch (e) { log.warn?.('restart: temp snapshot error', e); }

  // Synchronously delete temp session jsonls + subagents dirs before
  // we exit — `_handleExit()`'s async cleanup races process.exit(),
  // so without this the temp jsonls survive the restart and reappear
  // in the sidebar as ordinary persistent sessions.
  try { instances.shutdownTempSync(); }
  catch (e) { log.warn?.('restart: temp cleanup error', e); }

  // Crash-orphaned temp sessions: a temp segment in the session store with no
  // live instance, so the kill/wipe loop above never sees them. There's no
  // placement on record for a segment, so there's no subagents dir to
  // locate/clean — just the store bookkeeping, in one write.
  let orphanedIds: string[] = [];
  try {
    orphanedIds = orphanedTempIdsSync(snapshot.map((e) => e.sessionId));
  } catch (e) { log.warn?.('restart: orphaned temp lookup error', e); }
  retireSegments(orphanedIds).catch(() => {});

  try {
    writePendingTempCleanup([...snapshot, ...orphanedIds.map((sessionId) => ({ sessionId }))]);
  } catch (e) { log.warn?.('restart: pending-cleanup manifest write failed', e); }
}

// A plain restart's end for the instances: archive temps (runTempCleanup), stop
// live CLIs, and fire the manager's shutdown. Synchronous up to the shutdown,
// which is fire-and-forget: the replacement must not wait on it.
export function teardownInstances({ instances, log = console }: { instances?: RestartManagerLike | null; log?: RestartLog } = {}): void {
  try {
    runTempCleanup({ instances, log });
    // Where SIGTERM is not soft, the CLI's children would outlive the exit.
    try { instances?.stopLiveSync?.(); }
    catch (e) { log.warn?.('restart: live stop error', e); }
    if (instances && typeof instances.shutdown === 'function') {
      // Captured before the closure so the narrowed function isn't lost (TS
      // re-widens property accesses inside closures).
      const shutdown = instances.shutdown;
      Promise.resolve().then(() => shutdown()).catch(() => {});
    }
  } catch (e) {
    log.warn?.('restart: instance teardown error', e);
  }
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

/**
 * One relaunch, prepared first. INVARIANT: the shared node_modules is changed
 * only once no session is in a turn, and when it needs no change every failure
 * is found before any session is touched:
 *
 * - in sync: stage the web build, then tear down and relaunch;
 * - plain + drift: stop the instances (the user chose to drop them), install,
 *   stage, then close networking and relaunch;
 * - resume + drift: drain to idle, install, stage, then close networking,
 *   finish the drain and relaunch — a failure there hands the sessions back
 *   (abortDrain) with networking still up.
 *
 * A failure throws and nothing is relaunched. `onCommit` fires once the
 * relaunch can no longer be refused, before networking goes down, so the caller
 * can still answer its client. `flags` turn steps off: `buildWeb` the stage,
 * `syncDeps` the dependency check.
 */
export async function runRestart({
  mode, ctx, flags, prep = relaunchPrep, onChunk = () => {}, onCommit, spawnAndExit = spawnReplacementAndExit,
}: {
  mode: 'plain' | 'resume';
  ctx: RestartCtx;
  flags: { buildWeb: boolean; syncDeps: boolean };
  prep?: RelaunchPrep;
  onChunk?: (phase: RestartPhase, text: string) => void;
  onCommit?: () => void;
  spawnAndExit?: (opts: { log?: RestartLog }) => void;
}): Promise<void> {
  const log = ctx.log ?? console;
  const drift = flags.syncDeps ? prep.drift() : null;
  const stage = async () => {
    if (!flags.buildWeb) return;
    onChunk('build', 'Building the web UI if its sources changed\n');
    await prep.stageWeb((t) => onChunk('build', t));
  };
  const install = async () => {
    onChunk('deps', `node_modules is out of sync with package-lock.json (${drift!.reason}) — running npm install\n`);
    await prep.installDeps((t) => onChunk('npm', t));
  };
  if (!drift) await stage();

  const { instances } = ctx;
  if (mode === 'resume' && instances) {
    onChunk('drain', 'Winding live sessions down to idle\n');
    const idle = await drainToIdle({ instances, log, graceMs: ctx.graceMs });
    if (drift) {
      try { await install(); await stage(); }
      catch (e) { abortDrain({ instances, log }, idle); throw e; }
    }
    onCommit?.();
    teardownNetworking(ctx);
    finishDrain({ instances, log }, idle);
  } else {
    if (mode === 'plain') teardownInstances({ instances, log });
    if (drift) { await install(); await stage(); }
    onCommit?.();
    teardownNetworking(ctx);
  }
  spawnAndExit({ log });
}

// Spawn a detached replacement node process (same execPath + argv + cwd + env)
// and exit this one after a short delay so the response just ended can flush.
// The child's listen-with-retry (server.ts) handles the EADDRINUSE race while
// our socket releases.
export function spawnReplacementAndExit({ log = console }: { log?: RestartLog } = {}): void {
  const args = [process.argv[1], ...process.argv.slice(2)];
  try {
    const child = spawn(process.execPath, args, {
      ...hostPlatform.spawnOptions('daemon'),
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    log.log?.(`restart: spawned replacement pid=${child.pid}; exiting current pid=${process.pid}`);
  } catch (e) {
    log.error?.('restart: spawn failed', e);
    // No replacement — don't exit, or the user is left with a dead app.
    return;
  }

  setTimeout(() => process.exit(0), 50);
}
