// Lineage scroll-back for the web UI: page a session backward past the start of
// its current backing segment into every earlier segment of its lineage row.
//
// This module owns the CROSS-SEGMENT WALK and nothing else. Every page is served
// by one single-segment pager that MCP reads through too (src/eventArchive.ts):
// the live ring by pageInstanceEvents, the segment owning the ring head (when it
// is no longer current) by pageInstanceEvents over a past view of the instance
// (segmentRingView), and each older segment by the disk pager's two halves. No
// cut, anchor, correlation, snap or stitch logic lives here — a change to how
// one segment pages belongs in eventArchive.ts, where MCP sees it too.
//
// Cursor spaces (the `segment` a page names for the next request):
//   null        — the live space: ring seqs, plus the current segment's archive
//                 seqs, exactly as GET /events uses them.
//   H           — the view of the ring-head segment when it is not current: its
//                 archive indices, all below the ring's trimmedBefore.
//   <disk id>   — that segment's file, its own dense archive indices.
// Within a space the cursor strictly decreases (each page's own nextBefore);
// across spaces the walk only ever moves to a strictly older chain position, so
// a client accepts a page iff its segment is unchanged with a lower cursor, or
// is one it has not visited.
//
// Markers are seq-less: `{kind:'segment_seam', segmentId}` (a renew boundary,
// labelled with the segment BELOW it in the rendering, i.e. the newer one) and
// `{kind:'history_gap'}` (content that is gone). The walk places them at the
// start of the newer source's terminal page, so each is served once per walk.

import {
  pageInstanceEvents, loadStampedTranscript, pageStampedTranscript, segmentOfSeq, insertRingSeamDividers,
  type PagerSource, type Page,
} from './eventArchive.ts';
import { isOuterUserEcho, type UiEvent } from './parser.ts';
import type { InstanceLike, RingSeam } from './instanceTypes.ts';
import type { TranscriptPlacement } from './projects.ts';
import { chainFor, type LineageSegment } from './sessionLineage.ts';
import { httpError } from './httpError.ts';

export const NOT_AN_OLDER_SEGMENT = 'segment is not an older segment of this session';

export interface LineagePage {
  events: UiEvent[];
  hasMore: boolean;
  // The cursor for the next request: its space and its backward cursor there
  // (null = that space's newest page).
  segment: string | null;
  nextBefore: number | null;
  // The segment the page's first seq'd event came from.
  pageSegment: string | null;
  currentSegmentId: string | null;
}

export interface LineageStep {
  id: string;
  dropped: boolean;
  // Markers rendered directly below this step's content, top → bottom.
  markersBelow: Array<'seam' | 'gap'>;
}

// Which older segments a walk from `fromId` serves, newest first, over the FULL
// chain `c` (tombstones included, src/sessionLineage.ts chainFor):
//   - an entry whose successor is a `prune` is that prune's original — it is
//     skipped and never read (the prune's copy already holds its content). The
//     skip keys on the immediate predecessor in the full chain, tombstones
//     included, so a tombstoned original still hides its predecessor's content
//     from being mistaken for it.
//   - every other boundary is a renew: one divider, plus one gap when the
//     skipped run directly above it contained a tombstone.
//   - `top` is one gap above everything when the walk ends on a skipped run with
//     a tombstone in it, or when the chain does not open on its `initial` entry
//     (an entry missing outright rather than tombstoned).
// A `fromId` absent from the chain walks nothing.
export function lineageSteps(chain: LineageSegment[], fromId: string): { steps: LineageStep[]; top: Array<'gap'> } {
  const h = chain.findIndex(s => s.id === fromId);
  if (h === -1) return { steps: [], top: [] };
  const steps: LineageStep[] = [];
  let run = false; // does the current skipped run contain a tombstone?
  for (let i = h - 1; i >= 0; i--) {
    if (chain[i + 1].reason === 'prune') { run ||= !!chain[i].dropped; continue; }
    steps.push({ id: chain[i].id, dropped: !!chain[i].dropped, markersBelow: ['seam', ...(run ? ['gap' as const] : [])] });
    run = false;
  }
  const top: Array<'gap'> = (run || chain[0].reason !== 'initial') ? ['gap'] : [];
  return { steps, top };
}

// Everything one request reads off the instance, captured in one synchronous tick.
export interface RingCapture {
  ring: Array<UiEvent & { _seq: number }>;
  tb: number;
  seams: readonly RingSeam[];
  echoCount: number;
  place: TranscriptPlacement;
}

// The instance as it stood just before rotation k+1, minus what the ring has
// since evicted: its ring restricted to segment k's seq range, the seams up to
// k, segment k as its backing session. pageInstanceEvents over it pages segment
// k's file cut at the ring head exactly as it did while k was current.
//
// ONE value is not recoverable from the seams, which carry no echo ordinal on
// purpose: `_userEchoCount` must be the echo counter AT seam k+1. It is the
// `userIndex` of the first outer user_echo with `_seq >= seams[k+1].startSeq`
// in the captured ring, or the live counter when there is none. Exact because
// Instance._emitUi is the only stamper (`userIndex = _userEchoCount++` on every
// outer echo it pushes), EventLog.push declines no echo kind, and the ring holds
// every seq >= tb with seams[k+1].startSeq > tb — so the first retained echo at
// or after the seam carries exactly the count at the seam, and when none was
// emitted after it the live counter has not moved past it. The archive cut
// reads the count only in its no-echo branches, which are uncalibratable for a
// segment starting above seq 0 (cut 0), so it is load-bearing only for k = 0.
export function segmentRingView(snap: RingCapture, k: number): PagerSource {
  const start = snap.seams[k].startSeq;
  const end = snap.seams[k + 1].startSeq;
  const ring = snap.ring.filter(e => e._seq >= start && e._seq < end);
  const atSeam = snap.ring.find(e => e._seq >= end && isOuterUserEcho(e));
  const echoCount = typeof atSeam?.userIndex === 'number' ? atSeam.userIndex : snap.echoCount;
  return {
    ringSnapshot: () => ring.slice(),
    ring: { trimmedBefore: snap.tb, nextSeq: end, seams: snap.seams.slice(0, k + 1) },
    backingSessionId: snap.seams[k].segmentId,
    transcriptPlace: snap.place,
    _userEchoCount: echoCount,
  };
}

type Source = { kind: 'live' } | { kind: 'view' } | { kind: 'disk'; j: number };

const GAP: UiEvent = { kind: 'history_gap' };

// One page of `inst`'s lineage history. Throws 400 for a `segment` the walk
// would never hand out (see NOT_AN_OLDER_SEGMENT).
export async function pageLineageEvents(inst: InstanceLike, q: {
  segment?: string | null; before?: number | null; limit?: number;
}): Promise<LineagePage> {
  // Awaited first: it goes through loadLineage's read barrier behind any kicked
  // rotation write. Everything after it is captured in one tick with the first
  // pager call's own ring read.
  const chain = await chainFor(inst.sessionId ?? '');
  const snap: RingCapture = {
    ring: inst.ringSnapshot(), tb: inst.ring.trimmedBefore, seams: [...inst.ring.seams],
    echoCount: inst._userEchoCount, place: inst.transcriptPlace,
  };
  const current = snap.seams.at(-1)?.segmentId ?? inst.backingSessionId ?? null;
  // The segment owning the ring head. An empty ring has tb === nextSeq, which
  // the last seam owns, so H is then current.
  const H = snap.seams.length ? segmentOfSeq(snap.seams, snap.tb) : inst.backingSessionId;
  const viewable = H != null && H !== current && snap.tb > 0;
  const { steps, top } = lineageSteps(chain, H ?? '');

  let source: Source;
  if (q.segment == null) source = { kind: 'live' };
  else if (viewable && q.segment === H) source = { kind: 'view' };
  else {
    const j = steps.findIndex(s => s.id === q.segment);
    if (j === -1) throw httpError(400, NOT_AN_OLDER_SEGMENT);
    source = { kind: 'disk', j };
  }
  const spaceOf = (s: Source): string | null => (s.kind === 'live' ? null : s.kind === 'view' ? H : steps[s.j].id);
  const markers = (step: LineageStep, label: string | null): UiEvent[] =>
    step.markersBelow.map(m => (m === 'seam' ? { kind: 'segment_seam', segmentId: label } : { ...GAP }));
  // What follows a source's terminal page: the next source and its cursor, and
  // the markers that go at the top of that terminal page.
  const continuation = (s: Source): { next: Source | null; before: number | null; prefix: UiEvent[] } => {
    if (s.kind === 'live' && viewable) return { next: { kind: 'view' }, before: snap.tb, prefix: [] };
    const j = s.kind === 'disk' ? s.j + 1 : 0;
    const label = s.kind === 'disk' ? steps[s.j].id : H;
    if (j < steps.length) return { next: { kind: 'disk', j }, before: null, prefix: markers(steps[j], label) };
    return { next: null, before: null, prefix: top.map(() => ({ ...GAP })) };
  };

  let before = q.before ?? null;
  // Bounded: each pass moves to a strictly older source.
  for (let pass = 0; pass <= steps.length + 2; pass++) {
    const { page, pageSegment } = await serve(source, before);
    if (page.hasMore) {
      return { events: page.events, hasMore: true, segment: spaceOf(source), nextBefore: page.nextBefore, pageSegment, currentSegmentId: current };
    }
    const cont = continuation(source);
    const events = cont.prefix.concat(page.events);
    if (!cont.next) {
      return { events, hasMore: false, segment: spaceOf(source), nextBefore: page.nextBefore, pageSegment, currentSegmentId: current };
    }
    if (events.length) {
      return { events, hasMore: true, segment: spaceOf(cont.next), nextBefore: cont.before, pageSegment, currentSegmentId: current };
    }
    // Nothing to show from this source: serve the next one in this request.
    source = cont.next;
    before = source.kind === 'view' ? Math.min(before ?? snap.tb, snap.tb) : cont.before;
  }
  throw new Error('pageLineageEvents: the walk did not terminate');

  async function serve(s: Source, cursor: number | null): Promise<{ page: Page; pageSegment: string | null }> {
    const limit = q.limit;
    // The lineage layer re-derives the core's floor semantics: the floor marker
    // stands for earlier-segment content, which this layer either serves (the
    // view, an older step) or marks itself (a `top` gap).
    if (s.kind === 'live') {
      const page = await pageInstanceEvents(inst, { before: cursor, limit, markFloor: !(viewable || steps.length || top.length) });
      const first = page.events.find(e => typeof e._seq === 'number');
      const pageSegment = first == null ? null
        : (first._seq as number) < page.trimmedBefore ? current : segmentOfSeq(snap.seams, first._seq as number);
      return { page: { ...page, events: insertRingSeamDividers(page.events, snap.seams, page.trimmedBefore) }, pageSegment };
    }
    if (s.kind === 'view') {
      const k = snap.seams.findLastIndex(m => m.startSeq <= snap.tb);
      const page = await pageInstanceEvents(segmentRingView(snap, k), {
        before: Math.min(cursor ?? snap.tb, snap.tb), limit, markFloor: !(steps.length || top.length),
      });
      return { page, pageSegment: H };
    }
    const step = steps[s.j];
    const flat = step.dropped ? null : await loadStampedTranscript({ place: snap.place, sessionId: step.id });
    const page: Page = flat
      ? pageStampedTranscript(flat, { before: cursor, limit })
      : { events: [{ ...GAP }], hasMore: false, nextBefore: 0, trimmedBefore: 0, lastSeq: -1 };
    return { page, pageSegment: step.id };
  }
}
