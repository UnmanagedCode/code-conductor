// Paged access to an instance's event history, including events evicted
// from the in-memory ring (src/instances.ts EventLog). Retained events are
// served straight from the ring; older ones are reconstructed by replaying
// the persisted session jsonl through the existing machinery in
// src/transcript.ts.
//
// Two seq spaces meet here. Live `_seq` values are stamped at emit time and
// are denser than replay output — NOT per-token (the ring coalesces a block's
// thinking/text deltas into one slot, the same granularity replay produces),
// but per-turn: the live ring retains kinds the CLI never persists and replay
// therefore never emits (listed at RING_ONLY_KINDS below) — so a from-scratch
// replay cannot reproduce evicted events seq-for-seq. Instead the
// replayed "archive" gets its own dense seqs 0..H-1 (its array indices) and is
// CUT at a content anchor so it never overlaps the retained ring:
//
//   - The ring trims onto turn boundaries when it can (EventLog._trim snaps
//     the head to an outer user_echo, falling back to a quiescent point),
//     and every outer user_echo carries an absolute `userIndex` matching the
//     Nth pure-user-prompt jsonl line. When the ring head is the echo for
//     prompt N, the archive is cut strictly before its own echo #N — no
//     overlap, no gap.
//   - When the head is mid-turn (no echo in the trim's reach — e.g. one
//     giant turn), the archive is cut at the ring head's OWN content,
//     correlated by (kind, msgId, blockIdx) or a tool_result's toolUseId —
//     an exact stitch, no gap, no duplication. The echo ordinal is a
//     FALLBACK for when no correlator resolves (the head's own content was
//     itself never persisted): the archive is then cut just AFTER the echo
//     that started the turn containing the head, and the turn's partial
//     content between that cut and the ring head is a real gap — marked
//     with a `history_gap` event in the served page.
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
//
// A live rotation (a managed renew or a typed `/clear`) keeps the instance, its
// ring and its echo ordinals running while the backing jsonl changes, so the
// archive is only ever the CURRENT segment's file (EventLog.seams names which
// segment owns which ring seq range — see currentSegmentScope). A ring head that
// predates the current segment loads no archive at all; a head inside it cuts
// the file with a live→file ordinal offset measured from content
// (calibrateEchoOffset). Evicted events of EARLIER segments are never servable
// here and get one "floor" `history_gap` before the first servable event.

import type { TranscriptPlacement } from './projects.ts';
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
export interface SeqEvent extends UiEvent {
  _seq: number;
  userIndex?: number;
}

// Stamp a replayed transcript's lines into a flat archive event list: dense
// `_seq` = array index, absolute `userIndex` on outer echoes — the same ordinal
// semantics Instance._emitUi gives live events. THE one home for "replayed
// events get archive seqs"; both buildArchive and pagePersistedEvents call it,
// as does the disk-side selection in src/mcp/messageReconstruction.ts.
export function stampArchiveEvents(lines: Array<{ events: UiEvent[] }>): SeqEvent[] {
  const flat: SeqEvent[] = [];
  let echoOrdinal = 0;
  for (const line of lines) {
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
  return flat;
}

// Resolve the paging window's cursors: with neither given, page the trailing
// `limit`; `before` (backward) always wins over `after` (forward).
function normalizeWindow(before: number | null, after: number | null, lastSeq: number): { before: number | null; after: number | null } {
  if (before == null && after == null) return { before: lastSeq + 1, after: null };
  if (before != null) return { before, after: null };
  return { before: null, after };
}

// Content key for correlating a ring event against the replayed archive —
// computed identically on both sides so a hit means the two really are the
// same wire content. A `tool_result` correlates by its `toolUseId` (its
// `msgId`/`blockIdx` are meaningless); anything else needs both `msgId` and
// a numeric `blockIdx`. Returns null when neither applies.
function correlationKey(ev: UiEvent): string | null {
  if (ev.kind === 'tool_result' && typeof ev.toolUseId === 'string') return `tr ${ev.toolUseId}`;
  if (typeof ev.msgId === 'string' && typeof ev.blockIdx === 'number') return `${ev.kind} ${ev.msgId} ${ev.blockIdx}`;
  return null;
}

// First-wins index of every correlatable archive event, keyed by
// correlationKey. Built once per buildArchive call.
function buildFlatIndex(flat: SeqEvent[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < flat.length; i++) {
    const key = correlationKey(flat[i]);
    if (key != null && !index.has(key)) index.set(key, i);
  }
  return index;
}

// Kinds the ring retains that replay never produces — `replayPersistedLine`
// (src/transcript.ts) is the only replay-side event constructor, and none of
// these has a branch there. They cannot appear in `flat`, so skipping one while
// hunting for a correlatable ring event can never serve archive content the
// ring will serve again. Do NOT add a kind replay DOES emit (tool_use_start,
// thinking_start/_redacted/_end, user_question, plan_request): skipping past
// one steps over its archive twin and duplicates it.
const RING_ONLY_KINDS = new Set([
  'message_start', 'turn_end', 'assistant_message', 'tool_use_input_delta',
  'raw', 'hook', 'control_response',
  'permission_request', 'permission_resolved', 'overage_message_queued',
]);

// True when replay provably cannot have emitted a counterpart for `ev` — the
// ONLY condition under which the head scan may step over an event.
function neverPersisted(ev: UiEvent): boolean {
  if (RING_ONLY_KINDS.has(ev.kind)) return true;
  // `system` is replayed for exactly ONE subtype (replayPersistedLine's
  // soft-interrupt branch); every other subtype is a live-transport annotation
  // with no persisted line behind it. Pinned by the tripwire test in
  // tests/archive-correlated-cut.test.mjs — if replay ever emits a second
  // `system` subtype, that test fails and this carve-out must be narrowed.
  return ev.kind === 'system' && ev.subtype !== 'soft_interrupted';
}

// Correlate the ring head's own content into the replayed archive: walk
// `ring` from its start past every event replay could not have produced, then
// look the first remaining event up in `flatIndex`. A hit means that archive
// index is exactly the count of archive events strictly below the ring head's
// own content — no overlap, no hole.
function correlateRingHead(ring: SeqEvent[], flatIndex: Map<string, number>): number {
  for (const ev of ring) {
    // SKIP: structurally absent from `flat`. Keep looking.
    if (neverPersisted(ev)) continue;
    // ABANDON: this event could have been persisted, so the archive may hold it
    // below any cut we'd pick further down the ring. Both arms are genuine —
    // a null key means we cannot name it, a missing key means it was never
    // written. Neither may be skipped.
    const key = correlationKey(ev);
    if (key == null) return -1;
    const hit = flatIndex.get(key);
    return hit == null ? -1 : hit;
  }
  return -1;
}

// Locate the anchor-th outer echo in the archive and derive `cut` from it —
// the shared tail of all three non-correlated anchor cases below.
function cutFromEchoAnchor(flat: SeqEvent[], anchor: number, includeAnchorEcho: boolean): number {
  if (anchor < 0) return 0;
  let idx = -1, seen = 0;
  for (let i = 0; i < flat.length; i++) {
    if (!isOuterUserEcho(flat[i])) continue;
    if (seen === anchor) { idx = i; break; }
    seen += 1;
  }
  if (idx === -1) {
    // Archive has fewer prompts than the anchor (e.g. recent prompts not
    // yet flushed) — every archived turn predates the anchor, take all.
    return flat.length;
  }
  return includeAnchorEcho ? idx + 1 : idx;
}

// The live→file echo-ordinal offset for a ring that crossed a seam into the
// file's segment: the live ordinals count every earlier segment's echoes, and
// the file opens with a varying number of replay-only echoes the live ring
// never emitted, so no constant offset exists. Walks the ring's outer events
// remembering the latest echo E; at the first later outer event whose content
// correlates into the file at index k, E's twin is the last outer echo in the
// file at or before k. Returns twin − E, or null when no ring turn correlates.
function calibrateEchoOffset(ring: SeqEvent[], flat: SeqEvent[], flatIndex: Map<string, number>): number | null {
  let echo: SeqEvent | null = null;
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (isOuterUserEcho(ev)) {
      if (typeof ev.userIndex === 'number') echo = ev;
      continue;
    }
    if (!echo) continue;
    const key = correlationKey(ev);
    const k = key == null ? undefined : flatIndex.get(key);
    if (k == null) continue;
    for (let i = k; i >= 0; i--) {
      if (isOuterUserEcho(flat[i])) return (flat[i].userIndex as number) - (echo.userIndex as number);
    }
    return null;
  }
  return null;
}

// Which backing segment this pager can serve, from the ring's seams:
//   segmentId/startSeq — the current segment and where its ring content starts
//              (backingSessionId and 0 before the first spawn wrote a seam).
//   archivable — the ring head is inside the current segment, so its file can
//              reconstruct history below the ring.
//   priorEvicted — ring-held events of an EARLIER segment were evicted; this
//              pager can never serve them. `startSeq > 0` names an earlier
//              segment because the first seam always starts at 0
//              (EventLog.markSeam).
// With no live rotation (one seam at 0) this is `archivable = !!backingSessionId`
// and `priorEvicted = false` — the pre-rotation behaviour exactly.
export function currentSegmentScope(inst: Pick<InstanceLike, 'ring' | 'backingSessionId'>): {
  segmentId: string | null; startSeq: number; archivable: boolean; priorEvicted: boolean;
} {
  const tb = inst.ring.trimmedBefore;
  const last = inst.ring.seams.at(-1);
  const startSeq = last ? last.startSeq : 0;
  return {
    segmentId: last ? last.segmentId : inst.backingSessionId,
    startSeq,
    archivable: !!inst.backingSessionId && tb >= startSeq,
    priorEvicted: startSeq > 0 && tb > 0,
  };
}

// Replay the persisted jsonl into a flat event list (dense `_seq` = array
// index, absolute `userIndex` stamped on outer echoes — same ordinal
// semantics as Instance._emitUi) and compute `cut`: the number of leading
// archive events that are safe to serve without overlapping the ring.
// `gap` is true when the ring head is mid-turn and no correlator resolved
// (the fallback echo anchor can't reach the exact cut): the turn's content
// between the cut and the ring head was evicted and cannot be recovered —
// pageInstanceEvents marks the seam with a `history_gap` event.
//
// `segmentStartSeq` is the ring seq where `sessionId`'s segment starts
// (currentSegmentScope). 0 means the ring was filled from this file alone, so
// live and file ordinals align. Above 0 every ordinal is shifted by the
// calibrated offset, and when none can be measured nothing is served from the
// file (`cut: 0`, gap marked) — an unmeasured ordinal is never guessed. The
// precondition `ring[0]._seq >= segmentStartSeq` holds by construction: both
// callers only get here when `archivable` (tb >= startSeq), tb IS ring[0]._seq
// for a non-empty ring, and each reads the ring, tb and the scope in one
// synchronous tick before its first await.
export async function buildArchive({ place, sessionId, ring, trimmedBefore, userEchoCount, segmentStartSeq = 0 }: {
  place: TranscriptPlacement; sessionId: string; ring: SeqEvent[]; trimmedBefore: number; userEchoCount: number;
  segmentStartSeq?: number;
}): Promise<{ events: SeqEvent[]; cut: number; gap: boolean }> {
  const result = await loadPersistedTranscript({ place, sessionId, seqHint: 0 });
  if (!result) return { events: [], cut: 0, gap: trimmedBefore > 0 };

  const flat = stampArchiveEvents(result.lines);
  let flatIndex: Map<string, number> | null = null;
  const index = (): Map<string, number> => (flatIndex ??= buildFlatIndex(flat));
  // Live ordinal → file ordinal; null when the offset can't be measured.
  let offset: number | null | undefined = segmentStartSeq > 0 ? undefined : 0;
  const fileOrdinal = (live: number): number | null => {
    if (offset === undefined) offset = calibrateEchoOffset(ring, flat, index());
    return offset === null ? null : live + offset;
  };
  const uncalibrated = { events: flat, cut: 0, gap: trimmedBefore > 0 };

  // Content anchor: which prompt ordinal marks the first turn that is (at
  // least partially) represented in the retained ring.
  const head = ring.length ? ring[0] : null;
  let cut: number;
  let includeAnchorEcho: boolean;
  if (!head) {
    // Empty ring — everything the jsonl knows about is older than "now".
    const anchor = fileOrdinal(userEchoCount);
    if (anchor == null) return uncalibrated;
    cut = cutFromEchoAnchor(flat, anchor, false);
    includeAnchorEcho = false;
  } else if (isOuterUserEcho(head) && typeof head.userIndex === 'number') {
    // Common case: trim snapped onto a turn boundary.
    const anchor = fileOrdinal(head.userIndex);
    if (anchor == null) return uncalibrated;
    cut = cutFromEchoAnchor(flat, anchor, false);
    includeAnchorEcho = false;
  } else {
    // Head is mid-turn. Correlate its own content into the archive first —
    // an exact stitch, no gap. Only on a miss (no correlator resolves, e.g.
    // the head's content was itself never persisted) fall back to the
    // echo-ordinal anchor: the turn containing the head started at the
    // prompt just before the first retained echo (or the last prompt
    // overall).
    const correlated = correlateRingHead(ring, index());
    if (correlated !== -1) {
      cut = correlated;
      includeAnchorEcho = false;
    } else {
      const firstEcho = ring.find(ev => isOuterUserEcho(ev) && typeof ev.userIndex === 'number');
      const anchor = fileOrdinal(firstEcho ? firstEcho.userIndex as number : userEchoCount);
      if (anchor == null) return uncalibrated;
      cut = cutFromEchoAnchor(flat, anchor - 1, true);
      includeAnchorEcho = true;
    }
  }

  // Safety net: keep archive seqs strictly below the ring's seq space. When
  // the anchor-derived cut exceeds trimmedBefore, this clamp silently drops
  // archive events in [trimmedBefore, cut) — real evicted history — so that
  // must also mark the gap. Strict `>`: `cut === trimmedBefore` is the
  // healthy, turn-aligned case (a resumed session's ring was filled by the
  // same replay, so the two spaces align exactly) and must not mark a gap.
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

  ({ before, after } = normalizeWindow(before, after, lastSeq));

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
  //
  // Only the CURRENT segment's file is ever read, and only when the ring head
  // is inside that segment (`scope.archivable`); a head that predates it has
  // no file here to reconstruct from — the ring is the whole servable history.
  const scope = currentSegmentScope(inst);
  const needArchive = tb > 0 && scope.archivable
    && (before != null
      ? (before - max < tb || hasHeadlessChildIn(ring, Math.max(0, ringEnd - max), ringEnd))
      : (after ?? 0) < tb);

  let combined: SeqEvent[] = ring;
  let seamIdx = -1; // index of the ring head inside `combined`
  // Evicted history exists but this call couldn't reconstruct it (no
  // sessionId to replay from) — mark the gap even though needArchive is
  // false (it's gated on sessionId being present).
  let gap = tb > 0 && !inst.backingSessionId;
  // Evicted events of an earlier segment sit below combined[0]: with no
  // archive (head predates the current segment) combined[0] is the ring head;
  // with one, it is the current file's first event.
  let floorGap = !scope.archivable && tb > 0 && !!inst.backingSessionId;
  if (needArchive) {
    const archive = await buildArchive({
      place: inst.transcriptPlace, sessionId: inst.backingSessionId as string,
      ring, trimmedBefore: tb, userEchoCount: inst._userEchoCount, segmentStartSeq: scope.startSeq,
    });
    combined = archive.events.slice(0, archive.cut).concat(ring);
    seamIdx = archive.cut;
    gap = archive.gap;
    floorGap = scope.priorEvicted;
  }

  return pageCombined(combined, {
    before, after, max, seamIdx, gap, floorGap, trimmedBefore: tb, lastSeq,
    // Served down to the very start of what we have. With the archive loaded
    // that IS the beginning; without it, older events may still exist below
    // the ring — optimistic, next page resolves. Never for a head that
    // predates the current segment: nothing older is servable.
    optimisticMore: !needArchive && tb > 0 && scope.archivable,
  });
}

// The windowing core shared by the ring-backed (pageInstanceEvents) and
// disk-only (pagePersistedEvents) entry points: quiescent page seams, the
// rejected-window backstop, the `history_gap` marker and `task_completion`
// injection over an already-assembled, globally `_seq`-sorted `combined` list.
//   seamIdx  — index of the first ring-side event in `combined`, doubling as
//              the scan-opaque `resetIdx`; -1 means "no such boundary".
//   optimisticMore — the caller knows older events exist that this call did
//              not load (ring-only page above an evicted range).
//   floorGap — evicted history exists BELOW combined[0] that no page can serve
//              (an earlier segment's evicted ring events).
function pageCombined(combined: SeqEvent[], { before, after, max, seamIdx, gap, floorGap, trimmedBefore, lastSeq, optimisticMore }: {
  before: number | null; after: number | null; max: number; seamIdx: number;
  gap: boolean; floorGap: boolean; trimmedBefore: number; lastSeq: number; optimisticMore: boolean;
}): { events: UiEvent[]; hasMore: boolean; nextBefore: number; trimmedBefore: number; lastSeq: number } {
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
  if (before != null) {
    const end = firstIndexAtOrAbove(combined, before);
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
    // The snap can reject the whole window (its only content was sub-agent
    // children with no reachable head inside [start, end)). Back off to the
    // last quiescent cut at or below the window's own pre-snap start instead
    // of serving nothing — the rejected content is still ahead of `end` on
    // some earlier page and must eventually be served, not skipped.
    if (start >= end) start = lastQuiescentAtOrBefore(combined, rawStart, { resetIdx: seamIdx });
    servedStart = start;
    events = combined.slice(start, end);
    hasMore = start > 0 || optimisticMore;
  } else {
    const start = firstIndexAtOrAbove(combined, (after ?? 0) + 1);
    servedStart = start;
    events = combined.slice(start, start + max);
    hasMore = start + events.length < combined.length;
  }

  // A backward page is empty only when the window itself is empty (`end ===
  // 0`), which is terminal: `end === 0` forces `needArchive` (or no
  // `sessionId`), so `optimisticMore` is false and `hasMore` is false. The
  // backstop above (`start >= end`) guarantees any non-empty window is served.
  const nextBefore = events.length ? events[0]._seq as number : 0;

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
    const seamAnchor = seamIdx >= 0 ? seamIdx : 0;
    const at = seamAnchor - servedStart;
    if (at >= 0 && at <= events.length) events.splice(at, 0, { kind: 'history_gap' });
    else if (at < 0 && !hasMore) events.push({ kind: 'history_gap' });
  }
  // The floor marker: before combined[0], only ever spliced at offset 0 and
  // never appended by the backstop above. A backward page carries it when it
  // starts at combined[0]; a forward page only when its requested window
  // reaches the evicted seqs — `after < 0` (the walk starts at the floor), or
  // `after + 1` below combined[0]'s seq (a no-archive ring head above an
  // evicted range) — so an incremental poll from above never does. A seam
  // marker already at offset 0 (`cut === 0`) marks the adjacent loss too.
  if (floorGap && servedStart === 0 && events[0]?.kind !== 'history_gap'
      && (before != null || (after as number) < 0 || (after as number) + 1 < (combined[0]?._seq ?? 0))) {
    events.unshift({ kind: 'history_gap' });
  }
  // Inject synthetic `task_completion` bubbles below the tail. Derived over the
  // full `combined` history (so batches spanning page boundaries are correct),
  // spliced into the served slice after the completing TaskUpdate. Completions
  // at seq >= tailStartSeq are never served here (pages page strictly below the
  // tail), so this never doubles the tail's client-synthesized bubbles.
  const { completions } = reconstructTasks(combined);
  return {
    events: injectTaskCompletions(events, completions),
    hasMore, nextBefore, trimmedBefore, lastSeq,
  };
}

// Page a session's events straight off the persisted jsonl, with no instance
// and no ring — the retired-session read path (src/mcp/handlers.ts
// getInstOrDisk). The whole replayed transcript IS the history, so there is no
// archive/ring seam (`seamIdx: -1`, its existing "no scan-opaque boundary"
// meaning) and nothing was evicted-and-unreconstructable (`gap: false`,
// `trimmedBefore: 0`).
export async function pagePersistedEvents({ place, sessionId, before = null, after = null, limit }: {
  place: TranscriptPlacement; sessionId: string; before?: number | null; after?: number | null; limit?: number;
}): Promise<{ events: UiEvent[]; hasMore: boolean; nextBefore: number; trimmedBefore: number; lastSeq: number }> {
  const max = clampLimit(limit);
  const result = await loadPersistedTranscript({ place, sessionId, seqHint: 0 });
  if (!result) return { events: [], hasMore: false, nextBefore: 0, trimmedBefore: 0, lastSeq: -1 };
  const flat = stampArchiveEvents(result.lines);
  const lastSeq = flat.length - 1;
  const w = normalizeWindow(before, after, lastSeq);
  return pageCombined(flat, {
    before: w.before, after: w.after, max, seamIdx: -1, gap: false, floorGap: false,
    trimmedBefore: 0, lastSeq, optimisticMore: false,
  });
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
