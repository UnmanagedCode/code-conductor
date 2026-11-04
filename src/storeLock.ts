// Cross-process advisory lock — the shared primitive behind the session store's
// read-modify-write (src/sessionStore.ts) and the FUSE union binary's build
// (src/systems/fuse/build.ts).
//
// Uses an exclusively created lockfile (a hard-link publish, or an O_EXCL
// create where the filesystem has no hard links — see "Creating a lockfile"
// below) to serialise read-modify-write mutations across concurrent Node
// processes on the same machine.
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
// create and the token-checked release, but NOT the pid-liveness
// reclaim: its holders can live in another pid namespace.

import { promises as fs, writeFileSync, linkSync, readFileSync, unlinkSync, rmSync, openSync, writeSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

// A token unique to this acquire. The pid, time and counter alone repeat
// across pid namespaces — every container's node can be pid 1, booting in the
// same millisecond — so the token carries CSPRNG bytes too. The
// projects-root lock (src/rootLock.ts) mints its tokens here.
export function mintLockToken(): string {
  return `${process.pid}-${Date.now()}-${tokenCounter++}-${randomBytes(8).toString('hex')}`;
}

// ── Creating a lockfile ─────────────────────────────────────────────────────
//
// Where the filesystem has hard links, a lockfile is published whole: its
// content goes to a uniquely named staging file first, and a hard link puts it
// at the lock path in one atomic step, failing EEXIST when the name is taken. A
// reader then never sees a created-but-unwritten lockfile, however long the
// creator is starved between the two calls.
//
// Where it has none (FAT/exFAT, Android shared storage), the lockfile is
// created in place: O_EXCL open, write, close. A reader can then see it empty
// for a moment, and a creator killed in that gap leaves an empty lockfile that
// must be deleted by hand. Both callers are safe with that: withLock never
// reclaims a record without a pid, and the root lock treats any unparseable
// record as held.
//
// The mode is found once per directory (keyed by its realpath) and cached for
// the process.

type CreateMode = 'link' | 'open';

// A link failure meaning "this filesystem has no hard links". Every other code
// (EACCES, EROFS, ENOSPC, EIO…) is a real failure and propagates.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

// The capability probe's temp files. The root lock sweeps them from its dir.
export const LINK_PROBE_PREFIX = '.cc-link-probe-';
const PROBE_RETRIES = 3;

export interface LockFsDeps {
  link: (existing: string, target: string) => void;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}
const DEFAULT_DEPS: LockFsDeps = { link: linkSync, log: console };

const createModes = new Map<string, CreateMode>();

function probeLinks(dir: string, deps: LockFsDeps): CreateMode {
  for (let attempt = 0; ; attempt++) {
    const source = path.join(dir, `${LINK_PROBE_PREFIX}${randomBytes(6).toString('hex')}`);
    // A second unique name, so the probe itself can never meet EEXIST.
    const target = `${source}.link`;
    writeFileSync(source, '', { flag: 'wx' });
    try {
      deps.link(source, target);
      return 'link';
    } catch (e) {
      const code = errCode(e);
      if (code !== undefined && NO_LINKS.has(code)) return 'open';
      if (code === 'EXDEV') {
        deps.log.warn(`storeLock: linking within ${dir} failed EXDEV — the directory spans two filesystems (a bind or overlay mount?); creating lockfiles in place`);
        return 'open';
      }
      // A sweep of this dir (the root lock's) can take the probe file mid-probe.
      if (code === 'ENOENT' && !existsSync(source) && attempt < PROBE_RETRIES) continue;
      throw e;
    } finally {
      rmSync(source, { force: true });
      rmSync(target, { force: true });
    }
  }
}

function createModeFor(dir: string, deps: LockFsDeps): CreateMode {
  const key = realpathSync(dir);
  const known = createModes.get(key);
  if (known) return known;
  const mode = probeLinks(key, deps);
  createModes.set(key, mode);
  if (mode === 'link') deps.log.info(`storeLock: ${key} has hard links — lockfiles are published whole`);
  else deps.log.warn(`storeLock: ${key} has no hard links — lockfiles are created in place; a crash between their create and write leaves an empty lockfile that must be deleted by hand`);
  return mode;
}

// Write `content` to a staging file beside `lockPath`; returns its path.
export function stageLockFileSync(lockPath: string, content: string): string {
  const staged = `${lockPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(staged, content, { flag: 'wx' });
  } catch (e) {
    rmSync(staged, { force: true });
    throw e;
  }
  return staged;
}

// Link `staged` to `lockPath`; false when `lockPath` exists. The staging file
// is removed either way. ENOENT means the staging file was removed under us.
export function publishLockFileSync(staged: string, lockPath: string, deps: LockFsDeps = DEFAULT_DEPS): boolean {
  try {
    deps.link(staged, lockPath);
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(staged, { force: true });
  }
}

// The no-hard-links create: O_EXCL open, write, close. False when `lockPath`
// exists; a failed write removes what this call created.
function createInPlaceSync(lockPath: string, content: string): boolean {
  let fd: number;
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

// A create split at the point a starved creator sits in: `publish()` is the
// exclusive step (false when `lockPath` exists), `abandon()` drops a prepared
// create that will not be published.
export interface PendingLockFile { publish(): boolean; abandon(): void }

export function prepareLockFileSync(lockPath: string, content: string, deps: LockFsDeps = DEFAULT_DEPS): PendingLockFile {
  if (createModeFor(path.dirname(lockPath), deps) === 'open') {
    return { publish: () => createInPlaceSync(lockPath, content), abandon() {} };
  }
  const staged = stageLockFileSync(lockPath, content);
  return {
    publish: () => publishLockFileSync(staged, lockPath, deps),
    abandon: () => rmSync(staged, { force: true }),
  };
}

// Create `lockPath` exclusively with `content`. False when it already exists;
// any other failure throws.
export function createLockFileSync(lockPath: string, content: string, deps: LockFsDeps = DEFAULT_DEPS): boolean {
  return prepareLockFileSync(lockPath, content, deps).publish();
}

// ── withLock's dead-owner reclaim ───────────────────────────────────────────
//
// Two waiters can judge one dead owner at once. Unlinking unconditionally would
// let the later one delete the lock the earlier one just re-created, and both
// would run the critical section. So reclaimers are serialised by an exclusive
// `<lock>.reclaim` marker, and its holder unlinks the lockfile only while it
// still holds exactly the record that was judged dead.
//
// A marker left by a reclaimer that died holding it is cleared by the same
// dead-pid rule (and only while unchanged). Two waiters clearing one such stale
// marker at the same instant can both enter the reclaim; that needs a
// reclaimer to die inside a few synchronous calls, and is not closed.

// Test seams around one reclaim attempt.
export interface WithLockHooks {
  beforeReclaim?: () => Promise<void>;
  afterReclaim?: () => Promise<void>;
}

function readOrNull(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// True when this waiter held the marker (whether or not the record was still
// the judged one); false when another reclaimer holds it.
function reclaimDeadOwner(lockPath: string, judgedRaw: string): boolean {
  const markerPath = `${lockPath}.reclaim`;
  const token = mintLockToken();
  if (!createLockFileSync(markerPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token }))) {
    const raw = readOrNull(markerPath);
    const holder = raw === null ? null : parseLockRecord(raw);
    if (holder?.pid !== undefined && !isProcessAlive(holder.pid) && readOrNull(markerPath) === raw) {
      try { unlinkSync(markerPath); } catch { /* cleared by another */ }
    }
    return false;
  }
  try {
    if (readOrNull(lockPath) === judgedRaw) {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  } finally {
    releaseLockSync(markerPath, token);
  }
  return true;
}

// Acquire the lock; returns a unique ownership token to hand back to releaseLock.
async function acquireLock(lockPath: string, hooks: WithLockHooks): Promise<string> {
  const token = mintLockToken();
  for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt++) {
    if (createLockFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token }))) return token;
    // Lock already held — reclaim ONLY if the owner is gone (dead PID). A
    // live owner, and a record with no pid (one being written in place), is
    // respected no matter how old/slow (see file header).
    const raw = readOrNull(lockPath);
    const record = raw === null ? null : parseLockRecord(raw);
    if (raw !== null && record?.pid !== undefined && !isProcessAlive(record.pid)) {
      await hooks.beforeReclaim?.();
      const reclaimed = reclaimDeadOwner(lockPath, raw);
      await hooks.afterReclaim?.();
      if (reclaimed) continue; // retry immediately after clearing the dead owner's lock
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
export async function withLock<T>(dataFile: string, fn: () => Promise<T>, hooks: WithLockHooks = {}): Promise<T> {
  const lockPath = dataFile + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = await acquireLock(lockPath, hooks);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
