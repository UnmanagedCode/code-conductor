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
// Atomic writes (write tmp + rename), mirroring `sessionTitles.ts`.
// Missing file = empty set.
//
// Mutation safety: each write is protected by a cross-process advisory
// lockfile (`conducted-sessions.json.lock`). See `archivedSessions.ts`
// for the same pattern and rationale.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { withLock } from './storeLock.ts';

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

export async function loadAll(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(conductedFile(), 'utf8');
    return parseSet(JSON.parse(raw));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Set();
    console.warn(`conductedSessions: failed to read ${conductedFile()}: ${errMsg(e)}`);
    return new Set();
  }
}

export async function isConducted(sessionId: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const set = await loadAll();
  return set.has(sessionId);
}

// Like loadAll but used inside mutations (under the cross-process lock).
// Throws on I/O errors and JSON corruption rather than returning an empty
// set, so we never overwrite the store based on a failed read. ENOENT is
// the one legitimate empty-base case.
async function loadConductedStrict(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(conductedFile(), 'utf8');
    return parseSet(JSON.parse(raw)); // throws SyntaxError on corrupt JSON
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Set(); // legitimately empty
    throw e; // I/O error or corrupt JSON — abort the mutation
  }
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole set, so without this two concurrent
// writers could race on the read-modify-write and lose an entry.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeSet(set: Set<string>): Promise<void> {
  const file = conductedFile();
  if (set.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const obj = { sessions: [...set].sort((a, b) => a.localeCompare(b)) };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export function markConducted(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(conductedFile(), async () => {
      const set = await loadConductedStrict(); // canonical re-read under lock
      if (set.has(sessionId)) return true;
      set.add(sessionId);
      await writeSet(set);
      return true;
    });
  });
}

export function unmarkConducted(sessionId: string): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(conductedFile(), async () => {
      const set = await loadConductedStrict(); // canonical re-read under lock
      if (!set.has(sessionId)) return false;
      set.delete(sessionId);
      await writeSet(set);
      return true;
    });
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
