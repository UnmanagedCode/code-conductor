// Paged access to an instance's event history, including events evicted
// from the in-memory ring (src/instances.js EventLog). Retained events are
// served straight from the ring; older ones are reconstructed by replaying
// the persisted session jsonl through the existing machinery in
// src/transcript.js.
//
// Two seq spaces meet here. Live `_seq` values are stamped at emit time and
// are denser than replay output (one event per streaming delta vs one or
// two per persisted content block), so a from-scratch replay cannot
// reproduce evicted events seq-for-seq. Instead the replayed "archive" gets
// its own dense seqs 0..H-1 (its array indices) and is CUT at a content
// anchor so it never overlaps the retained ring:
//
//   - The ring trims onto turn boundaries (EventLog._trim snaps the head to
//     an outer user_echo), and every outer user_echo carries an absolute
//     `userIndex` matching the Nth pure-user-prompt jsonl line. When the
//     ring head is the echo for prompt N, the archive is cut strictly
//     before its own echo #N — no overlap, no gap.
//   - When the head is mid-turn (trim snapping gave up — e.g. one giant
//     turn), the archive is cut just AFTER the echo that started the turn
//     containing the head: the prompt bubble survives, the turn's partial
//     assistant content between the cut and the ring head is a gap. Gap,
//     never duplication.
//
// Served archive seqs are additionally clamped below ring.trimmedBefore so
// the two spaces can never collide; both spaces are dense and the archive
// space sits strictly below the ring space, so a combined list is globally
// sorted by `_seq` and backward paging can hand the client an opaque
// `nextBefore` cursor that works across the boundary.

import { loadPersistedTranscript } from './transcript.js';
import { isOuterUserEcho, snapStartToTurnStart } from './parser.js';
import { reconstructTasks } from './taskReconstruct.js';

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 500;
// Backward pages extend past `limit` to open on a turn boundary (see
// pageInstanceEvents); this caps the extension so a pathological runaway turn
// can't pull an unbounded page.
const TURN_SNAP_MULT = 5;

export function clampLimit(n) {
  if (!Number.isInteger(n) || n < 1) return LIMIT_DEFAULT;
  return Math.min(n, LIMIT_MAX);
}

// First index in a `_seq`-sorted array whose seq is >= `seq`.
function firstIndexAtOrAbove(arr, seq) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]._seq < seq) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Replay the persisted jsonl into a flat event list (dense `_seq` = array
// index, absolute `userIndex` stamped on outer echoes — same ordinal
// semantics as Instance._emitUi) and compute `cut`: the number of leading
// archive events that are safe to serve without overlapping the ring.
export async function buildArchive({ cwd, sessionId, ring, trimmedBefore, userEchoCount }) {
  const result = await loadPersistedTranscript({ cwd, sessionId, seqHint: 0 });
  if (!result) return { events: [], cut: 0 };

  const flat = [];
  let echoOrdinal = 0;
  for (const line of result.lines) {
    for (const ev of line.events) {
      const copy = { ...ev };
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
  let anchor;
  let includeAnchorEcho;
  if (!head) {
    // Empty ring — everything the jsonl knows about is older than "now".
    anchor = userEchoCount;
    includeAnchorEcho = false;
  } else if (isOuterUserEcho(head) && Number.isInteger(head.userIndex)) {
    // Common case: trim snapped onto a turn boundary.
    anchor = head.userIndex;
    includeAnchorEcho = false;
  } else {
    // Head is mid-turn. The turn containing it started at the prompt just
    // before the first retained echo (or the last prompt overall).
    const firstEcho = ring.find(ev => isOuterUserEcho(ev) && Number.isInteger(ev.userIndex));
    anchor = (firstEcho ? firstEcho.userIndex : userEchoCount) - 1;
    includeAnchorEcho = true;
  }

  let cut;
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
  // Safety net: keep archive seqs strictly below the ring's seq space.
  cut = Math.min(cut, Math.max(0, trimmedBefore));
  return { events: flat, cut };
}

// Page an instance's event history.
//   before — backward paging: up to `limit` events immediately preceding
//            seq `before`, oldest-first (the UI's scroll-up path). Wins
//            over `after` when both are given.
//   after  — forward paging: the first `limit` events with seq > after
//            (mirrors get_transcript's sinceSeq semantics).
//   neither — the trailing `limit` events.
// Returns { events, hasMore, nextBefore, trimmedBefore, lastSeq }.
// `nextBefore` is an opaque cursor for the next backward page; `hasMore`
// means older events than the first one served (may be optimistically true
// exactly at the ring/archive boundary — the follow-up page resolves it).
export async function pageInstanceEvents(inst, { before = null, after = null, limit } = {}) {
  const max = clampLimit(limit);
  const ring = inst.ringSnapshot();
  const tb = inst.ring.trimmedBefore;
  const lastSeq = ring.length ? ring[ring.length - 1]._seq : -1;

  if (before == null && after == null) before = lastSeq + 1;
  if (before != null) after = null; // before wins

  // Backward pages may extend up to TURN_SNAP_MULT × max below `before` to
  // land on a turn boundary — load the archive whenever that reach could
  // cross into it.
  const needArchive = tb > 0 && !!inst.sessionId
    && (before != null ? before - max * TURN_SNAP_MULT < tb : after < tb);

  let combined = ring;
  if (needArchive) {
    const archive = await buildArchive({
      cwd: inst.cwd, sessionId: inst.sessionId,
      ring, trimmedBefore: tb, userEchoCount: inst._userEchoCount,
    });
    combined = archive.events.slice(0, archive.cut).concat(ring);
  }

  let events, hasMore;
  if (before != null) {
    const end = firstIndexAtOrAbove(combined, before);
    let start = Math.max(0, end - max);
    // Turn-aligned page seams: open the window on an outer user_echo — the
    // first one inside it when present, else extend backward (bounded by
    // TURN_SNAP_MULT × max) to the echo owning the straddling turn. Every
    // page is then a whole number of complete turns, so the client's
    // isolated per-page renderer never splits an assistant bubble mid-turn
    // and every straddling block finalizes / tool pairs within its page.
    // Since the client echoes `nextBefore` (= this page's first seq), the
    // NEXT page ends exactly where this one starts — page ends are aligned
    // for free once page starts are. The helper also enforces sub-agent
    // group integrity (a child whose head is missing would be silently
    // orphaned by the renderer — conversation.js:apply → toolBlocks lookup).
    start = snapStartToTurnStart(combined, start, end,
      Math.max(0, end - max * TURN_SNAP_MULT));
    events = combined.slice(start, end);
    hasMore = start > 0
      // Served down to the very start of what we have. With the archive
      // loaded that IS the beginning; without it, older events may still
      // exist below the ring — optimistic, next page resolves.
      || (!needArchive && tb > 0 && !!inst.sessionId);
  } else {
    const start = firstIndexAtOrAbove(combined, after + 1);
    events = combined.slice(start, start + max);
    hasMore = start + events.length < combined.length;
  }

  const nextBefore = events.length ? events[0]._seq : Math.max(0, Math.min(before ?? 0, tb));
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
function injectTaskCompletions(events, completions) {
  if (!completions.length || !events.length) return events;
  const bySeq = new Map();
  for (const c of completions) {
    if (c.afterSeq != null) bySeq.set(c.afterSeq, c.tasks);
  }
  if (bySeq.size === 0) return events;
  const out = [];
  for (const ev of events) {
    out.push(ev);
    const tasks = bySeq.get(ev._seq);
    if (tasks) out.push({ kind: 'task_completion', tasks });
  }
  return out;
}
