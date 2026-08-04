// Sidecar JSON store mapping sessionId → custom human-readable title.
// Single global file at `<store>/session-titles.json` because session IDs
// are UUIDs (globally unique) — no need to scope per project/worktree.
//
// Atomic writes (write tmp + rename), matching the pattern used by
// `writeWorkspacesRegistry` in projects.ts. Missing file = empty map.
// Empty/whitespace titles delete the entry; titles are trimmed and
// length-capped at MAX_TITLE_LEN.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';

export const MAX_TITLE_LEN = 100;

function titlesFile(): string {
  return path.join(orchStoreRoot(), 'session-titles.json');
}

function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, MAX_TITLE_LEN);
}

export async function loadAll(): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(titlesFile(), 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return new Map();
    const titles = (obj as { titles?: unknown }).titles;
    if (typeof titles !== 'object' || titles === null) return new Map();
    const out = new Map<string, string>();
    for (const [sid, t] of Object.entries(titles as Record<string, unknown>)) {
      if (typeof t !== 'string') continue;
      const v = normalizeTitle(t);
      if (v) out.set(sid, v);
    }
    return out;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    console.warn(`sessionTitles: failed to read ${titlesFile()}: ${errMsg(e)}`);
    return new Map();
  }
}

export async function getTitle(sessionId: string): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole map, so without this two concurrent
// setTitle calls could race on the read-modify-write and lose one key.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map: Map<string, string>): Promise<void> {
  const file = titlesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { titles: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function setTitle(sessionId: string, title: unknown): Promise<string | null> {
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

export function deleteTitle(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const map = await loadAll();
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await writeMap(map);
    return true;
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
