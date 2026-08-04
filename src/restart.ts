// Self-respawn handler for POST /api/admin/restart. Spawns a detached
// child node process with the same argv/env/cwd and exits this one, so
// editing server code + clicking the sidebar's "Restart server" button
// reloads everything without the user having to ctrl+C in their shell.
//
// Mechanics:
//   1. Close the WebSocket server and terminate any held-open sockets
//      (the PreToolUse hook callbacks hang up to `HOOK_PENDING_TIMEOUT_MS` otherwise).
//   2. Stop accepting new HTTP connections.
//   3. Best-effort shutdown of attached instance subprocesses' stdin
//      so they don't lose buffered writes; the subprocesses themselves
//      survive — they're independent processes, not children of this
//      orchestrator after the respawn.
//   4. Spawn a detached replacement (process.execPath + the same argv
//      + cwd + env). The child polls EADDRINUSE while binding (see
//      listenWithRetry in server.js), which handles the race where
//      our listening socket hasn't fully released yet.
//   5. Exit this process after a small delay so the 202 response can
//      flush over the wire.
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { writePendingTempCleanup } from './tempCleanup.ts';
import { orphanedTempIdsSync, unmarkTemp } from './tempSessions.ts';
import { markArchived } from './archivedSessions.ts';

// The InstanceManager surface the restart path reads. Every method is
// optional because runTempCleanup/scheduleRestart guard each call (the
// routes inject the real manager; tests pass stubs). `tempCleanupSnapshot`
// returns {cwd, sessionId} rows — only sessionId is consumed here.
interface RestartManagerLike {
  shutdownTempSync?(): void;
  tempCleanupSnapshot?(): Array<{ sessionId: string }>;
  shutdown?(): Promise<unknown> | void;
}

interface RestartLog {
  warn?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

// Archive every temp session on a plain restart: live-attached ones (via
// instances.shutdownTempSync()) AND crash-orphaned ones that are recorded in
// temp-sessions.json but have no live instance (e.g. a prior hard crash).
// Kept separate from scheduleRestart (no process.exit inside) so it's
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

  // Crash-orphaned temp sessions: recorded in temp-sessions.json but with no
  // live instance, so the kill/wipe loop above never sees them. There's no
  // cwd on record for these (temp-sessions.json stores sessionIds only), so
  // there's no subagents dir to locate/clean — just the sidecar bookkeeping.
  let orphanedIds: string[] = [];
  try {
    orphanedIds = orphanedTempIdsSync(snapshot.map((e) => e.sessionId));
  } catch (e) { log.warn?.('restart: orphaned temp lookup error', e); }
  for (const sid of orphanedIds) {
    unmarkTemp(sid).catch(() => {});
    markArchived(sid).catch(() => {});
  }

  try {
    writePendingTempCleanup([...snapshot, ...orphanedIds.map((sessionId) => ({ sessionId }))]);
  } catch (e) { log.warn?.('restart: pending-cleanup manifest write failed', e); }
}

export function scheduleRestart({ server, wss, instances, log = console }: {
  server?: Server | null; wss?: WebSocketServer | null; instances?: RestartManagerLike | null; log?: RestartLog;
} = {}): void {
  // Don't await any of this; the response was already sent before we
  // got called, and waiting for server.close() would block on the
  // very WS connections we're about to terminate.
  try {
    if (wss) {
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      try { wss.close(); } catch { /* ignore */ }
    }
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
    runTempCleanup({ instances, log });
    if (instances && typeof instances.shutdown === 'function') {
      // Fire-and-forget — instance subprocesses outlive us. Captured before
      // the closure so the narrowed function isn't lost (TS re-widens
      // property accesses inside closures).
      const shutdown = instances.shutdown;
      Promise.resolve().then(() => shutdown()).catch(() => {});
    }
  } catch (e) {
    log.warn?.('restart: pre-spawn cleanup error', e);
  }

  spawnReplacementAndExit({ log });
}

// Spawn a detached replacement node process (same execPath + argv + cwd + env)
// and exit this one after a short delay so the in-flight 202 response can flush.
// Shared by the normal restart (scheduleRestart) and the graceful resume restart
// (src/resumeRestart.ts drainAndScheduleRestart). The child's listen-with-retry
// (server.js) handles the EADDRINUSE race while our socket releases.
export function spawnReplacementAndExit({ log = console }: { log?: RestartLog } = {}): void {
  const args = [process.argv[1], ...process.argv.slice(2)];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
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
