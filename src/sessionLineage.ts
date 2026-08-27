// Sidecar JSON store mapping a session's PERMANENT public id to the chain of
// rotating CLI-side *backing* ids it has run under. Single global file at
// `<store>/session-lineage.json` because session ids are globally unique — no
// need to scope per project/worktree.
//
// A session's public id is minted once (mintPublicId) from the first 8 hex chars
// of its first backing id and never changes again. Every later rotation — a
// managed `/clear` (`renew`) or a context prune (`prune`) — appends a segment
// and advances `current`. That is what lets a conductor hold one id for the life
// of a worker while the CLI rotates its own `session_id` underneath.
//
// BASE CASE, not a legacy branch: a session with NO row here has public id ==
// backing id. Every resolver below returns its input unchanged for an unknown
// id, so pre-existing sessions (and any session that has never rotated and was
// never minted) work with no migration and no backfill. Nothing anywhere asks
// "is this a legacy id?".
//
// `reason` is load-bearing, not polish. Every segment's file survives on disk in
// both mechanisms, so segments are uniform for IDENTITY — but not for CONTENT: a
// `renew` segment is DISJOINT from its predecessor (full history is their
// concatenation), while a `prune` segment is a filtered COPY that OVERLAPS it
// (src/sessionPrune.ts writes a new file and leaves the original untouched) and
// must never be concatenated. `reason` alone carries this — do NOT add a second
// boolean that can disagree with it.
//
// The reverse index (backing → public) is built in memory at load and NEVER
// persisted: a second on-disk copy is a divergence surface.
//
// Atomic writes (write tmp + rename) and a cross-process advisory lockfile
// around every mutation, mirroring `src/tempSessions.ts`. Missing file = empty.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { withLock } from './storeLock.ts';

export type RotationReason = 'initial' | 'renew' | 'prune';

export interface LineageSegment {
  id: string;
  reason: RotationReason;
  at: string;
}

export interface LineageRow {
  current: string;
  segments: LineageSegment[];
}

export interface Lineage {
  byPublic: Map<string, LineageRow>;
  // backing id → the public id that owns it. Built at load, never persisted.
  byBacking: Map<string, string>;
}

// The public id is the first 8 hex chars of the first backing id. A UUID has no
// dash in its first 8 chars, so this is 8 hex digits — the form the conductor
// role doc, the UI and ambiguousRefusal already use.
export const PUBLIC_ID_LEN = 8;
// On collision, extend to `xxxxxxxx-xxxx` (12 hex digits). Chosen over stripping
// the dash because it stays a literal PREFIX of the backing UUID, so it never
// stops being prefix-resolvable.
export const PUBLIC_ID_LEN_EXTENDED = 13;

const VALID_REASONS = new Set<RotationReason>(['initial', 'renew', 'prune']);

function lineageFile(): string {
  return path.join(orchStoreRoot(), 'session-lineage.json');
}

function parseLineageJson(raw: string): Map<string, LineageRow> {
  const obj: unknown = JSON.parse(raw); // throws SyntaxError on corrupt JSON
  const out = new Map<string, LineageRow>();
  if (typeof obj !== 'object' || obj === null) return out;
  const sessions = (obj as { sessions?: unknown }).sessions;
  if (typeof sessions !== 'object' || sessions === null) return out;
  for (const [publicId, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!publicId || typeof value !== 'object' || value === null) continue;
    const { current, segments } = value as { current?: unknown; segments?: unknown };
    if (typeof current !== 'string' || !current) continue;
    if (!Array.isArray(segments)) continue;
    const rows: LineageSegment[] = [];
    for (const seg of segments) {
      if (typeof seg !== 'object' || seg === null) continue;
      const { id, reason, at } = seg as { id?: unknown; reason?: unknown; at?: unknown };
      if (typeof id !== 'string' || !id) continue;
      if (typeof reason !== 'string' || !VALID_REASONS.has(reason as RotationReason)) continue;
      rows.push({ id, reason: reason as RotationReason, at: typeof at === 'string' ? at : '' });
    }
    if (rows.length === 0) continue;
    out.set(publicId, { current, segments: rows });
  }
  return out;
}

function indexBacking(byPublic: Map<string, LineageRow>): Map<string, string> {
  const byBacking = new Map<string, string>();
  for (const [publicId, row] of byPublic) {
    for (const seg of row.segments) byBacking.set(seg.id, publicId);
  }
  return byBacking;
}

// KICK-ANCHORED READ BARRIER. Durable lineage writes are normally awaited in
// place by their caller, but two are kicked fire-and-forget onto an instance's
// `_lineageWrite` chain (`Instance._kickLineageWrite`: the `renew` rotation seen
// in `system/init`, and `dropSegment` on a missing-transcript replay). A read
// landing inside that window returns the PRE-rotation row — and the damaging
// reader is the resume path (`publicIdFor` → `resolveBacking` in
// `InstanceManager._doCreate`), which then `--resume`s the pre-clear transcript
// and orphans the renewed session's tail.
//
// So the barrier is anchored at the KICK, not at `serialize` below: `serialize`
// only orders a read behind writes already INSIDE it, while a kicked write sits
// upstream on the per-instance chain and has not enrolled yet. It is registered
// by `_kickLineageWrite` and awaited in `loadLineage` — the single chokepoint
// every reader funnels through (the three resolvers plus the session-list scan
// in `src/projects.ts`), so one await covers all four.
//
// Three facts a future editor needs:
//   - NO SELF-DEADLOCK: every mutation reads through `loadStrict`, never
//     `loadLineage`, so a write can never wait on this barrier. A new mutation
//     must keep using `loadStrict` or it wedges every read behind itself.
//   - A REJECTED WRITE IS SWALLOWED HERE, deliberately, and the read must still
//     proceed either way. For the ROTATION writer — the one this barrier exists
//     for — the failure already has an owner (`Instance._lineageError` →
//     `flushLineage` → `renew_error`), so warning again would double-report. The
//     `dropSegment` kick also lands in `_lineageError`, but nothing calls
//     `flushLineage` on that path, so its failure is reported only if a later
//     renew flush happens to pick it up. That gap predates this barrier and is
//     not closed here — the claim above is scoped to the rotation writer, not to
//     every kicked write.
//   - `mintPublicId` IS DELIBERATELY UNTRACKED (it is awaited in `launch()`), so
//     a read racing a fresh spawn can miss the brand-new row. Harmless: that is
//     the store's base case, where public id == backing id. Do not widen for it.
const inFlightWrites = new Set<Promise<unknown>>();

export function trackLineageWrite(p: Promise<unknown>): void {
  const tracked = p.then(() => {}, () => {});
  inFlightWrites.add(tracked);
  void tracked.then(() => { inFlightWrites.delete(tracked); });
}

// Bulk load, tolerant: a missing file is the legitimate empty base case, and a
// corrupt one degrades to empty (loudly) rather than breaking every read path.
export async function loadLineage(): Promise<Lineage> {
  // ONE snapshot, not a drain loop: the invariant is "a read sees every write
  // kicked BEFORE the read began". A loop would starve under a steady write
  // stream and buys nothing. Empty set (every read outside a rotation or a
  // pruned-transcript replay) ⇒ one microtask, zero I/O.
  await Promise.all([...inFlightWrites]);
  let byPublic: Map<string, LineageRow>;
  try {
    byPublic = parseLineageJson(await fs.readFile(lineageFile(), 'utf8'));
  } catch (e) {
    if (errCode(e) !== 'ENOENT') {
      console.warn(`sessionLineage: failed to read ${lineageFile()}: ${errMsg(e)}`);
    }
    byPublic = new Map();
  }
  return { byPublic, byBacking: indexBacking(byPublic) };
}

// Like loadLineage but used inside mutations (under the cross-process lock).
// Throws on I/O errors and JSON corruption rather than returning an empty map,
// so we never overwrite the store based on a failed read. ENOENT is the one
// legitimate empty base case.
async function loadStrict(): Promise<Map<string, LineageRow>> {
  try {
    return parseLineageJson(await fs.readFile(lineageFile(), 'utf8'));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map(); // legitimately empty
    throw e; // I/O error or corrupt JSON — abort the mutation
  }
}

// Serialise concurrent writers behind a per-process promise chain. We
// load → mutate → write the whole store, so without this two concurrent writers
// could race on the read-modify-write and lose a row.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeStore(byPublic: Map<string, LineageRow>): Promise<void> {
  const file = lineageFile();
  if (byPublic.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const sessions: Record<string, LineageRow> = {};
  for (const key of [...byPublic.keys()].sort((a, b) => a.localeCompare(b))) {
    sessions[key] = byPublic.get(key) as LineageRow;
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ sessions }, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Derive-check-extend AND PERSIST the `initial` row, atomically under the lock.
// The write is part of the mint on purpose: derive-check without a write lets two
// concurrent spawns reserve the same id.
//
// Collision universe = every PUBLIC id the store knows about, and only those.
//
// Backing ids are deliberately NOT in it. A candidate is a `slice(0, 8)` or
// `slice(0, 13)` of a UUID, so it can never equal a full 36-char backing id —
// testing them would be dead code in every branch. Nor is the omission a gap: the
// case it looks like it should cover is a minted public id that happens to be a
// PREFIX of another session's segment, and that is resolved one layer up, where
// an exact match always beats a prefix match (InstanceManager.resolveSessionRef;
// pinned by tests/session-prefix.test.mjs → "an exact public-id match beats a
// longer session's segment prefix"). A check here could not add anything that
// resolution does not already decide, so there is nothing for a test to kill.
//
// Only caller: Instance.launch() on a fresh spawn.
export function mintPublicId(firstBackingId: string): Promise<string> {
  return serialize(() => withLock(lineageFile(), async () => {
    const byPublic = await loadStrict(); // canonical re-read under lock
    const taken = new Set<string>(byPublic.keys());
    let publicId = firstBackingId.slice(0, PUBLIC_ID_LEN);
    if (taken.has(publicId)) {
      publicId = firstBackingId.slice(0, PUBLIC_ID_LEN_EXTENDED);
      if (taken.has(publicId)) {
        // Unique by construction (the caller minted a fresh UUID), and it lands
        // in the store's base case — but loud, because reaching here means the
        // 12-hex space collided too.
        console.warn(`sessionLineage: public id collision at ${PUBLIC_ID_LEN} and `
          + `${PUBLIC_ID_LEN_EXTENDED} chars for ${firstBackingId} — falling back to the full id`);
        publicId = firstBackingId;
      }
    }
    byPublic.set(publicId, {
      current: firstBackingId,
      segments: [{ id: firstBackingId, reason: 'initial', at: new Date().toISOString() }],
    });
    await writeStore(byPublic);
    return publicId;
  }));
}

// Append `backingId` as the newest segment and advance `current`.
//
// Creates the row LAZILY for a previously row-less session: for such a session
// the public id IS its first backing id (the base case), so promoting it to an
// `initial` segment costs nothing and is exact. Never mints.
//
// Idempotent: a no-op when `current` already is `backingId` and the trailing
// segment already carries it, so a retried write cannot double-append.
export function recordRotation(publicId: string, backingId: string, reason: RotationReason): Promise<void> {
  return serialize(() => withLock(lineageFile(), async () => {
    if (!publicId || !backingId) return;
    if (!VALID_REASONS.has(reason)) throw new Error(`sessionLineage: invalid reason '${reason}'`);
    const byPublic = await loadStrict(); // canonical re-read under lock
    const at = new Date().toISOString();
    const row = byPublic.get(publicId)
      ?? { current: publicId, segments: [{ id: publicId, reason: 'initial' as RotationReason, at }] };
    if (row.current === backingId && row.segments[row.segments.length - 1]?.id === backingId) return;
    row.segments.push({ id: backingId, reason, at });
    row.current = backingId;
    byPublic.set(publicId, row);
    await writeStore(byPublic);
  }));
}

// Undo the trailing segment IFF it is `backingId`, restoring `current` to the new
// last segment. A row that falls back to a single `initial` segment whose id
// equals the public id is DELETED — restoring the base case exactly, so a rolled
// back rotation leaves no trace.
//
// Only caller: pruneSession's rollback catch, so a throw inside launch() cannot
// leave a recorded segment the process never ran.
export function revertRotation(publicId: string, backingId: string): Promise<void> {
  return serialize(() => withLock(lineageFile(), async () => {
    if (!publicId || !backingId) return;
    const byPublic = await loadStrict(); // canonical re-read under lock
    const row = byPublic.get(publicId);
    if (!row) return;
    if (row.segments[row.segments.length - 1]?.id !== backingId) return;
    row.segments.pop();
    const last = row.segments[row.segments.length - 1];
    if (!last) {
      byPublic.delete(publicId);
    } else {
      row.current = last.id;
      const baseCase = row.segments.length === 1 && last.reason === 'initial' && last.id === publicId;
      if (baseCase) byPublic.delete(publicId);
      else byPublic.set(publicId, row);
    }
    await writeStore(byPublic);
  }));
}

// public id → its CURRENT backing id; a known segment → ITSELF; anything unknown
// → unchanged (the base case).
//
// Returning the segment itself rather than `current` is deliberate: clicking an
// archived row, or opening a wiki page that names an old segment, should open
// THAT transcript, not silently redirect to the newest one.
export async function resolveBacking(id: string): Promise<string> {
  if (!id) return id;
  const { byPublic, byBacking } = await loadLineage();
  const row = byPublic.get(id);
  if (row) return row.current;
  if (byBacking.has(id)) return id;
  return id;
}

// A known segment → its public id; a known public id → itself; anything unknown
// → unchanged (the base case).
export async function publicIdFor(id: string): Promise<string> {
  if (!id) return id;
  const { byPublic, byBacking } = await loadLineage();
  if (byPublic.has(id)) return id;
  return byBacking.get(id) ?? id;
}

// The segment chain, oldest first. `[]` when there is no row.
export async function segmentsFor(publicId: string): Promise<LineageSegment[]> {
  if (!publicId) return [];
  const { byPublic } = await loadLineage();
  return byPublic.get(publicId)?.segments ?? [];
}

// Remove `backingId` from whichever row owns it. If it was `current`, `current`
// falls back to the newest survivor; the row is deleted once empty. Called from
// the two paths that KNOW a transcript is gone — the explicit archive delete and
// loadHistory's ENOENT branch — so a chain never points at a missing file.
export function dropSegment(backingId: string): Promise<void> {
  return serialize(() => withLock(lineageFile(), async () => {
    if (!backingId) return;
    const byPublic = await loadStrict(); // canonical re-read under lock
    let ownerId: string | null = null;
    for (const [publicId, row] of byPublic) {
      if (row.segments.some(s => s.id === backingId)) { ownerId = publicId; break; }
    }
    if (ownerId === null) return;
    const row = byPublic.get(ownerId) as LineageRow;
    row.segments = row.segments.filter(s => s.id !== backingId);
    const last = row.segments[row.segments.length - 1];
    if (!last) byPublic.delete(ownerId);
    else {
      if (row.current === backingId) row.current = last.id;
      byPublic.set(ownerId, row);
    }
    await writeStore(byPublic);
  }));
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
