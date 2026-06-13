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

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 500;

export function clampLimit(n) {
  if (!Number.isInteger(n) || n < 1) return LIMIT_DEFAULT;
  return Math.min(n, LIMIT_MAX);
}

function isOuterUserEcho(ev) {
  return ev?.kind === 'user_echo' && !ev.parentToolUseId;
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

  const needArchive = tb > 0 && !!inst.sessionId
    && (before != null ? before - max < tb : after < tb);

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
    // Turn-aligned page seams: advance the window start to the first outer
    // user_echo inside it (only when older events remain below — never
    // empties the page since the echo is strictly before `end`).
    if (start > 0) {
      for (let i = start; i < end; i++) {
        if (isOuterUserEcho(combined[i])) { start = i; break; }
      }
    }
    // Group-integrity snap: extend start backward so that every sub-agent
    // child event in [start..end) has its owning tool-call head present in
    // the same range. A child whose head is missing would be silently
    // orphaned by the renderer (conversation.js:apply → toolBlocks lookup).
    // Loop because pulling start back can expose deeper nesting.
    if (start > 0) {
      let changed = true;
      while (changed) {
        changed = false;
        const headIds = new Set();
        for (let i = start; i < end; i++) {
          if (combined[i].toolUseId &&
              (combined[i].kind === 'tool_use_start' || combined[i].kind === 'tool_use')) {
            headIds.add(combined[i].toolUseId);
          }
        }
        for (let i = start; i < end; i++) {
          const pid = combined[i].parentToolUseId;
          if (!pid || headIds.has(pid)) continue;
          // Search backward for the owning head event.
          for (let j = start - 1; j >= 0; j--) {
            if (combined[j].toolUseId === pid &&
                (combined[j].kind === 'tool_use_start' || combined[j].kind === 'tool_use')) {
              start = j;
              changed = true;
              headIds.add(pid);
              break;
            }
          }
          if (changed) break; // restart with wider window
        }
      }
    }
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
  return { events, hasMore, nextBefore, trimmedBefore: tb, lastSeq };
}
