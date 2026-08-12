// Paged access to an instance's event history, including events evicted
// from the in-memory ring (src/instances.ts EventLog). Retained events are
// served straight from the ring; older ones are reconstructed by replaying
// the persisted session jsonl through the existing machinery in
// src/transcript.ts.
//
// Two seq spaces meet here. Live `_seq` values are stamped at emit time and
// are denser than replay output — NOT per-token (the ring coalesces a block's
// thinking/text deltas into one slot, the same granularity replay produces),
// but per-turn: the live ring retains `message_start` and `turn_end`, and the
// CLI persists neither, so replay emits neither (src/transcript.ts) — so a
// from-scratch replay cannot reproduce evicted events seq-for-seq. Instead the
// replayed "archive" gets its own dense seqs 0..H-1 (its array indices) and is
// CUT at a content anchor so it never overlaps the retained ring:
//
//   - The ring trims onto turn boundaries when it can (EventLog._trim snaps
//     the head to an outer user_echo, falling back to a quiescent point),
//     and every outer user_echo carries an absolute `userIndex` matching the
//     Nth pure-user-prompt jsonl line. When the ring head is the echo for
//     prompt N, the archive is cut strictly before its own echo #N — no
//     overlap, no gap. The echo ordinal is the ONLY correlator between the
//     two seq spaces, which is why the stitch stays turn-anchored even
//     though page seams themselves are quiescent-aligned.
//   - When the head is mid-turn (no echo in the trim's reach — e.g. one
//     giant turn), the archive is cut just AFTER the echo that started the
//     turn containing the head: the prompt bubble survives, the turn's
//     partial content between the cut and the ring head is a gap — marked
//     with a `history_gap` event in the served page. Gap, never duplication.
//
// Served archive seqs are additionally clamped below ring.trimmedBefore so
// the two spaces can never collide; both spaces are dense and the archive
// space sits strictly below the ring space, so a combined list is globally
// sorted by `_seq` and backward paging can hand the client an opaque
// `nextBefore` cursor that works across the boundary.
//
// The mid-turn head is not the only gap cause: `gap` must be true whenever
// evicted history exists that this call could not reconstruct. That also
// covers an unreadable/missing jsonl (buildArchive can't replay anything),
// the trimmedBefore clamp above discarding archive events past its own
// anchor-derived cut (denser replay than the live evicted span), and a
// trimmed ring with no sessionId to replay from at all.

import { loadPersistedTranscript } from './transcript.ts';
import { hasHeadlessChildIn, isOuterUserEcho, lastQuiescentAtOrBefore, snapStartToQuiescent, type UiEvent } from './parser.ts';
import { reconstructTasks, type TaskCompletion, type TaskRecord } from './taskReconstruct.ts';
import type { InstanceLike } from './instanceTypes.ts';

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 500;

export function clampLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return LIMIT_DEFAULT;
  return Math.min(n, LIMIT_MAX);
}

// First index in a `_seq`-sorted array whose seq is >= `seq`.
function firstIndexAtOrAbove(arr: SeqEvent[], seq: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]._seq < seq) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// A ring/archive event carries a dense `_seq`; outer user echoes additionally
// carry an absolute `userIndex` (stamped by Instance._emitUi / buildArchive).
// Synthetic events (`history_gap`, `task_completion`) have neither and are
// represented as plain UiEvent.
interface SeqEvent extends UiEvent {
  _seq: number;
  userIndex?: number;
}

// Replay the persisted jsonl into a flat event list (dense `_seq` = array
// index, absolute `userIndex` stamped on outer echoes — same ordinal
// semantics as Instance._emitUi) and compute `cut`: the number of leading
// archive events that are safe to serve without overlapping the ring.
// `gap` is true when the ring head is mid-turn (the trim couldn't reach a
// turn boundary): the turn's content between the cut and the ring head was
// evicted and cannot be recovered — pageInstanceEvents marks the seam with
// a `history_gap` event.
export async function buildArchive({ cwd, sessionId, ring, trimmedBefore, userEchoCount }: {
  cwd: string; sessionId: string; ring: SeqEvent[]; trimmedBefore: number; userEchoCount: number;
}): Promise<{ events: SeqEvent[]; cut: number; gap: boolean }> {
  const result = await loadPersistedTranscript({ cwd, sessionId, seqHint: 0 });
  if (!result) return { events: [], cut: 0, gap: trimmedBefore > 0 };

  const flat: SeqEvent[] = [];
  let echoOrdinal = 0;
  for (const line of result.lines) {
    for (const ev of line.events) {
      const copy = { ...ev } as SeqEvent;
      if (isOuterUserEcho(copy)) {
        copy.userIndex = echoOrdinal;
        echoOrdinal += 1;
      }
      copy._seq = flat.length;
      flat.push(copy);
    }
  }

  // Content anchor: which prompt ordinal marks the first turn that is (at
  // least partially) represented in the retained ring.
  const head = ring.length ? ring[0] : null;
  let anchor: number;
  let includeAnchorEcho: boolean;
  if (!head) {
    // Empty ring — everything the jsonl knows about is older than "now".
    anchor = userEchoCount;
    includeAnchorEcho = false;
  } else if (isOuterUserEcho(head) && typeof head.userIndex === 'number') {
    // Common case: trim snapped onto a turn boundary.
    anchor = head.userIndex;
    includeAnchorEcho = false;
  } else {
    // Head is mid-turn. The turn containing it started at the prompt just
    // before the first retained echo (or the last prompt overall).
    const firstEcho = ring.find(ev => isOuterUserEcho(ev) && typeof ev.userIndex === 'number');
    anchor = (firstEcho ? firstEcho.userIndex as number : userEchoCount) - 1;
    includeAnchorEcho = true;
  }

  let cut: number;
  if (anchor < 0) {
    cut = 0;
  } else {
    // Locate the anchor-th outer echo in the archive.
    let idx = -1, seen = 0;
    for (let i = 0; i < flat.length; i++) {
      if (!isOuterUserEcho(flat[i])) continue;
      if (seen === anchor) { idx = i; break; }
      seen += 1;
    }
    if (idx === -1) {
      // Archive has fewer prompts than the anchor (e.g. recent prompts not
      // yet flushed) — every archived turn predates the anchor, take all.
      cut = flat.length;
    } else {
      cut = includeAnchorEcho ? idx + 1 : idx;
    }
  }
  // Safety net: keep archive seqs strictly below the ring's seq space. When
  // the anchor-derived cut exceeds trimmedBefore, this clamp silently drops
  // archive events in [trimmedBefore, cut) — real evicted history — so that
  // must also mark the gap.
  const clampedCut = Math.min(cut, Math.max(0, trimmedBefore));
  const clampDroppedContent = cut > trimmedBefore;
  cut = clampedCut;
  return { events: flat, cut, gap: includeAnchorEcho || clampDroppedContent };
}

// Page an instance's event history.
//   before — backward paging: up to `limit` events immediately preceding
//            seq `before`, oldest-first (the UI's scroll-up path). Wins
//            over `after` when both are given.
//   after  — forward paging: the first `limit` events with seq > after,
//            EXCLUSIVE (mirrors the REST `after=` cursor; get_transcript's
//            own `fromSeq` is inclusive and translates to this at its
//            boundary in src/mcp/handlers.ts, not here).
//   neither — the trailing `limit` events.
// Returns { events, hasMore, nextBefore, trimmedBefore, lastSeq }.
// `nextBefore` is an opaque cursor for the next backward page; `hasMore`
// means older events than the first one served (may be optimistically true
// exactly at the ring/archive boundary — the follow-up page resolves it).
export async function pageInstanceEvents(inst: InstanceLike, { before = null, after = null, limit }: {
  before?: number | null; after?: number | null; limit?: number;
} = {}): Promise<{ events: UiEvent[]; hasMore: boolean; nextBefore: number; trimmedBefore: number; lastSeq: number }> {
  const max = clampLimit(limit);
  const ring = inst.ringSnapshot();
  const tb = inst.ring.trimmedBefore;
  const lastSeq = ring.length ? ring[ring.length - 1]._seq : -1;

  if (before == null && after == null) before = lastSeq + 1;
  if (before != null) after = null; // before wins

  // Load the archive whenever the tentative window itself dips below the
  // ring. The quiescent snap can never reach below the ring head from inside
  // the ring (the trim keeps the head on a boundary, which terminates the
  // backward search), so quiescence needs no extra reach margin.
  //
  // Group integrity does, though: heads are resolved over the WHOLE loaded
  // array, not bounded by the ring head. A ring-side sub-agent child whose
  // `tool_use` head was evicted reads as headless from inside the ring, so the
  // snap pushes the window start past it and the child is served by no page at
  // all — the only page whose window covers it is this one. So a headless
  // child in the tentative ring window also forces the replay; the head is
  // usually archive-side and the group then reunites on one page. (Not
  // guaranteed — a mid-turn `cut` can have sliced the head away too. That
  // costs one wasted replay in the degenerate case and changes nothing else.)
  const ringEnd = before != null ? firstIndexAtOrAbove(ring, before) : 0;
  const needArchive = tb > 0 && !!inst.backingSessionId
    && (before != null
      ? (before - max < tb || hasHeadlessChildIn(ring, Math.max(0, ringEnd - max), ringEnd))
      : (after ?? 0) < tb);

  let combined: SeqEvent[] = ring;
  let seamIdx = -1; // index of the ring head inside `combined`
  // Evicted history exists but this call couldn't reconstruct it (no
  // sessionId to replay from) — mark the gap even though needArchive is
  // false (it's gated on sessionId being present).
  let gap = tb > 0 && !inst.backingSessionId;
  if (needArchive) {
    const archive = await buildArchive({
      cwd: inst.cwd, sessionId: inst.backingSessionId as string,
      ring, trimmedBefore: tb, userEchoCount: inst._userEchoCount,
    });
    combined = archive.events.slice(0, archive.cut).concat(ring);
    seamIdx = archive.cut;
    gap = archive.gap;
  }

  let events: UiEvent[];
  let hasMore: boolean;
  // Index in `combined` of this page's first served event, in BOTH directions
  // — the served slice is always `combined.slice(servedStart, …)`, so it turns
  // a `combined` index into an offset inside `events`. Used by the gap marker.
  let servedStart = 0;
  // The backward window BEFORE the quiescent snap moved its start. When the
  // snap rejects the whole window the page is empty, and this is the cursor
  // the next page resumes from — see `nextBefore` below.
  let rawStart = 0;
  // The backward window's end, hoisted for the empty-page cursor's seam clamp.
  let rawEnd = 0;
  if (before != null) {
    const end = firstIndexAtOrAbove(combined, before);
    rawEnd = end;
    rawStart = Math.max(0, end - max);
    let start = rawStart;
    // Quiescent page seams: open the window where reconstruction has no open
    // block and no unresolved tool — the first quiescent index inside the
    // window when present, else the nearest one below it. Every page then
    // contains only whole blocks and complete tool round-trips, so the
    // client's isolated per-page renderer never shows a half block. Since
    // the client echoes `nextBefore` (= this page's first seq), the NEXT
    // page ends exactly where this one starts — page ends are aligned for
    // free once page starts are. The helper also enforces sub-agent group
    // integrity (a child whose head is missing would be silently orphaned by
    // the renderer — conversation.js:apply → toolBlocks lookup), which is
    // what keeps NESTED blocks whole across seams. The archive→ring seam
    // (`resetIdx`) is a scan-opaque boundary: state is never computed across
    // the possibly-missing events.
    start = snapStartToQuiescent(combined, start, end, { resetIdx: seamIdx });
    servedStart = start;
    events = combined.slice(start, end);
    hasMore = start > 0
      // Served down to the very start of what we have. With the archive
      // loaded that IS the beginning; without it, older events may still
      // exist below the ring — optimistic, next page resolves.
      || (!needArchive && tb > 0 && !!inst.backingSessionId);
  } else {
    const start = firstIndexAtOrAbove(combined, (after ?? 0) + 1);
    servedStart = start;
    events = combined.slice(start, start + max);
    hasMore = start + events.length < combined.length;
  }

  // An empty backward page means the snap rejected this whole window (its only
  // content was sub-agent children with no reachable head). Resume from the
  // window's own pre-snap start, NOT from `trimmedBefore`: collapsing to the
  // top of the archive would skip every seq in [trimmedBefore, before), most of
  // which is ordinary servable content the resolver never rejected.
  //
  // The pre-snap start is snapped DOWN to a quiescent cut first, because every
  // cursor is also the next page's `end`, and a page is self-contained only if
  // both its ends are quiescent. On a served page that holds for free (the
  // cursor is the snapped start); an empty page has no snapped start, and
  // `rawStart` is under no such obligation — handing it out raw yields a next
  // page ending mid-block or mid-tool-round-trip.
  //
  // `cursorIdx < end` whenever `end > 0` (it is at or below `rawStart`, except
  // for the seam clamp below, which stays under `end` by its own guard), and
  // `combined[end - 1]._seq < before`, so this is strictly below `before` — a
  // client can never re-request the cursor it just sent. `end === 0` implies
  // the archive was loaded (a ring-only window sits above `trimmedBefore` and
  // so has `end > 0`), hence `hasMore` is false there and the cursor is
  // terminal, not stalled.
  //
  // One clamp on top of that back-off: the cursor may not step past the
  // archive/ring seam in a single jump. Backward pages TILE — the next page's
  // `end` is this page's cursor — and the gap marker below is anchored to the
  // seam's position, so it needs some page to end at the seam or straddle it.
  // Served pages tile for free (their cursor is their own served start); an
  // empty page is the one that can jump the seam, and when its cursor lands
  // strictly below `seamIdx` the seam becomes neither a page boundary nor
  // interior to any served slice, and the marker is dropped on every page of
  // the walk (2026-0054 C1). Clamping to `seamIdx` re-establishes the tiling
  // at exactly the index that matters: the next page then ENDS on the seam and
  // carries the marker. The clamp only ever raises the cursor, so it shrinks
  // the rejected window rather than widening it — the events between
  // `rawStart` and the seam get served instead of skipped — and `seamIdx <
  // rawEnd` keeps it strictly below `before`, so progress and termination are
  // unaffected. It cannot re-fire on the next page: that page's `end` IS
  // `seamIdx`, and the guard is strict.
  let cursorIdx = 0;
  if (before != null && !events.length) {
    cursorIdx = lastQuiescentAtOrBefore(combined, rawStart, { resetIdx: seamIdx });
    if (seamIdx > cursorIdx && seamIdx < rawEnd) cursorIdx = seamIdx;
  }
  const nextBefore = events.length
    ? events[0]._seq as number
    : (before != null ? (combined[cursorIdx]?._seq as number | undefined) ?? 0 : 0);

  // Mark the evicted-content seam with a `{kind:'history_gap'}` event (no
  // `_seq`, matching task_completion's synthesis), so the client renders an
  // "earlier messages unavailable" divider instead of silently gluing the
  // surviving whole blocks together.
  //
  // The marker is anchored to the seam's POSITION in `combined`, not to the
  // ring-head event happening to be inside the served slice. The seam is a
  // boundary between two pages, and the page that ends exactly on it carries
  // the last archive event, not the ring head — anchoring on the head put the
  // marker on whichever page happened to serve `_seq === trimmedBefore`, or,
  // failing that, on the terminal page far below the real boundary
  // (2026-0054). `seamAnchor` is the index of the first ring-side event:
  // `archive.cut` when the archive was loaded, else 0 (combined IS the ring,
  // so the whole of it is ring-side — that is the no-`sessionId` gap branch).
  // Deliberately NOT `seamIdx` itself: that doubles as `resetIdx` for both
  // `snapStartToQuiescent` and `lastQuiescentAtOrBefore`, and its -1 means
  // "no scan-opaque boundary", not "the seam is at 0".
  //
  // `at === events.length` is in range on purpose: it is the common case, the
  // page whose window ENDS at the seam, where the marker is the last event.
  //
  // Backstop: the seam sits strictly BELOW everything this page serves (so no
  // splice offset exists) and paging ends here, so no lower page will ever
  // carry it — the eviction would go unmarked. Only forward (`after`) pages
  // reach this: a backward page with `!hasMore` has `start === 0`, hence
  // `at >= 0`. Do NOT widen it back to "any page that missed the seam" — in a
  // mid-turn-head fixture the page above already carried the marker and this
  // would emit a second one.
  if (gap) {
    const seamAnchor = needArchive ? seamIdx : 0;
    const at = seamAnchor - servedStart;
    if (at >= 0 && at <= events.length) events.splice(at, 0, { kind: 'history_gap' });
    else if (at < 0 && !hasMore) events.push({ kind: 'history_gap' });
  }
  // Inject synthetic `task_completion` bubbles below the tail. Derived over the
  // full `combined` history (so batches spanning page boundaries are correct),
  // spliced into the served slice after the completing TaskUpdate. Completions
  // at seq >= tailStartSeq are never served here (pages page strictly below the
  // tail), so this never doubles the tail's client-synthesized bubbles.
  const { completions } = reconstructTasks(combined);
  return {
    events: injectTaskCompletions(events, completions),
    hasMore, nextBefore, trimmedBefore: tb, lastSeq,
  };
}

// Splice `{kind:'task_completion', tasks}` (no `_seq`, matching the client's own
// synthesis) into `events` immediately after each event whose `_seq` is the
// completing update of a batch. Unmatched completions (outside this slice) drop.
function injectTaskCompletions(events: UiEvent[], completions: TaskCompletion[]): UiEvent[] {
  if (!completions.length || !events.length) return events;
  const bySeq = new Map<number, TaskRecord[]>();
  for (const c of completions) {
    if (c.afterSeq != null) bySeq.set(c.afterSeq, c.tasks);
  }
  if (bySeq.size === 0) return events;
  const out: UiEvent[] = [];
  for (const ev of events) {
    out.push(ev);
    const seq = ev._seq;
    if (typeof seq === 'number') {
      const tasks = bySeq.get(seq);
      if (tasks) out.push({ kind: 'task_completion', tasks });
    }
  }
  return out;
}
