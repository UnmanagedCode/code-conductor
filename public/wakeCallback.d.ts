// Hand-written declaration for public/wakeCallback.js — the src→public import
// (src/idleSubscriptions.ts) needs a typed surface while public/ stays .js this
// round. The shapes below are the module's actual runtime contract; keep them in
// sync with the implementation.

export const WAKE_CALLBACK_MARKER: string;
// Separates the always-visible summary line from the collapsible folded payload.
export const WAKE_BODY_SEP: string;

export function buildWakeStub(input: { targetSessionId: string; payloadText: string }): string;

export function markPlainStub(summary: string): string;

// Parse a user-echo text into { summary, body } when it is a wake-callback stub,
// else null. A stub without the body separator degrades to summary-only.
export function parseWakeCallback(text: unknown): { summary: string; body: string } | null;
