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

interface LockRecord {
  pid?: number;
  token?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// The `code` on a thrown Node error (e.g. 'EEXIST'/'ENOENT'), or undefined when
// the throw isn't an object with a string `code`. Catch variables are `unknown`
// under strict, so this is the one narrowing point for error-code checks.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// Parse the JSON a holder writes into the lockfile. The fields are validated
// individually and OPTIONAL: the reclaim path only needs `pid` (a stale lock
// written without a token must still be reclaimable when its owner is dead),
// while the release path only needs `token`. Returns null for something that
// isn't parseable object JSON — the caller treats that like a lock file it
// can't read (i.e. "just retry").
function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, token } = parsed as { pid?: unknown; token?: unknown };
    return {
      pid: typeof pid === 'number' ? pid : undefined,
      token: typeof token === 'string' ? token : undefined,
    };
  } catch {
    return null;
  }
}

// Returns false only when the process definitely does not exist (ESRCH).
// EPERM (process exists but we have no permission to signal it) → alive.
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return errCode(e) !== 'ESRCH'; }
}

let tokenCounter = 0;

// Acquire the lock; returns a unique ownership token to hand back to releaseLock.
async function acquireLock(lockPath: string): Promise<string> {
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
      if (errCode(e) !== 'EEXIST') throw e;

      // Lock already held — reclaim ONLY if the owner is gone (dead PID). A
      // live owner is respected no matter how old/slow (see file header).
      try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const record = parseLockRecord(raw);
        if (record?.pid !== undefined && !isProcessAlive(record.pid)) {
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

      // Exponential backoff with jitter (spread set in the sleep call below)
      const base = LOCK_RETRY_BASE_MS * Math.pow(1.5, attempt);
      await sleep(Math.min(base * (0.8 + 0.4 * Math.random()), 500));
    }
  }
  // Unreachable in practice: every path above returns (acquired) or throws
  // (non-EEXIST error, or a live owner past LOCK_RETRY_MAX retries). The only
  // way out of the loop is a dead-owner reclaim on the FINAL iteration, which
  // would leave the old JS returning `undefined` (releasing nothing and
  // stranding a stale lockfile); throwing is the type-safe equivalent for a
  // path that cannot occur — a lock held by a live owner is waited out and
  // timed out above, and a dead owner's lock is cleared, so the loop always
  // terminates with a token or an error.
  throw new Error('storeLock: acquire loop exited without a token');
}

// Remove the lockfile only if we still own it (token match). After a dead-owner
// reclaim a successor may now hold the lock under a fresh token; this prevents
// us from deleting theirs.
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const record = parseLockRecord(raw);
    if (record?.token !== token) return; // not ours anymore — leave it
  } catch {
    return; // gone or unreadable — nothing to release
  }
  await fs.unlink(lockPath).catch(() => {});
}

// Acquire an exclusive advisory lock scoped to `dataFile`, run `fn()`, then
// release. The lock file is `dataFile + '.lock'`. The containing directory is
// created if it does not exist yet.
export async function withLock<T>(dataFile: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = dataFile + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
