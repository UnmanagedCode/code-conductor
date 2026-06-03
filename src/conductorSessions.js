// Sidecar JSON store of sessionIds that were spawned via the MCP
// `spawn_instance` tool (i.e. by an orchestrator / "conductor"), as
// opposed to the browser UI / HTTP spawn path. Single global file at
// `<store>/conductor-sessions.json` because session IDs are UUIDs
// (globally unique) — no need to scope per project/worktree.
//
// This is the *durable* half of the conductor axis: unlike `temp`
// (purely in-memory, wiped on exit) the conductor marker must survive
// instance exit, server restart, and `--resume`, so a non-temp
// conductor session is still recognised as conductor when it shows up
// as a historical/resumable session later.
//
// Atomic writes (write tmp + rename), mirroring `sessionTitles.js`.
// Missing file = empty set.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

function conductorFile() {
  return path.join(orchStoreRoot(), 'conductor-sessions.json');
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(conductorFile(), 'utf8');
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
    console.warn(`conductorSessions: failed to read ${conductorFile()}: ${e.message}`);
    return new Set();
  }
}

export async function isConductor(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAll();
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
  const file = conductorFile();
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

export function markConductor(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const set = await loadAll();
    if (set.has(sessionId)) return true;
    set.add(sessionId);
    await writeSet(set);
    return true;
  });
}

export function unmarkConductor(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const set = await loadAll();
    if (!set.has(sessionId)) return false;
    set.delete(sessionId);
    await writeSet(set);
    return true;
  });
}
