// Sidecar JSON store of sessionIds that were spawned via the MCP
// `spawn_instance` tool (i.e. the *worker* agents an orchestrator
// conducts — the "conducted" sessions), as opposed to the browser UI /
// HTTP spawn path. Single global file at
// `<store>/conducted-sessions.json` because session IDs are UUIDs
// (globally unique) — no need to scope per project/worktree.
//
// This is the *durable* half of the conducted axis: unlike `temp`
// (purely in-memory, wiped on exit) the conducted marker must survive
// instance exit, server restart, and `--resume`, so a non-temp
// conducted session is still recognised as conducted when it shows up
// as a historical/resumable session later.
//
// Read/write machinery (lock + write-chain + atomic write + unlink-when-empty)
// comes from `jsonStore.ts`; see that file for the ordering rationale.

import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { createJsonStore } from './jsonStore.ts';

function conductedFile(): string {
  return path.join(orchStoreRoot(), 'conducted-sessions.json');
}

// Parse the persisted `{sessions:[sid...]}` doc into a Set, keeping only
// well-formed ids. The raw JSON is an untyped on-disk boundary, so this is
// where the shape is validated rather than trusted. Returns the empty set
// for any well-formed doc without a `sessions` array.
function parseSet(raw: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null) return new Set();
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return new Set();
  const out = new Set<string>();
  for (const sid of sessions) {
    if (typeof sid === 'string' && sid) out.add(sid);
  }
  return out;
}

const store = createJsonStore<Set<string>>({
  file: conductedFile,
  noun: 'conductedSessions',
  empty: () => new Set(),
  parse: parseSet,
  toDoc: (set) => ({ sessions: [...set].sort((a, b) => a.localeCompare(b)) }),
  isEmpty: (set) => set.size === 0,
});

export async function loadAll(): Promise<Set<string>> {
  return store.load();
}

export async function isConducted(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAll();
  return set.has(sessionId);
}

export function markConducted(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (set, write) => {
    if (set.has(sessionId)) return true;
    set.add(sessionId);
    await write(set);
    return true;
  });
}

export function unmarkConducted(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (set, write) => {
    if (!set.has(sessionId)) return false;
    set.delete(sessionId);
    await write(set);
    return true;
  });
}
