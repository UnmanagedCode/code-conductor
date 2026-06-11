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
// Atomic writes (write tmp + rename), mirroring `conductedSessions.js`.
// Missing file = empty set.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

function archivedFile() {
  return path.join(orchStoreRoot(), 'archived-sessions.json');
}

export async function loadAllArchived() {
  try {
    const raw = await fs.readFile(archivedFile(), 'utf8');
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
    console.warn(`archivedSessions: failed to read ${archivedFile()}: ${e.message}`);
    return new Set();
  }
}

export async function isArchived(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAllArchived();
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
  const file = archivedFile();
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

export function markArchived(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const set = await loadAllArchived();
    if (set.has(sessionId)) return true;
    set.add(sessionId);
    await writeSet(set);
    return true;
  });
}

export function unmarkArchived(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const set = await loadAllArchived();
    if (!set.has(sessionId)) return false;
    set.delete(sessionId);
    await writeSet(set);
    return true;
  });
}
