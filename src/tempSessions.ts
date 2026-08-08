// Sidecar JSON store of sessionIds that were spawned as temporary sessions
// (i.e. the `temp: true` flag on Instance). Single global file at
// `<store>/temp-sessions.json` because session IDs are UUIDs
// (globally unique) — no need to scope per project/worktree.
//
// This is the *durable* half of the temp axis: the temp flag must survive
// SIGKILL (where the on-exit cleanup never runs, leaving the .jsonl on
// disk). Without this, on restart the session is rediscovered with no
// record it was temp and silently becomes persistent.
//
// Read/write machinery (lock + write-chain + atomic write + unlink-when-empty)
// comes from `jsonStore.ts`; see that file for the ordering rationale. The
// cross-process half matters here specifically for a hot restart, where the
// exiting old server and the booting new one both write this file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { createJsonStore, errCode, errMsg } from './jsonStore.ts';

function tempFile(): string {
  return path.join(orchStoreRoot(), 'temp-sessions.json');
}

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
  file: tempFile,
  noun: 'tempSessions',
  empty: () => new Set(),
  parse: parseSet,
  toDoc: (set) => ({ sessions: [...set].sort((a, b) => a.localeCompare(b)) }),
  isEmpty: (set) => set.size === 0,
});

export async function loadAllTemps(): Promise<Set<string>> {
  return store.load();
}

// Sync twin of loadAllTemps(), for the restart path (src/restart.ts), which
// must stay fully synchronous up to process.exit() — see shutdownTempSync's
// comment in src/instances.ts for why. Deliberately NOT routed through the
// store: every reader there is async.
export function loadAllTempsSync(): Set<string> {
  try {
    return parseSet(JSON.parse(readFileSync(tempFile(), 'utf8')));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Set();
    console.warn(`tempSessions: failed to read ${tempFile()}: ${errMsg(e)}`);
    return new Set();
  }
}

// Durable temp sessionIds with no matching live instance — i.e. sessions
// that crashed before this process could clean them up itself, recorded
// only in temp-sessions.json. `liveSessionIds` should be every sessionId
// this process currently tracks as a live temp instance.
export function orphanedTempIdsSync(liveSessionIds: Iterable<string>): string[] {
  const durable = loadAllTempsSync();
  const live = new Set(liveSessionIds);
  return [...durable].filter((id) => !live.has(id));
}

export async function isTemp(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAllTemps();
  return set.has(sessionId);
}

export function markTemp(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (set, write) => {
    if (set.has(sessionId)) return true;
    set.add(sessionId);
    await write(set);
    return true;
  });
}

export function unmarkTemp(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(false);
  return store.mutate(async (set, write) => {
    if (!set.has(sessionId)) return false;
    set.delete(sessionId);
    await write(set);
    return true;
  });
}
