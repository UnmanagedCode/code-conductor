// Sidecar JSON store of sessionIds that were spawned as temporary sessions
// (i.e. the `temp: true` flag on Instance). Single global file at
// `<store>/temp-sessions.json` because session IDs are UUIDs
// (globally unique) — no need to scope per project/worktree.
//
// This is the *durable* half of the temp axis: the temp flag must survive
// SIGKILL (where the on-exit cleanup never runs, leaving the .jsonl on
// disk). Without this, on restart the session is rediscovered with no
// record it was temp and silently becomes persistent.
//
// Atomic writes (write tmp + rename), mirroring `conductedSessions.js`.
// Missing file = empty set.
//
// Mutation safety: each write is protected by a cross-process advisory
// lockfile (`temp-sessions.json.lock`) so concurrent processes (e.g. old
// server exiting + new server booting during a hot restart) cannot clobber
// each other's entries. Within a single process, `writeChain` serialises
// calls to avoid redundant lock contention.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';
import { withLock } from './storeLock.js';

function tempFile() {
  return path.join(orchStoreRoot(), 'temp-sessions.json');
}

function parseTempsJson(raw) {
  const obj = JSON.parse(raw);
  const arr = Array.isArray(obj?.sessions) ? obj.sessions : null;
  if (!arr) return new Set();
  const out = new Set();
  for (const sid of arr) {
    if (typeof sid === 'string' && sid) out.add(sid);
  }
  return out;
}

export async function loadAllTemps() {
  try {
    const raw = await fs.readFile(tempFile(), 'utf8');
    return parseTempsJson(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    console.warn(`tempSessions: failed to read ${tempFile()}: ${e.message}`);
    return new Set();
  }
}

// Sync twin of loadAllTemps(), for the restart path (src/restart.js), which
// must stay fully synchronous up to process.exit() — see shutdownTempSync's
// comment in src/instances.js for why.
export function loadAllTempsSync() {
  try {
    return parseTempsJson(readFileSync(tempFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    console.warn(`tempSessions: failed to read ${tempFile()}: ${e.message}`);
    return new Set();
  }
}

// Durable temp sessionIds with no matching live instance — i.e. sessions
// that crashed before this process could clean them up itself, recorded
// only in temp-sessions.json. `liveSessionIds` should be every sessionId
// this process currently tracks as a live temp instance.
export function orphanedTempIdsSync(liveSessionIds) {
  const durable = loadAllTempsSync();
  const live = new Set(liveSessionIds);
  return [...durable].filter((id) => !live.has(id));
}

export async function isTemp(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAllTemps();
  return set.has(sessionId);
}

// Like loadAllTemps but used inside mutations (under the cross-process lock).
// Throws on I/O errors and JSON corruption rather than returning an empty set,
// so we never overwrite the store based on a failed read.
// ENOENT is the one legitimate empty-base case: the file has never been written
// or was correctly unlinked when the last entry was removed.
async function loadTempsStrict() {
  try {
    const raw = await fs.readFile(tempFile(), 'utf8');
    return parseTempsJson(raw); // throws SyntaxError on corrupt JSON
  } catch (e) {
    if (e.code === 'ENOENT') return new Set(); // legitimately empty
    throw e; // I/O error or corrupt JSON — abort the mutation
  }
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole set, so without this two concurrent
// writers could race on the read-modify-write and lose an entry.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeSet(set) {
  const file = tempFile();
  if (set.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { sessions: [...set].sort((a, b) => a.localeCompare(b)) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function markTemp(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(tempFile(), async () => {
      const set = await loadTempsStrict(); // canonical re-read under lock
      if (set.has(sessionId)) return true;
      set.add(sessionId);
      await writeSet(set);
      return true;
    });
  });
}

export function unmarkTemp(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(tempFile(), async () => {
      const set = await loadTempsStrict(); // canonical re-read under lock
      if (!set.has(sessionId)) return false;
      set.delete(sessionId);
      await writeSet(set);
      return true;
    });
  });
}
