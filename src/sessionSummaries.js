// Sidecar JSON store mapping sessionId → generated summary record.
// Single global file at `<store>/session-summaries.json` because session IDs
// are UUIDs (globally unique) — no need to scope per project/worktree.
//
// Atomic writes (write tmp + rename), matching the pattern used by
// `sessionTitles.js`. Missing file = empty map. Each record stores
// { summary, length, generatedAt, messageCount } where messageCount is
// the user+assistant line count at generation time (used for staleness).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.js';

function summariesFile() {
  return path.join(orchStoreRoot(), 'session-summaries.json');
}

export async function loadAll() {
  try {
    const raw = await fs.readFile(summariesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || obj.summaries === null || typeof obj.summaries !== 'object') {
      return new Map();
    }
    const out = new Map();
    for (const [sid, rec] of Object.entries(obj.summaries)) {
      if (typeof sid !== 'string' || !rec || typeof rec !== 'object') continue;
      if (typeof rec.summary !== 'string' || !rec.summary) continue;
      out.set(sid, {
        summary: rec.summary,
        length: rec.length ?? 'medium',
        generatedAt: typeof rec.generatedAt === 'number' ? rec.generatedAt : 0,
        messageCount: typeof rec.messageCount === 'number' ? rec.messageCount : 0,
      });
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    console.warn(`sessionSummaries: failed to read ${summariesFile()}: ${e.message}`);
    return new Map();
  }
}

export async function getSummary(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Serialise concurrent writers behind a per-process promise chain.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map) {
  const file = summariesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { summaries: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function setSummary(sessionId, record) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (!record || typeof record.summary !== 'string' || !record.summary.trim()) return null;
    const stored = {
      summary: record.summary.trim(),
      length: record.length ?? 'medium',
      generatedAt: typeof record.generatedAt === 'number' ? record.generatedAt : Date.now(),
      messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
    };
    const map = await loadAll();
    map.set(sessionId, stored);
    await writeMap(map);
    return stored;
  });
}

export function deleteSummary(sessionId) {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
  });
}
