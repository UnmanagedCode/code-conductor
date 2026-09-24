// Sidecar JSON store mapping sessionId → custom human-readable title.
// Single global file at `<store>/session-titles.json` because session IDs
// are UUIDs (globally unique) — no need to scope per project/worktree.
//
// Read/write machinery (cross-process lock + write-chain + atomic write +
// unlink-when-empty) comes from `jsonStore.ts`. Empty/whitespace titles delete
// the entry; titles are trimmed and length-capped at MAX_TITLE_LEN.

import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { createJsonStore } from './jsonStore.ts';
import { resolveBacking } from './sessionLineage.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

export const MAX_TITLE_LEN = 100;

function titlesFile(): string {
  return path.join(orchStoreRoot(), 'session-titles.json');
}

function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, MAX_TITLE_LEN);
}

function parseMap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== 'object' || raw === null) return out;
  const titles = (raw as { titles?: unknown }).titles;
  if (typeof titles !== 'object' || titles === null) return out;
  for (const [sid, t] of Object.entries(titles as Record<string, unknown>)) {
    if (typeof t !== 'string') continue;
    const v = normalizeTitle(t);
    if (v) out.set(sid, v);
  }
  return out;
}

const store = createJsonStore<Map<string, string>>({
  file: titlesFile,
  noun: 'sessionTitles',
  empty: () => new Map(),
  parse: parseMap,
  toDoc: (map) => ({ titles: Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))) }),
  isEmpty: (map) => map.size === 0,
});

export async function loadAll(): Promise<Map<string, string>> {
  return store.load();
}

export async function getTitle(sessionId: string): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

export function setTitle(sessionId: string, title: unknown): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(null);
  const v = normalizeTitle(title);
  return store.mutate(async (map, write) => {
    if (!v) {
      map.delete(sessionId);
      await write(map);
      return null;
    }
    map.set(sessionId, v);
    await write(map);
    return v;
  });
}

// THE title write behind both the REST rename and the MCP set_session_title.
// Keyed to the TRANSCRIPT: listSessionsForCwdWithCounts looks titles up by
// filename and Instance._hydrateTitle reads the backing id, so a title
// written under the public id would reach neither. Every live instance
// attached to the public id gets the stored value so its header re-renders
// and a later renewal carries it (carryMarkersAcrossRenewal reads inst.title).
export async function applySessionTitle(
  instances: Pick<InstanceManagerLike, 'idsForSession' | 'get'> | null | undefined,
  sid: string,
  title: unknown,
): Promise<string | null> {
  const stored = await setTitle(await resolveBacking(sid), title);
  if (instances) {
    for (const id of instances.idsForSession(sid)) {
      const inst = instances.get(id);
      if (inst) inst.setTitle(stored);
    }
  }
  return stored;
}

export function deleteTitle(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (map, write) => {
    if (!map.has(sessionId)) return false;
    map.delete(sessionId);
    await write(map);
    return true;
  });
}
