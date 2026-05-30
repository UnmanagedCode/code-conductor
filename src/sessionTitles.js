// Sidecar JSON store mapping sessionId → custom human-readable title.
// Single global file at `<store>/session-titles.json` because session IDs
// are UUIDs (globally unique) — no need to scope per project/worktree.
//
// Atomic writes (write tmp + rename), matching the pattern used by
// `writeWorkspacesRegistry` in projects.js. Missing file = empty map.
// Empty/whitespace titles delete the entry; titles are trimmed and
// length-capped at MAX_TITLE_LEN.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

export const MAX_TITLE_LEN = 100;

function titlesFile() {
  return path.join(orchStoreRoot(), 'session-titles.json');
}

function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, MAX_TITLE_LEN);
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(titlesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || obj.titles === null || typeof obj.titles !== 'object') {
      return new Map();
    }
    const out = new Map();
    for (const [sid, t] of Object.entries(obj.titles)) {
      if (typeof sid !== 'string' || typeof t !== 'string') continue;
      const v = normalizeTitle(t);
      if (v) out.set(sid, v);
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    console.warn(`sessionTitles: failed to read ${titlesFile()}: ${e.message}`);
    return new Map();
  }
}

export async function getTitle(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole map, so without this two concurrent
// setTitle calls could race on the read-modify-write and lose one key.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map) {
  const file = titlesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { titles: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function setTitle(sessionId, title) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const v = normalizeTitle(title);
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

export function deleteTitle(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
  });
}
