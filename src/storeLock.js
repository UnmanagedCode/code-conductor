// Cross-process advisory lock for sidecar JSON stores.
//
// Uses an O_EXCL lockfile (atomic create — fails with EEXIST if another
// process already holds the lock) to serialise read-modify-write mutations
// across concurrent Node processes on the same machine.
//
// Reclaiming a held lock — ONLY when the owning PID is no longer alive.
// A live owner is NEVER evicted on age alone. On Termux the CPU is heavily
// throttled after a restart (documented 10–75×), so a live holder can be
// starved on the event loop for many seconds between acquiring the lock and
// finishing its tiny read-modify-write. Evicting such a live holder lets a
// second process enter the critical section concurrently, and the two racing
// writers drop each other's entries (a classic lost update) — this was the
// cause of archived sessions silently un-archiving around restarts. So PID
// liveness is authoritative: a slow holder is waited out via bounded retries,
// and a truly wedged holder surfaces as a thrown acquire error rather than
// silent data loss.
//
// Release is ownership-checked: a process removes the lockfile only if it still
// carries that process's unique token, so it can never delete a successor's
// lock (which, after a dead-owner reclaim, would collapse mutual exclusion).

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Bounded wait for a live owner to release. Env-tunable so tests can drive the
// timing deterministically and unusually slow filesystems get headroom.
const LOCK_RETRY_MAX = Number(process.env.ORCH_STORE_LOCK_RETRY_MAX) || 25;
const LOCK_RETRY_BASE_MS = Number(process.env.ORCH_STORE_LOCK_RETRY_BASE_MS) || 30;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Returns false only when the process definitely does not exist (ESRCH).
// EPERM (process exists but we have no permission to signal it) → alive.
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

let tokenCounter = 0;

// Acquire the lock; returns a unique ownership token to hand back to releaseLock.
async function acquireLock(lockPath) {
  const token = `${process.pid}-${Date.now()}-${tokenCounter++}`;
  for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt++) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, throws EEXIST if held
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now(), token }));
      } finally {
        await fh.close();
      }
      return token; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Lock already held — reclaim ONLY if the owner is gone (dead PID). A
      // live owner is respected no matter how old/slow (see file header).
      try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const { pid } = JSON.parse(raw);
        if (!isProcessAlive(pid)) {
          // Race: two waiters may both decide to reclaim simultaneously; the
          // unlink that loses is harmless (ENOENT swallowed).
          await fs.unlink(lockPath).catch(() => {});
          continue; // retry immediately after clearing the dead owner's lock
        }
      } catch {
        // Lock file disappeared or is unreadable — just retry.
      }

      if (attempt >= LOCK_RETRY_MAX) {
        throw new Error(
          `storeLock: could not acquire ${path.basename(lockPath)} after ${LOCK_RETRY_MAX} retries (owner still alive)`,
        );
      }

      // Exponential backoff with ±20 % jitter
      const base = LOCK_RETRY_BASE_MS * Math.pow(1.5, attempt);
      await sleep(Math.min(base * (0.8 + 0.4 * Math.random()), 500));
    }
  }
}

// Remove the lockfile only if we still own it (token match). After a dead-owner
// reclaim a successor may now hold the lock under a fresh token; this prevents
// us from deleting theirs.
async function releaseLock(lockPath, token) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const obj = JSON.parse(raw);
    if (obj?.token !== token) return; // not ours anymore — leave it
  } catch {
    return; // gone or unreadable — nothing to release
  }
  await fs.unlink(lockPath).catch(() => {});
}

// Acquire an exclusive advisory lock scoped to `dataFile`, run `fn()`, then
// release. The lock file is `dataFile + '.lock'`. The containing directory is
// created if it does not exist yet.
export async function withLock(dataFile, fn) {
  const lockPath = dataFile + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
