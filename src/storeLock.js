// Cross-process advisory lock for sidecar JSON stores.
//
// Uses an O_EXCL lockfile (atomic create — fails with EEXIST if another
// process already holds the lock) to serialise read-modify-write mutations
// across concurrent Node processes on the same machine.
//
// Stale-lock detection: if the lock file is older than LOCK_STALE_MS or the
// owning PID is no longer alive, the lock is considered abandoned and removed
// so the next caller can proceed.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 10_000; // 10 s — generous for slow file-systems
const LOCK_RETRY_MAX = 25;
const LOCK_RETRY_BASE_MS = 30;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Returns false only when the process definitely does not exist (ESRCH).
// EPERM (process exists but we have no permission to signal it) → alive.
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt++) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, throws EEXIST if held
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        await fh.close();
      }
      return; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Lock already held — check staleness before backing off
      try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const { pid, ts } = JSON.parse(raw);
        const stale = (Date.now() - ts) > LOCK_STALE_MS || !isProcessAlive(pid);
        if (stale) {
          // Race: two waiters may both decide stale simultaneously; the unlink
          // that loses is harmless (ENOENT swallowed).
          await fs.unlink(lockPath).catch(() => {});
          continue; // retry immediately after clearing the stale lock
        }
      } catch {
        // Lock file disappeared or is unreadable — just retry
      }

      if (attempt >= LOCK_RETRY_MAX) {
        throw new Error(
          `storeLock: could not acquire ${path.basename(lockPath)} after ${LOCK_RETRY_MAX} retries`,
        );
      }

      // Exponential backoff with ±20 % jitter
      const base = LOCK_RETRY_BASE_MS * Math.pow(1.5, attempt);
      await sleep(Math.min(base * (0.8 + 0.4 * Math.random()), 500));
    }
  }
}

// Acquire an exclusive advisory lock scoped to `dataFile`, run `fn()`, then
// release. The lock file is `dataFile + '.lock'`. The containing directory is
// created if it does not exist yet.
export async function withLock(dataFile, fn) {
  const lockPath = dataFile + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}
