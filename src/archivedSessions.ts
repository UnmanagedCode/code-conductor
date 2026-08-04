// Sidecar JSON store of sessionIds that have been archived (killed rather
// than promoted). Archived sessions retain their .jsonl on disk so they
// remain resumable, but are hidden from the normal session list and
// surfaced in a separate "— archived —" section in the sidebar.
//
// Single global file at `<store>/archived-sessions.json` because session
// IDs are UUIDs (globally unique) — no need to scope per project/worktree.
//
// Degrades gracefully if the underlying .jsonl has been removed by external
// housekeeping: callers check for file existence before rendering or acting.
//
// Atomic writes (write tmp + rename), mirroring `conductedSessions.ts`.
// A rolling `.bak` holds the last non-empty snapshot; on a missing or corrupt
// primary we recover from it rather than silently returning empty. A corrupt
// primary is quarantined to `.corrupt-<pid>-<ts>` (under the lock) instead of
// bricking archiving. Missing primary AND missing backup = legitimately empty.
//
// Mutation safety: each write is protected by a cross-process advisory
// lockfile (`archived-sessions.json.lock`) so concurrent processes (e.g.
// old server exiting + new server booting during a hot restart) cannot
// clobber each other's entries. Within a single process, `writeChain`
// serialises calls to avoid redundant lock contention. The `.bak` refresh
// lives inside `writeSet` (under the same lock) so it can't race a writer.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { withLock } from './storeLock.ts';

function archivedFile(): string {
  return path.join(orchStoreRoot(), 'archived-sessions.json');
}

function backupFile(): string {
  return archivedFile() + '.bak';
}

// Parse raw store JSON into a Set of sessionIds. Throws SyntaxError on corrupt
// JSON (callers decide whether that's fatal). A well-formed doc with no
// `sessions` array yields the empty set.
function parseSet(raw: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null) return new Set();
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return new Set();
  const out = new Set<string>();
  for (const sid of sessions) {
    if (typeof sid === 'string' && sid) out.add(sid);
  }
  return out;
}

// Best-effort: rename a bad file aside for forensics. Only ever called on the
// primary from within a mutation (under the lock) or on the backup, so it can't
// race a concurrent writer's rename of a good file.
async function quarantine(file: string): Promise<void> {
  const dest = `${file}.corrupt-${process.pid}-${Date.now()}`;
  try { await fs.rename(file, dest); } catch { /* best-effort */ }
}

// Read-only recovery for the non-fatal read path: return the backup's set, or
// empty if the backup is absent/corrupt. Never writes, never throws.
async function loadBackupSet(): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(backupFile(), 'utf8');
  } catch { return new Set(); }
  try { return parseSet(JSON.parse(raw)); } catch { return new Set(); }
}

export async function loadAllArchived(): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(archivedFile(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return loadBackupSet(); // absent → try backup
    // I/O error on the read path is non-fatal — fall back to the backup.
    console.warn(`archivedSessions: failed to read ${archivedFile()}: ${errMsg(e)}; trying backup`);
    return loadBackupSet();
  }
  try {
    return parseSet(JSON.parse(raw));
  } catch (e) {
    // Corrupt primary — don't clobber it here (the read path isn't under the
    // lock); just serve the backup. The next mutation quarantines + self-heals.
    console.warn(`archivedSessions: corrupt ${archivedFile()} (${errMsg(e)}); recovering from backup`);
    return loadBackupSet();
  }
}

export async function isArchived(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAllArchived();
  return set.has(sessionId);
}

// Recover a mutation's base set from the backup. Runs under the cross-process
// lock. Absent backup → legitimately empty. Corrupt backup → quarantine it and
// start clean (both copies are then preserved for forensics). A genuine I/O
// error reading the backup (e.g. EACCES) propagates — abort the mutation rather
// than risk overwriting a store we simply couldn't read.
async function recoverBackupStrict(): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(backupFile(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Set(); // no backup → legitimately empty
    throw e; // unrecoverable I/O — abort the mutation
  }
  try {
    return parseSet(JSON.parse(raw));
  } catch {
    await quarantine(backupFile()); // backup also corrupt → set aside, start clean
    return new Set();
  }
}

// Like loadAllArchived but used inside mutations (under the cross-process lock).
// Corrupt JSON is quarantined and recovered from the backup rather than bricking
// archiving; a genuine unrecoverable I/O error (EACCES etc.) still throws so we
// never overwrite the store based on a failed read. ENOENT falls back to the
// backup, then to a legitimately-empty base.
async function loadArchivedStrict(): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(archivedFile(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return recoverBackupStrict(); // absent → backup, else empty
    throw e; // I/O error (EACCES etc.) — abort the mutation
  }
  try {
    return parseSet(JSON.parse(raw));
  } catch {
    // Corrupt primary — quarantine aside (race-safe under the lock) then
    // recover from the backup. The ensuing writeSet rewrites a clean primary.
    await quarantine(archivedFile());
    return recoverBackupStrict();
  }
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole set, so without this two concurrent
// writers could race on the read-modify-write and lose an entry.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeSet(set: Set<string>): Promise<void> {
  const file = archivedFile();
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { sessions: [...set].sort((a, b) => a.localeCompare(b)) };
  const json = JSON.stringify(obj, null, 2) + '\n';
  // Always write an explicit document (even `{"sessions":[]}`) — never unlink.
  // An absent primary then unambiguously means external loss, and loads recover
  // it from the backup.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, file);
  // Refresh the rolling backup only from a non-empty write that is a SUPERSET of
  // the current backup — never a shrink. This blocks two failure modes: an
  // intentional drain-to-empty (size 0) keeps the last non-empty snapshot, and a
  // write from a wrongly-empty/tiny base (a leaked write, an OOM read blip that
  // surfaced an empty primary) can't canonize a small set over the last-good
  // backup. Tradeoff (conscious): a legitimate un-archive is not a superset, so
  // `.bak` stops refreshing and may lag behind un-archives — the safe direction,
  // since a recovery from a stale `.bak` only ever re-archives a few since-
  // unarchived ids, never loses data. Runs under the same lock as the primary
  // write (callers wrap in withLock), so the `.bak` read below can't race.
  if (set.size > 0 && await backupIsSubsetOf(set)) {
    const btmp = `${file}.bak.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(btmp, json);
    await fs.rename(btmp, backupFile());
  }
}

// True if refreshing `.bak` to `set` would not drop any entry it currently
// holds (i.e. the on-disk `.bak` is a subset of `set`). Read-error handling
// mirrors the recovery helpers: absent `.bak` → empty (any non-empty set is a
// superset, so a first write creates it); corrupt `.bak` → treat as empty
// (worthless — replace it); other I/O error → false (leave an unreadable `.bak`
// untouched). Runs under the caller's lock.
async function backupIsSubsetOf(set: Set<string>): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(backupFile(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return true; // no backup yet → create it
    return false; // unreadable backup → don't overwrite what we can't verify
  }
  let bak: Set<string>;
  try { bak = parseSet(JSON.parse(raw)); } catch { return true; } // corrupt backup → replace
  for (const id of bak) {
    if (!set.has(id)) return false;
  }
  return true;
}

export function markArchived(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(archivedFile(), async () => {
      const set = await loadArchivedStrict(); // canonical re-read under lock
      if (set.has(sessionId)) return true;
      set.add(sessionId);
      await writeSet(set);
      return true;
    });
  });
}

export function unmarkArchived(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(archivedFile(), async () => {
      const set = await loadArchivedStrict(); // canonical re-read under lock
      if (!set.has(sessionId)) return false;
      set.delete(sessionId);
      await writeSet(set);
      return true;
    });
  });
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
