// Hand-written declaration for public/planApproval.js — the src→public imports
// (src/instances.ts, src/mcp/handlers.ts) need a typed surface while public/
// stays .js this round. The shapes below are the module's actual runtime
// contract; keep them in sync with the implementation.

export function buildApprovePrompt(feedback: unknown): string;
export function buildRejectPrompt(feedback: unknown): string;

// { decision, feedback } for a text one of the builders produced (feedback is
// null when the decision carried none), else null.
export function parsePlanDecision(text: unknown): { decision: 'approve' | 'reject'; feedback: string | null } | null;
