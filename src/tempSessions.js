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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

function tempFile() {
  return path.join(orchStoreRoot(), 'temp-sessions.json');
}

export async function loadAllTemps() {
  try {
    const raw = await fs.readFile(tempFile(), 'utf8');
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj?.sessions) ? obj.sessions : null;
    if (!arr) return new Set();
    const out = new Set();
    for (const sid of arr) {
      if (typeof sid === 'string' && sid) out.add(sid);
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    console.warn(`tempSessions: failed to read ${tempFile()}: ${e.message}`);
    return new Set();
  }
}

export async function isTemp(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAllTemps();
  return set.has(sessionId);
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
    const set = await loadAllTemps();
    if (set.has(sessionId)) return true;
    set.add(sessionId);
    await writeSet(set);
    return true;
  });
}

export function unmarkTemp(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const set = await loadAllTemps();
    if (!set.has(sessionId)) return false;
    set.delete(sessionId);
    await writeSet(set);
    return true;
  });
}
