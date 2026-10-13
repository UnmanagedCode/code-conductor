// Scroll-up paging of older history: everything below the live tail — the
// ring below the snapshot, then the session's earlier backing segments
// (GET /api/instances/:id/lineage-events). Each page renders through its own
// ConversationModel (the exact live path) and is spliced above with
// prependPage. The scroll container registers a viewport so a splice keeps the
// reader's position and short histories fill the screen.
import { apiFetch } from '@shared/http';
import type { AssistantNode, ConversationModel } from './model';
import { createStore } from '@/state/createStore';
import type { UiEvent } from '@shared/uiEvent';

const MAX_EMPTY_PAGES = 3;

/** A /lineage-events page (LineagePage, src/lineagePager.ts). */
type LineagePage = {
  events: UiEvent[];
  hasMore: boolean;
  segment: string | null;
  nextBefore: number | null;
  pageSegment: string | null;
  currentSegmentId: string | null;
};

export type Viewport = {
  clientHeight: () => number;
  scrollHeight: () => number;
  /** Run a prepend, keeping the visible content where it is. */
  preserve: (fn: () => void) => void;
};

export function createLazyHistory({ model, getActiveId }: { model: ConversationModel; getActiveId: () => string | null }) {
  const st = {
    epoch: 0, hasMore: false, nextBefore: 0 as number | null, segment: null as string | null,
    visited: new Set<string | null>([null]), loading: false, emptyStreak: 0, silent: false,
    initFor: null as string | null, inflight: null as Promise<void> | null,
  };
  let oldestLeadingWrap: AssistantNode | null = null;
  let viewport: Viewport | null = null;
  /** What the sentinel above the transcript shows. */
  const status = createStore({ visible: false, loading: false });

  const publish = () => status.set({ visible: st.hasMore && !st.silent, loading: st.loading });
  const isReady = () => st.initFor !== null && st.initFor === getActiveId();

  function reset() {
    st.epoch += 1;
    if (st.initFor !== getActiveId()) st.initFor = null;
    Object.assign(st, { hasMore: false, nextBefore: 0, segment: null, loading: false, inflight: null, emptyStreak: 0, silent: false });
    st.visited = new Set([null]);
    oldestLeadingWrap = null;
    publish();
  }

  function init(frame: { tailStartSeq?: number; events?: { _seq?: number }[] }) {
    st.epoch += 1;
    st.initFor = getActiveId();
    st.loading = false;
    st.inflight = null;
    st.nextBefore = frame.tailStartSeq ?? (frame.events?.length ? frame.events[0]._seq ?? 0 : 0);
    st.segment = null;
    st.visited = new Set([null]);
    st.emptyStreak = 0;
    st.silent = false;
    oldestLeadingWrap = model.leadingAssistantWrap ?? null;
    st.hasMore = true;
    if ((st.nextBefore ?? 0) > 0) {
      publish();
      void autoFill();
      return;
    }
    // The tail starts at the ring's head: probe the earlier segments quietly.
    st.silent = true;
    publish();
    void loadEarlier().then(() => autoFill());
  }

  function loadEarlier(): Promise<void> {
    if (st.loading) return st.inflight ?? Promise.resolve();
    if (!st.hasMore || !getActiveId()) return Promise.resolve();
    st.inflight = fetchEarlier();
    return st.inflight;
  }

  async function fetchEarlier() {
    const id = getActiveId()!;
    const epoch = st.epoch;
    const prevBefore = st.nextBefore;
    const prevSegment = st.segment;
    st.loading = true;
    publish();
    try {
      let q = 'limit=200';
      if (st.nextBefore != null) q += `&before=${st.nextBefore}`;
      if (st.segment != null) q += `&segment=${encodeURIComponent(st.segment)}`;
      const page = await apiFetch<LineagePage>(`/api/instances/${encodeURIComponent(id)}/lineage-events?${q}`);
      if (epoch !== st.epoch || id !== getActiveId()) return;
      st.silent = false;
      if (page.events.length) {
        const batch = model.renderPage(page.events, page.pageSegment ?? null, page.currentSegmentId ?? null);
        const splice = () => { oldestLeadingWrap = model.prependPage(batch, oldestLeadingWrap); };
        if (viewport) viewport.preserve(splice);
        else splice();
      }
      const segment: string | null = page.segment ?? null;
      const progressed = segment === prevSegment
        ? page.nextBefore != null && (prevBefore == null || page.nextBefore < prevBefore)
        : !st.visited.has(segment);
      st.visited.add(segment);
      st.segment = segment;
      st.nextBefore = page.nextBefore ?? null;
      st.emptyStreak = page.events.length ? 0 : st.emptyStreak + 1;
      st.hasMore = !!page.hasMore && progressed && st.emptyStreak < MAX_EMPTY_PAGES;
    } catch (e) {
      console.warn('load earlier failed:', e);
      st.silent = false;
    } finally {
      if (epoch === st.epoch) {
        st.loading = false;
        st.inflight = null;
        publish();
      }
    }
  }

  async function autoFill() {
    const epoch = st.epoch;
    while (epoch === st.epoch && st.hasMore && !st.loading && viewport
      && viewport.clientHeight() > 0 && viewport.scrollHeight() <= viewport.clientHeight()) {
      const before = st.nextBefore;
      const segment = st.segment;
      await loadEarlier();
      // Let React commit the splice before measuring again.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (epoch !== st.epoch || (st.nextBefore === before && st.segment === segment)) break;
    }
  }

  /** Page backwards until `found()` — the sticky prompt's jump to an off-page bubble. */
  async function loadUntil(found: () => boolean, keepGoing: () => boolean) {
    if (!isReady()) return 'not-ready';
    const epoch = st.epoch;
    for (;;) {
      if (!keepGoing()) return 'cancelled';
      if (found()) return 'found';
      if (!st.hasMore) return 'exhausted';
      const joined = st.loading;
      const before = st.nextBefore;
      const segment = st.segment;
      await loadEarlier();
      if (epoch !== st.epoch) return 'cancelled';
      if (!joined && st.hasMore && st.nextBefore === before && st.segment === segment) return found() ? 'found' : 'stalled';
    }
  }

  return {
    isReady,
    state: () => ({ ready: isReady(), hasMore: st.hasMore, loading: st.loading }),
    reset,
    init,
    loadEarlier,
    loadUntil,
    status,
    setViewport(v: Viewport | null) {
      viewport = v;
      if (v) void autoFill();
    },
  };
}
