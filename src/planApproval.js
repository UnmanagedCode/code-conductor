// Canonical text for the plan-approve / plan-reject prompts that get
// sent to a worker when the user (or a conductor) acts on a plan_request.
// Source-of-truth for these strings — the WS handler in public/app.js
// and the auto-approve fire path in src/instances.js use the same
// phrasing so the worker can't tell the difference between a UI click,
// an auto-approve, or an MCP-driven approval.

export function buildApprovePrompt(feedback) {
  const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
  return trimmed
    ? `I approve the plan. Additional notes: ${trimmed}\n\nPlease proceed with the implementation.`
    : 'I approve the plan. Please proceed with the implementation.';
}

export function buildRejectPrompt(feedback) {
  const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
  return trimmed
    ? `I'd like to revise the plan. Refinement notes:\n${trimmed}`
    : `I'd like to revise the plan. Please refine it.`;
}
