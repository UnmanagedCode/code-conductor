// Cross-process advisory lock — the shared primitive behind the session store's
// read-modify-write (src/sessionStore.ts) and the FUSE union binary's build
// (src/systems/fuse/build.ts).
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
//
// The projects-root lock (src/rootLock.ts) shares the token minting, the
// one-block create and the token-checked release, but NOT the pid-liveness
// reclaim: its holders can live in another pid namespace.

import { promises as fs, openSync, writeSync, closeSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
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
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return errCode(e) !== 'ESRCH'; }
}

let tokenCounter = 0;

// A token unique to this acquire: no other process, and no other acquire in
// this one, can mint the same string. The projects-root lock (src/rootLock.ts)
// mints its tokens here too.
export function mintLockToken(): string {
  return `${process.pid}-${Date.now()}-${tokenCounter++}`;
}

// Create `lockPath` exclusively and write `content` into it, in ONE synchronous
// block: a process starved between an open and a write can then never leave a
// created-but-empty lockfile for a reader to judge. False when the file already
// exists; any other failure throws (after removing a file this call created).
export function createLockFileSync(lockPath: string, content: string): boolean {
  let fd: number;
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, throws EEXIST if held
  try { fd = openSync(lockPath, 'wx'); }
  catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, content);
  } catch (e) {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    throw e;
  }
  closeSync(fd);
  return true;
}

// Acquire the lock; returns a unique ownership token to hand back to releaseLock.
async function acquireLock(lockPath: string): Promise<string> {
  const token = mintLockToken();
  for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt++) {
    if (createLockFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token }))) return token;
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
  // The dead-owner reclaim on the FINAL retry iteration (attempt ===
  // LOCK_RETRY_MAX) falls out of the loop and lands here. That path is
  // reachable: an owner alive across all 25 retries that dies during the last
  // backoff window is unlinked by iteration 25's `continue`, which exits the
  // loop. The original JS fell through returning `undefined`, so `withLock`
  // then ran `fn()` with NO lock held — the exact lost-update class this file
  // exists to prevent. Throwing here is the intentional latent-bug fix: a
  // reclaim that cannot re-acquire inside the loop fails closed instead of
  // running the critical section unlocked.
  throw new Error('storeLock: acquire loop exited without a token');
}

// The one release rule: a lockfile is ours to remove only while it still
// carries our token. After a dead-owner reclaim a successor may hold the lock
// under a fresh token; this keeps us from deleting theirs.
function ownsLock(raw: string, token: string): boolean {
  return parseLockRecord(raw)?.token === token;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (!ownsLock(await fs.readFile(lockPath, 'utf8'), token)) return; // not ours anymore — leave it
  } catch {
    return; // gone or unreadable — nothing to release
  }
  await fs.unlink(lockPath).catch(() => {});
}

// releaseLock for a caller that cannot await — a `process.on('exit')` handler.
export function releaseLockSync(lockPath: string, token: string): void {
  try {
    if (!ownsLock(readFileSync(lockPath, 'utf8'), token)) return;
  } catch {
    return;
  }
  try { unlinkSync(lockPath); } catch { /* already gone */ }
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
