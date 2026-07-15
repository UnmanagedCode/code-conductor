// Sidecar JSON store mapping sessionId → its non-Claude backend binding, so a
// session spawned through `ollama launch claude` re-acquires that binding
// across every resume path (UI resume, crash/anchor auto-resume,
// respawn_instance, restart manifest) and a managed /clear renewal — the same
// way conducted/temp markers survive. Claude-backed sessions store nothing.
//
// Single global file at `<store>/session-backends.json` (session IDs are
// globally-unique UUIDs). Map-shaped, atomic tmp→rename writes, delete-when-
// empty — mirrors sessionTitles.js. The value is a record
// `{ kind:'ollama', model:<ollama tag>, host:<'' | host:port> }`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

function backendsFile() {
  return path.join(orchStoreRoot(), 'session-backends.json');
}

function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.kind !== 'ollama') return null;
  const model = typeof rec.model === 'string' ? rec.model.trim() : '';
  if (!model) return null;
  const host = typeof rec.host === 'string' ? rec.host.trim() : '';
  return { kind: 'ollama', model, host };
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || obj.backends === null || typeof obj.backends !== 'object') {
      return new Map();
    }
    const out = new Map();
    for (const [sid, rec] of Object.entries(obj.backends)) {
      if (typeof sid !== 'string') continue;
      const v = normalizeRecord(rec);
      if (v) out.set(sid, v);
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    console.warn(`sessionBackends: failed to read ${backendsFile()}: ${e.message}`);
    return new Map();
  }
}

export async function getBackend(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Serialise concurrent writers behind a per-process promise chain (read-modify-
// write of the whole map would otherwise lose keys under concurrency).
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map) {
  const file = backendsFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { backends: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function setBackend(sessionId, rec) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const v = normalizeRecord(rec);
    const map = await loadAll();
    if (!v) {
      map.delete(sessionId);
      await writeMap(map);
      return null;
    }
    map.set(sessionId, v);
    await writeMap(map);
    return v;
  });
}

export function deleteBackend(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
  });
}
