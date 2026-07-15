// Sidecar JSON store of sessionIds that are Ollama-backed (spawned through
// `ollama launch claude`). A single bit per session — the model itself is
// recovered from the jsonl on resume like any other, so the ONLY thing this
// carries is the backend kind. Claude-backed sessions store nothing (absence =
// 'claude'). Single global file `<store>/session-backends.json`, Set-shaped
// (`{sessions:[…]}`); atomic writes + cross-process lock, mirroring
// `conductedSessions.js` — the durable-marker pattern this is an instance of.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';
import { withLock } from './storeLock.js';

function backendsFile() {
  return path.join(orchStoreRoot(), 'session-backends.json');
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj?.sessions) ? obj.sessions : null;
    if (!arr) return new Set();
    const out = new Set();
    for (const sid of arr) if (typeof sid === 'string' && sid) out.add(sid);
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    console.warn(`sessionBackends: failed to read ${backendsFile()}: ${e.message}`);
    return new Set();
  }
}

export async function isOllamaSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAll();
  return set.has(sessionId);
}

// Strict re-read inside a mutation (under the lock): throws on I/O / corrupt
// JSON rather than returning empty, so a failed read never overwrites the store.
async function loadStrict() {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj?.sessions) ? obj.sessions : null;
    if (!arr) return new Set();
    const out = new Set();
    for (const sid of arr) if (typeof sid === 'string' && sid) out.add(sid);
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}

let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeSet(set) {
  const file = backendsFile();
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

export function markOllamaSession(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(backendsFile(), async () => {
      const set = await loadStrict();
      if (set.has(sessionId)) return true;
      set.add(sessionId);
      await writeSet(set);
      return true;
    });
  });
}

export function unmarkOllamaSession(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(backendsFile(), async () => {
      const set = await loadStrict();
      if (!set.has(sessionId)) return false;
      set.delete(sessionId);
      await writeSet(set);
      return true;
    });
  });
}
