// Sidecar JSON store mapping each Ollama-backed sessionId (spawned through
// `ollama launch claude`) to the full tagged model it was launched with
// (`deepseek-v4-flash:cloud`). Two things jsonl can't carry: the backend kind,
// and the model TAG — the inner CLI records `message.model` bare (tag dropped),
// so the tagless jsonl value can't rebuild `ollama launch --model <tag>` on
// resume. This store is the authority for both. A `null` model means
// ollama-backed but tag-unknown (a legacy entry migrated from the old set form,
// or a mark with no model); resume falls back to the jsonl for those. Claude-
// backed sessions store nothing (absence = 'claude'). Single global file
// `<store>/session-backends.json`, map-shaped (`{sessions:{sid:model}}`); atomic
// writes + cross-process lock, mirroring `conductedSessions.js`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';
import { withLock } from './storeLock.js';

function backendsFile() {
  return path.join(orchStoreRoot(), 'session-backends.json');
}

function parseMap(obj) {
  const sessions = obj && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)
    ? obj.sessions : null;
  const out = new Map();
  if (!sessions) return out;
  for (const [sid, model] of Object.entries(sessions)) {
    if (typeof sid !== 'string' || !sid) continue;
    out.set(sid, typeof model === 'string' && model ? model : null);
  }
  return out;
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    console.warn(`sessionBackends: failed to read ${backendsFile()}: ${e.message}`);
    return new Map();
  }
}

export async function isOllamaSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const map = await loadAll();
  return map.has(sessionId);
}

// One read serving both the kind and the tag, so the resume path doesn't
// load the store twice. `ollama` is membership; `model` is the tagged launch
// model (null when tag-unknown — resume then falls back to the jsonl).
export async function getOllamaSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return { ollama: false, model: null };
  const map = await loadAll();
  if (!map.has(sessionId)) return { ollama: false, model: null };
  return { ollama: true, model: map.get(sessionId) ?? null };
}

// Strict re-read inside a mutation (under the lock): throws on I/O / corrupt
// JSON rather than returning empty, so a failed read never overwrites the store.
async function loadStrict() {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw e;
  }
}

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
  const sessions = {};
  for (const sid of [...map.keys()].sort((a, b) => a.localeCompare(b))) sessions[sid] = map.get(sid);
  const obj = { sessions };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Upsert the session's tagged launch model. Called on every spawn/resume, so a
// legacy null entry self-heals the first time the session relaunches with a
// real tag. Idempotent: skips the write when membership + model already match.
export function markOllamaSession(sessionId, model = null) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const value = typeof model === 'string' && model ? model : null;
    return withLock(backendsFile(), async () => {
      const map = await loadStrict();
      if (map.has(sessionId) && (map.get(sessionId) ?? null) === value) return true;
      map.set(sessionId, value);
      await writeMap(map);
      return true;
    });
  });
}

export function unmarkOllamaSession(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(backendsFile(), async () => {
      const map = await loadStrict();
      if (!map.has(sessionId)) return false;
      map.delete(sessionId);
      await writeMap(map);
      return true;
    });
  });
}
