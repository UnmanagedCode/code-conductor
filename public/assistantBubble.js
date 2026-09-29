// An assistant bubble's copy and raw/rendered semantics. Works on a
// Conversation wrap `{ node, body }` plus the fields added here: `viewControls`
// (the role-row element), `view` ('rendered' | 'raw', applied to every text
// block) and `planText` (the body of the plan card that closed the bubble).
//
// The bubble's text blocks are read from the DOM: the TextBlocks sitting
// directly in `wrap.body`. Thinking, tool and sub-agent blocks live inside
// `.action-group`, and question / plan cards are root-level siblings of the
// wrap, so none of them qualify. Reading the DOM also survives the
// lazy-history merge, which moves nodes between wraps.

import { textBlockOf } from './blocks.js';
import { buildViewControls } from './viewControls.js';

function textBlocksOf(wrap) {
  return [...wrap.body.children].map(textBlockOf).filter(Boolean);
}

// Markdown source of the bubble's text blocks in DOM order, then the closing
// plan card's body (nothing streams into a bubble after its plan closes it).
function copyTextOf(wrap) {
  const parts = textBlocksOf(wrap).map(b => b.buffer).filter(t => t.trim() !== '');
  if (wrap.planText) parts.push(wrap.planText);
  return parts.join('\n\n');
}

// Idempotent: call after a text block joins the bubble, a plan attaches, or
// blocks move in from another wrap. Builds the controls the first time the
// bubble has something to copy, and applies the bubble's view to every text
// block (a no-op for blocks already in it).
export function syncAssistantBubble(wrap) {
  const blocks = textBlocksOf(wrap);
  if (!blocks.length && !wrap.planText) return;
  if (!wrap.viewControls) {
    wrap.viewControls = buildViewControls({
      getCopyText: () => copyTextOf(wrap),
      onViewChange: (v) => {
        wrap.view = v;
        for (const b of textBlocksOf(wrap)) b.setView(v);
      },
    });
    wrap.node.querySelector(':scope > .role').appendChild(wrap.viewControls);
  }
  for (const b of blocks) b.setView(wrap.view ?? 'rendered');
}
