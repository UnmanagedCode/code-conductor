// Narration: a first-person progress note to the user that Claude sends as a
// `thinking` block with text straight after a redacted (empty-text) one. This
// is the ONE classification rule, applied by the live parser (src/parser.ts),
// transcript replay (src/transcript.ts) and get_recent_messages' reconstruction
// (src/mcp/messageReconstruction.ts), so all three agree.
//
// It relies on Claude's current block ordering and takes nothing else: no
// signature, no token estimate, no model or backend. A model whose thinking is
// never redacted therefore never produces narration.

/** The two facts the rule reads off a content block. */
export interface BlockProbe { type: string | null; text: string }

// Narration iff `cur` is thinking WITH text and `prev` — the content block
// immediately before it in the same assistant message — is thinking with empty
// text. A first block (no `prev`) is never narration.
export function isNarration(prev: BlockProbe | null | undefined, cur: BlockProbe): boolean {
  return cur.type === 'thinking' && cur.text !== ''
    && prev?.type === 'thinking' && prev.text === '';
}
