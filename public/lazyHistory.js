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

// Render `events` (oldest-first) into a detached container and return it.
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
  // Static content: an event that would finalize a straddling block lives
  // outside this batch (archive gap / turn-snap backstop) and will never be
  // applied here — finalize the visuals so nothing sticks at "streaming…" /
  // "thinking… N tokens".
  batch.finalizeDanglingBlocks();
  // The constructor seeds a "no messages yet" placeholder; never let it
  // ride into the live conversation.
  holder.querySelector('.empty')?.remove();
  return holder;
}

// Move the batch's children into `root` right after `anchorNode` (the
// "earlier messages" sentinel; falls back to the very top), preserving the
// user's viewport by compensating scrollTop with the height delta.
//
// prevScrollTop is captured before any DOM mutation so that the absolute
// assignment on the last line is correct even when the browser's CSS scroll
// anchoring (overflow-anchor:auto) fires during the forced layout triggered
// by reading scrollHeight after the insertBefore loop — which would otherwise
// advance scrollTop by the same delta again, causing double-compensation and
// a scroll jump toward the bottom of the conversation.
export function prependBatch(root, holder, anchorNode = null) {
  const before = (anchorNode && anchorNode.parentNode === root)
    ? anchorNode.nextSibling
    : root.firstChild;
  const prevScrollTop = root.scrollTop;
  const prevHeight = root.scrollHeight;
  while (holder.firstChild) root.insertBefore(holder.firstChild, before);
  root.scrollTop = prevScrollTop + (root.scrollHeight - prevHeight);
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

  function reset() {
    lazy.epoch += 1;
    lazy.hasMore = false;
    lazy.nextBefore = 0;
    lazy.loading = false;
    lazySentinel = null; // the conversation DOM is cleared wholesale alongside
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
    if (lazy.hasMore) ensureSentinel();
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
        // the live content, preserving the viewport.
        const holder = renderEventBatch(page.events, conversationOptions);
        prependBatch(conversationEl, holder, lazySentinel);
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

  // Auto-trigger when the user scrolls near the top (loadEarlier no-ops
  // unless there is actually more history and no fetch is in flight).
  conversationEl.addEventListener('scroll', () => {
    if (conversationEl.scrollTop < 200) loadEarlier();
  });

  return { reset, init };
}
