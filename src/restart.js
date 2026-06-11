// Self-respawn handler for POST /api/admin/restart. Spawns a detached
// child node process with the same argv/env/cwd and exits this one, so
// editing server code + clicking the sidebar's "Restart server" button
// reloads everything without the user having to ctrl+C in their shell.
//
// Mechanics:
//   1. Close the WebSocket server and terminate any held-open sockets
//      (the PreToolUse hook callbacks hang up to 540 s otherwise).
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
import { writePendingTempCleanup } from './tempCleanup.js';

export function scheduleRestart({ server, wss, instances, log = console } = {}) {
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
    if (instances && typeof instances.shutdownTempSync === 'function') {
      // Capture the temp session set *before* shutdownTempSync runs, then
      // write a manifest that the next boot will replay. This is defence
      // in depth: orphaned subagent processes (claude forks them for Task
      // calls, we don't track them) can keep writing to the jsonl after
      // our parent has exited, so the in-process cleanup alone isn't
      // enough — the post-restart sweep wipes anything that reappeared.
      let snapshot = [];
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

      try { writePendingTempCleanup(snapshot); }
      catch (e) { log.warn?.('restart: pending-cleanup manifest write failed', e); }
    }
    if (instances && typeof instances.shutdown === 'function') {
      // Fire-and-forget — instance subprocesses outlive us.
      Promise.resolve().then(() => instances.shutdown()).catch(() => {});
    }
  } catch (e) {
    log.warn?.('restart: pre-spawn cleanup error', e);
  }

  spawnReplacementAndExit({ log });
}

// Spawn a detached replacement node process (same execPath + argv + cwd + env)
// and exit this one after a short delay so the in-flight 202 response can flush.
// Shared by the normal restart (scheduleRestart) and the graceful resume restart
// (src/resumeRestart.js drainAndScheduleRestart). The child's listen-with-retry
// (server.js) handles the EADDRINUSE race while our socket releases.
export function spawnReplacementAndExit({ log = console } = {}) {
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
