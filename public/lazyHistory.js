// Lazy-loaded older history: render a page of archived/evicted events
// fetched from GET /api/instances/:id/events and splice it above the live
// conversation. There is deliberately NO parallel renderer — each batch
// runs through a fresh `Conversation` instance (the exact block-rendering
// path the live view uses) mounted on a detached container, so its
// stateful maps (blocksByKey / toolBlocks / messageWraps / streaming
// merge) are isolated from the live view's. Archive content is static, so
// the batch instance is discarded after its nodes are transplanted; button
// click handlers keep working because they close over app.js callbacks.

import { Conversation } from './conversation.js';

// Render `events` (oldest-first) into a detached container. Returns
// { holder, leadingWrap, trailingOpenWrap, toolBlocks }:
//   holder          — the detached node whose children get spliced in
//   leadingWrap     — the batch's leading assistant wrap (chunk begins
//                     mid-turn) — the merge TARGET for the next-older page
//   trailingOpenWrap— the still-open assistant wrap at the batch's end
//                     (chunk ends mid-turn) — the merge SOURCE into the
//                     chunk below
//   toolBlocks      — toolUseId -> ToolUseBlock, for adopting parked live
//                     sub-agent events whose parent head is in this batch
// `options` should be the same callbacks the main conversation was built
// with; `onAssistantText` is force-nulled — replaying old history must
// never trigger TTS auto-speak.
export function renderEventBatch(events, options = {}) {
  const holder = document.createElement('div');
  const batch = new Conversation(holder, { ...options, onAssistantText: null });
  // Same answer-locking semantics as a snapshot replay (a user_echo right
  // after an AskUserQuestion tool_result marks the card answered).
  batch._replayMode = true;
  batch.applyEvents(events);
  batch._replayMode = false;
  // Static content: finalize blocks that are genuinely dangling INSIDE the
  // batch (an interrupted turn's result-less tool, the trim's plain-cut
  // last resort). Quiescent-aligned pages never cut a block at the seam.
  batch.finalizeDanglingBlocks();
  // The constructor seeds a "no messages yet" placeholder; never let it
  // ride into the live conversation.
  holder.querySelector('.empty')?.remove();
  return {
    holder,
    leadingWrap: batch.leadingAssistantWrap,
    trailingOpenWrap: batch._activeAssistantWrap,
    toolBlocks: batch.toolBlocks,
  };
}

// Move the batch's children into `root` right after `anchorNode` (the
// "earlier messages" sentinel; falls back to the very top), preserving the
// user's viewport by compensating scrollTop with the height delta.
// `afterInsert` (optional) runs between the splice and the height read —
// DOM surgery that must be reflected in the compensation (the bubble merge,
// sub-agent adoption) belongs there.
//
// prevScrollTop is captured before any DOM mutation so that the absolute
// assignment on the last line is correct even when the browser's CSS scroll
// anchoring (overflow-anchor:auto) fires during the forced layout triggered
// by reading scrollHeight after the insertBefore loop — which would otherwise
// advance scrollTop by the same delta again, causing double-compensation and
// a scroll jump toward the bottom of the conversation.
export function prependBatch(root, holder, anchorNode = null, afterInsert = null) {
  const before = (anchorNode && anchorNode.parentNode === root)
    ? anchorNode.nextSibling
    : root.firstChild;
  const prevScrollTop = root.scrollTop;
  const prevHeight = root.scrollHeight;
  while (holder.firstChild) root.insertBefore(holder.firstChild, before);
  if (afterInsert) afterInsert();
  root.scrollTop = prevScrollTop + (root.scrollHeight - prevHeight);
}

// Splice a rendered batch above the existing content: viewport-preserving
// prepend, seam-bubble merge, and sub-agent adoption — one operation so the
// scroll compensation in prependBatch sees the final layout. Returns the new
// oldest chunk's leading wrap (the next page's merge target).
//
//   batch             — renderEventBatch() result
//   conversation      — the live Conversation (parked orphan child events);
//                       optional for callers with no live view
//   oldestLeadingWrap — the current oldest chunk's leading assistant wrap
//                       (null when it starts on a turn boundary / gap)
export function spliceBatchAbove({ root, batch, anchorNode = null, conversation = null, oldestLeadingWrap = null }) {
  let merged = false;
  prependBatch(root, batch.holder, anchorNode, () => {
    // Bubble merge: the batch ends with an OPEN assistant segment and the
    // chunk below begins with one — pages are contiguous, so both halves
    // belong to one turn. Move the batch's trailing blocks to the FRONT of
    // the below chunk's leading bubble (its node/body identity is what the
    // live Conversation's maps point at) and drop the emptied batch bubble.
    // Quiescent seams make this a pure concatenation of whole, finalized
    // blocks — a moved Task block carries its nested sub-conversation along.
    if (batch.trailingOpenWrap && oldestLeadingWrap
        && batch.trailingOpenWrap !== oldestLeadingWrap) {
      const dst = oldestLeadingWrap.body;
      const src = batch.trailingOpenWrap.body;
      const ref = dst.firstChild;
      while (src.firstChild) dst.insertBefore(src.firstChild, ref);
      batch.trailingOpenWrap.node.remove();
      merged = true;
    }
    // Sub-agent adoption: live child events whose parent Task head was below
    // the tail sit parked in the live conversation; if this batch carries
    // the head's block, register it and replay them into its nested panel
    // (arrival order preserved — multi-part nested blocks reconstruct whole).
    if (conversation?.orphanChildEvents?.size) {
      for (const pid of [...conversation.orphanChildEvents.keys()]) {
        const block = batch.toolBlocks.get(pid);
        if (block) conversation.adoptToolBlock(pid, block);
      }
    }
  });
  // When the whole batch was ONE open segment that just merged away, the top
  // bubble is still the previous target — keep it.
  return (merged && batch.leadingWrap === batch.trailingOpenWrap)
    ? oldestLeadingWrap
    : (batch.leadingWrap ?? null);
}

// --- Lazy-load of older history (scroll-to-top) controller ----------------
// The WS snapshot carries only the ring TAIL (tailStartSeq > 0 ⇒ older
// events exist); the user pages backward through
// GET /api/instances/:id/events?before=<cursor> as they scroll up. `epoch`
// guards against a fetch resolving after the view was cleared or switched
// (its nodes would otherwise land in the wrong conversation) — bumped on
// every snapshot / reset_snapshot / instance switch.
//
// Injected deps:
//   conversationEl      — dom.conversation: scroll container + sentinel mount + prepend root
//   conversation        — live Conversation instance (for setUserActionsEnabled after a prepend)
//   conversationOptions — same callbacks the live view was built with
//   getActiveId         — () => state.activeId
//   getInstances        — () => state.instances
// Returns { reset, init } — the snapshot / reset_snapshot / selectInstance call sites.
export function installLazyHistoryController({
  conversationEl,
  conversation,
  conversationOptions,
  getActiveId,
  getInstances,
}) {
  const lazy = { epoch: 0, hasMore: false, nextBefore: 0, loading: false };
  let lazySentinel = null;
  // The current OLDEST chunk's leading assistant wrap (it begins mid-turn) —
  // the merge target for the next prepended page's trailing open bubble.
  // Starts as the live tail's, then advances page by page.
  let oldestLeadingWrap = null;

  function reset() {
    lazy.epoch += 1;
    lazy.hasMore = false;
    lazy.nextBefore = 0;
    lazy.loading = false;
    lazySentinel = null; // the conversation DOM is cleared wholesale alongside
    oldestLeadingWrap = null;
  }

  // Called from the snapshot handler for the active instance, after the tail
  // has been rendered.
  function init(frame) {
    lazy.epoch += 1;
    lazy.loading = false;
    lazy.nextBefore = frame.tailStartSeq
      ?? (frame.events?.length ? frame.events[0]._seq : 0);
    lazy.hasMore = lazy.nextBefore > 0;
    lazySentinel = null;
    // The tail is quiescent-aligned but can still begin mid-turn — its
    // leading bubble is then the first merge target.
    oldestLeadingWrap = conversation.leadingAssistantWrap ?? null;
    if (lazy.hasMore) ensureSentinel();
    autoFillViewport(); // fire-and-forget; self-guards on hasMore/layout
  }

  // "⋯ earlier messages" / "loading earlier…" affordance pinned above the
  // oldest rendered content. Tappable as a manual fallback to the scroll
  // trigger; removed once history is exhausted.
  function ensureSentinel() {
    if (!lazySentinel) {
      lazySentinel = document.createElement('div');
      lazySentinel.className = 'history-sentinel';
      lazySentinel.addEventListener('click', () => loadEarlier());
    }
    if (lazySentinel.parentNode !== conversationEl) {
      conversationEl.insertBefore(lazySentinel, conversationEl.firstChild);
    }
    lazySentinel.textContent = lazy.loading ? 'loading earlier…' : '⋯ earlier messages';
  }

  async function loadEarlier() {
    if (!lazy.hasMore || lazy.loading || !getActiveId()) return;
    const id = getActiveId();
    const epoch = lazy.epoch;
    lazy.loading = true;
    ensureSentinel();
    try {
      const r = await fetch(
        `/api/instances/${encodeURIComponent(id)}/events?before=${lazy.nextBefore}&limit=200`);
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const page = await r.json();
      if (epoch !== lazy.epoch || id !== getActiveId()) return; // stale — view changed mid-fetch
      if (page.events.length) {
        // Render through the standard Conversation pipeline on a detached
        // node (isolated streaming/tool-pairing state), then splice above
        // the live content — merging the seam bubbles and adopting parked
        // sub-agent events — preserving the viewport.
        const batch = renderEventBatch(page.events, conversationOptions);
        oldestLeadingWrap = spliceBatchAbove({
          root: conversationEl, batch, anchorNode: lazySentinel,
          conversation, oldestLeadingWrap,
        });
        // Freshly-created rewind/fork buttons default to enabled; re-sync
        // them with the instance's current status.
        const inst = getInstances().find(i => i.id === id);
        conversation.setUserActionsEnabled(inst?.status === 'idle');
      }
      lazy.nextBefore = page.nextBefore;
      lazy.hasMore = !!page.hasMore && page.events.length > 0; // empty page always terminates
    } catch (e) {
      console.warn('load earlier failed:', e);
      // keep hasMore — the sentinel stays tappable for a retry
    } finally {
      if (epoch === lazy.epoch) {
        lazy.loading = false;
        if (lazy.hasMore) ensureSentinel();
        else if (lazySentinel) { lazySentinel.remove(); lazySentinel = null; }
      }
    }
  }

  // After the tail (or a page) renders, the content can be shorter than the
  // scroll viewport — then the "earlier messages" sentinel is all the user
  // sees instead of actual history. Page earlier chunks in until the
  // container is scrollable or history is exhausted. Guards: skip while the
  // container has no layout (clientHeight 0, e.g. background tab) to avoid
  // pulling the whole history; stop if a load makes no forward progress (a
  // fetch error keeps hasMore true) so we never hot-loop the endpoint; and
  // bail if the view switched mid-loop (epoch bump).
  async function autoFillViewport() {
    const epoch = lazy.epoch;
    while (epoch === lazy.epoch && lazy.hasMore && !lazy.loading
           && conversationEl.clientHeight > 0
           && conversationEl.scrollHeight <= conversationEl.clientHeight) {
      const before = lazy.nextBefore;
      await loadEarlier();
      if (epoch !== lazy.epoch || lazy.nextBefore === before) break;
    }
  }

  // Auto-trigger when the user scrolls near the top (loadEarlier no-ops
  // unless there is actually more history and no fetch is in flight).
  conversationEl.addEventListener('scroll', () => {
    if (conversationEl.scrollTop < 200) loadEarlier();
  });

  return { reset, init };
}
