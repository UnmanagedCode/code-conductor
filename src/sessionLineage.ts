// A session's IDENTITY: its PERMANENT public id and the chain of rotating
// CLI-side *backing* ids it has run under. The chain is the `current` +
// `segments` of the session's record in the unified store (src/sessionStore.ts);
// this module owns the rules for it and runs over that store's `mutateSessions`
// and `loadSessions`.
//
// A session's public id is minted once (mintPublicId) from the first 8 hex chars
// of its first backing id and never changes again. Every later rotation — a
// `/clear` (`renew`, managed or typed) or a context prune (`prune`) — appends a
// segment and advances `current`. That is what lets a conductor hold one id for
// the life of a worker while the CLI rotates its own `session_id` underneath.
//
// BASE CASE, not a legacy branch: a session with no record, or whose record is a
// single `initial` segment named by its own key, has public id == backing id.
// Every resolver below returns its input unchanged for an unknown id, so a
// session that has never rotated and was never minted needs nothing recorded.
//
// `reason` is load-bearing, not polish. Every segment's file survives on disk in
// both mechanisms, so segments are uniform for IDENTITY — but not for CONTENT: a
// `renew` segment is DISJOINT from its predecessor (full history is their
// concatenation), while a `prune` segment is a filtered COPY that OVERLAPS it
// (src/sessionPrune.ts writes a new file and leaves the original untouched) and
// must never be concatenated. `reason` alone carries this — do NOT add a second
// boolean that can disagree with it.
//
// ROTATION, one path for all three mechanisms: recordRotation appends the new
// segment — which inherits its predecessor's `temp` in the same write — and
// retireSegment then archives the old segment (temp off, archived on). Session
// facts are keyed by the public id, so a rotation never touches them.
//
// TOMBSTONES. A segment whose transcript is gone for good is not removed but
// marked `dropped: true` in place (dropSegment), so the one reader that walks the
// chain's SHAPE — the lineage scroll-back (src/lineagePager.ts, via chainFor) —
// still sees where it was. Every other reader sees live segments only. The
// record invariant (src/sessionStore.ts) holds across every mutation here: a
// mutation that would leave no live segment deletes the record, and with it
// every session fact — so only the explicit session delete is allowed to (and,
// for a whole record with no transcript left, the boot cleanup's
// removeSessionRecords in src/sessionStore.ts).

import {
  mutateSessions, loadSessions, liveSegments, ensureSegment, trackLineageWrite, VALID_REASONS,
  type RotationReason, type Segment, type SessionRecord, type SessionIndex, type SessionsDoc,
} from './sessionStore.ts';

export { trackLineageWrite };
export type { RotationReason };
export type LineageSegment = Segment;
export type LineageRow = SessionRecord;
export type Lineage = SessionIndex;

// The public id is the first 8 hex chars of the first backing id. A UUID has no
// dash in its first 8 chars, so this is 8 hex digits — the form the conductor
// role doc, the UI and ambiguousRefusal already use.
export const PUBLIC_ID_LEN = 8;
// On collision, extend to `xxxxxxxx-xxxx` (12 hex digits). Chosen over stripping
// the dash because it stays a literal PREFIX of the backing UUID, so it never
// stops being prefix-resolvable.
export const PUBLIC_ID_LEN_EXTENDED = 13;

// A record's live segment ids, oldest first — segmentsFor's answer for a caller
// already holding the index, so a per-row loop never re-reads the store.
export function liveSegmentIdsOf(row: LineageRow): string[] {
  return liveSegments(row).map(s => s.id);
}

// The store index, behind the kicked-write read barrier (src/sessionStore.ts).
export async function loadLineage(): Promise<Lineage> {
  return loadSessions();
}

const unchanged = { changed: false, value: undefined } as const;
const wrote = { changed: true, value: undefined } as const;

// Derive-check-extend AND PERSIST the `initial` segment, atomically under the
// lock. The write is part of the mint on purpose: derive-check without a write
// lets two concurrent spawns reserve the same id.
//
// Collision universe = every PUBLIC id the store knows about, and only those.
// A candidate is a `slice(0, 8)` or `slice(0, 13)` of a UUID, so it can never
// equal a full 36-char backing id. The case it looks like it should cover — a
// minted public id that is a PREFIX of another session's segment — is resolved
// one layer up, where an exact match always beats a prefix match
// (InstanceManager.resolveSessionRef; pinned by tests/session-prefix.test.mjs →
// "an exact public-id match beats a longer session's segment prefix").
//
// Only caller: Instance.launch() on a fresh spawn.
export function mintPublicId(firstBackingId: string): Promise<string> {
  return mutateSessions('mintPublicId', firstBackingId, (doc) => {
    let publicId = firstBackingId.slice(0, PUBLIC_ID_LEN);
    if (doc.has(publicId)) {
      publicId = firstBackingId.slice(0, PUBLIC_ID_LEN_EXTENDED);
      if (doc.has(publicId)) {
        // Unique by construction (the caller minted a fresh UUID), and it lands
        // in the store's base case — but loud, because reaching here means the
        // 12-hex space collided too.
        console.warn(`sessionLineage: public id collision at ${PUBLIC_ID_LEN} and `
          + `${PUBLIC_ID_LEN_EXTENDED} chars for ${firstBackingId} — falling back to the full id`);
        publicId = firstBackingId;
      }
    }
    doc.set(publicId, {
      current: firstBackingId,
      segments: [{ id: firstBackingId, reason: 'initial', at: new Date().toISOString() }],
    });
    return { changed: true, value: publicId };
  });
}

// Append `backingId` as the newest segment and advance `current`. The new
// segment inherits its predecessor's `temp` flag in the same write, so a temp
// session never has a window where its live transcript reads as persistent.
//
// Creates the record LAZILY for a previously record-less session: for such a
// session the public id IS its first backing id (the base case), so promoting it
// to an `initial` segment costs nothing and is exact. Never mints.
//
// Idempotent: a no-op when `current` already is `backingId` and the newest LIVE
// segment already carries it, so a retried write cannot double-append.
export function recordRotation(publicId: string, backingId: string, reason: RotationReason): Promise<void> {
  if (!publicId || !backingId) return Promise.resolve();
  if (!VALID_REASONS.has(reason)) return Promise.reject(new Error(`sessionLineage: invalid reason '${reason}'`));
  const done = (rec: SessionRecord | undefined): boolean =>
    rec?.current === backingId && liveSegments(rec).at(-1)?.id === backingId;
  return mutateSessions('recordRotation', backingId, (doc) => {
    const at = new Date().toISOString();
    const rec = doc.get(publicId) ?? { current: publicId, segments: [{ id: publicId, reason: 'initial' as RotationReason, at }] };
    if (done(rec)) return unchanged;
    const predecessor = rec.segments.find(s => s.id === rec.current && !s.dropped);
    rec.segments.push({ id: backingId, reason, at, ...(predecessor?.temp ? { temp: true as const } : {}) });
    rec.current = backingId;
    doc.set(publicId, rec);
    return wrote;
  }, (doc) => (done(doc.get(publicId)) ? { value: undefined } : null));
}

function retired(seg: Segment): boolean {
  return seg.archived === true && seg.temp !== true;
}

// Retire transcripts no process will write again: temp off, archived on, in ONE
// mutation however many ids. A dropped segment is left alone, and a segment
// write naming an `owner` that lacks the segment is refused (sessionStore's
// ensureSegment). Reachable from kicked writes, so it never awaits the barrier.
export function retireSegments(backingIds: string[], { owner }: { owner?: string | null } = {}): Promise<void> {
  const ids = [...new Set(backingIds.filter(id => typeof id === 'string' && id))];
  if (ids.length === 0) return Promise.resolve();
  const allRetired = (doc: SessionsDoc): boolean => ids.every((id) => {
    const hit = ensureSegment(doc, id, { owner, create: false });
    return hit !== null && !('refused' in hit) && retired(hit.segment);
  });
  return mutateSessions('retireSegment', ids.join(','), (doc) => {
    let changed = false;
    for (const id of ids) {
      const hit = ensureSegment(doc, id, { owner });
      if (hit === null || 'refused' in hit) {
        console.warn(`sessionStore: retireSegment ${id} refused: ${hit ? hit.refused : 'unresolvable'}`);
        continue;
      }
      if (retired(hit.segment)) continue;
      delete hit.segment.temp;
      hit.segment.archived = true;
      changed = true;
    }
    return { changed, value: undefined };
  }, (doc) => (allRetired(doc) ? { value: undefined } : null));
}

export function retireSegment(backingId: string | null | undefined, opts: { owner?: string | null } = {}): Promise<void> {
  return backingId ? retireSegments([backingId], opts) : Promise.resolve();
}

// Undo the newest LIVE segment IFF it is `backingId` (trailing tombstones stay),
// restoring `current` to the newest live segment left. The record is KEPT even
// when what remains is the base case: it holds the session's facts, and a
// single-`initial` record resolves exactly as no record does.
//
// Only caller: pruneSession's rollback catch, so a throw inside launch() cannot
// leave a recorded segment the process never ran.
export function revertRotation(publicId: string, backingId: string): Promise<void> {
  if (!publicId || !backingId) return Promise.resolve();
  return mutateSessions('revertRotation', backingId, (doc) => {
    const rec = doc.get(publicId);
    if (!rec) return unchanged;
    const target = liveSegments(rec).at(-1);
    if (target?.id !== backingId) return unchanged;
    rec.segments.splice(rec.segments.lastIndexOf(target), 1);
    const last = liveSegments(rec).at(-1);
    if (!last) doc.delete(publicId);
    else rec.current = last.id;
    return wrote;
  });
}

// public id → its CURRENT backing id; a known segment → ITSELF; anything unknown
// → unchanged (the base case).
//
// Returning the segment itself rather than `current` is deliberate: clicking an
// archived row, or opening a wiki page that names an old segment, should open
// THAT transcript, not silently redirect to the newest one.
export async function resolveBacking(id: string): Promise<string> {
  if (!id) return id;
  const { byPublic } = await loadLineage();
  return byPublic.get(id)?.current ?? id;
}

// A known segment → its public id; a known public id → itself; anything unknown
// → unchanged (the base case).
export async function publicIdFor(id: string): Promise<string> {
  if (!id) return id;
  const { byPublic, byBacking } = await loadLineage();
  if (byPublic.has(id)) return id;
  return byBacking.get(id) ?? id;
}

// The live segment chain, oldest first. `[]` when there is no record.
export async function segmentsFor(publicId: string): Promise<LineageSegment[]> {
  if (!publicId) return [];
  const row = (await loadLineage()).byPublic.get(publicId);
  return row ? liveSegments(row) : [];
}

// The FULL chain, tombstones included, oldest first. `[]` when there is no record.
// Only the lineage scroll-back reads this; every other reader wants segmentsFor.
export async function chainFor(publicId: string): Promise<LineageSegment[]> {
  if (!publicId) return [];
  return (await loadLineage()).byPublic.get(publicId)?.segments ?? [];
}

// Tombstone `backingId` in whichever record owns it, clearing its temp/archived
// flags. If it was `current`, `current` falls back to the newest live segment;
// the record — and every session fact on it — is deleted once none is left. An
// already-tombstoned id is a no-op with no write.
//
// `unlessLast`: do nothing when this is the record's LAST live segment. Every
// caller but the explicit session delete passes it — a respawn of a session
// killed before its first turn finds no transcript, and must not take the
// session's temp/title/mode with it.
export function dropSegment(backingId: string, { unlessLast = false }: { unlessLast?: boolean } = {}): Promise<void> {
  if (!backingId) return Promise.resolve();
  return mutateSessions('dropSegment', backingId, (doc) => {
    let ownerId: string | null = null;
    for (const [publicId, rec] of doc) {
      if (rec.segments.some(s => s.id === backingId)) { ownerId = publicId; break; }
    }
    if (ownerId === null) return unchanged;
    const rec = doc.get(ownerId) as SessionRecord;
    const entry = rec.segments.find(s => s.id === backingId) as Segment;
    if (entry.dropped) return unchanged;
    const rest = liveSegments(rec).filter(s => s !== entry);
    if (rest.length === 0) {
      if (unlessLast) return unchanged;
      doc.delete(ownerId);
      return wrote;
    }
    entry.dropped = true;
    delete entry.temp;
    delete entry.archived;
    if (rec.current === backingId) rec.current = (rest.at(-1) as Segment).id;
    return wrote;
  });
}
