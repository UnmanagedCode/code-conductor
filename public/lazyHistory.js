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
