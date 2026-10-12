// Canonical text for the plan-approve / plan-reject prompts that get
// sent to a worker when the user (or a conductor) acts on a plan_request.
// Source-of-truth for these strings — the plan card's Approve / Reject in
// web/src/conversation/cards.tsx and the auto-approve fire path in src/instances.ts use the same
// phrasing so the worker can't tell the difference between a UI click,
// an auto-approve, or an MCP-driven approval. Lives under public/ because the
// browser builds these prompts and recognises them (public/promptOrigin.ts);
// DOM-free so the server imports it directly.

const APPROVE_LEAD = 'I approve the plan.';
const APPROVE_NOTES_LEAD = `${APPROVE_LEAD} Additional notes: `;
const APPROVE_NOTES_TAIL = '\n\nPlease proceed with the implementation.';
const REJECT_LEAD = `I'd like to revise the plan.`;
const REJECT_NOTES_LEAD = `${REJECT_LEAD} Refinement notes:\n`;

export function buildApprovePrompt(feedback: unknown): string {
  const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
  return trimmed
    ? `${APPROVE_NOTES_LEAD}${trimmed}${APPROVE_NOTES_TAIL}`
    : `${APPROVE_LEAD} Please proceed with the implementation.`;
}

export function buildRejectPrompt(feedback: unknown): string {
  const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
  return trimmed
    ? `${REJECT_NOTES_LEAD}${trimmed}`
    : `${REJECT_LEAD} Please refine it.`;
}

// Reverse of the two builders: { decision, feedback } for a text one of them
// produced (feedback is null when the decision carried none), else null.
export function parsePlanDecision(text: unknown): { decision: 'approve' | 'reject'; feedback: string | null } | null {
  if (typeof text !== 'string') return null;
  if (text === buildApprovePrompt('')) return { decision: 'approve', feedback: null };
  if (text === buildRejectPrompt('')) return { decision: 'reject', feedback: null };
  if (text.startsWith(APPROVE_NOTES_LEAD) && text.endsWith(APPROVE_NOTES_TAIL)) {
    const feedback = text.slice(APPROVE_NOTES_LEAD.length, text.length - APPROVE_NOTES_TAIL.length);
    return feedback ? { decision: 'approve', feedback } : null;
  }
  if (text.startsWith(REJECT_NOTES_LEAD)) {
    const feedback = text.slice(REJECT_NOTES_LEAD.length);
    return feedback ? { decision: 'reject', feedback } : null;
  }
  return null;
}
