// Shared (server + client) marker format for the idle-subscription wake stub.
//
// When a subscribed worker finishes a turn while its conductor is idle, the
// orchestrator folds the worker's recent-message content (the SAME payload a
// default get_recent_messages call returns) directly into the injected wake
// prompt so the conductor doesn't need a follow-up MCP round-trip. The stub is
// tagged with an in-band marker so the conductor's UI can render it as a special
// collapsible bubble — summary always visible, folded payload collapsed. Being
// in-band (like the <transcribed> / soft-interrupt markers) means it survives
// resume/replay: the persisted user turn re-emits the same text.
//
// Imported by src/idleSubscriptions.js (build) and public/conversation.js
// (parse), mirroring public/userQuestionAnswers.js's cross-boundary sharing.

export const WAKE_CALLBACK_MARKER = '[[cc:wake-callback]]';
// Separates the always-visible summary line from the collapsible folded payload.
export const WAKE_BODY_SEP = '\n[[cc:wake-body]]\n';

// Build the folded wake stub sent to (and rendered for) the conductor. The
// summary names the worker + says what happened and that the recent output is
// already inline; the body is the flattened get_recent_messages payload.
export function buildWakeStub({ targetSessionId, payloadText }) {
  const summary =
    `Worker \`${targetSessionId}\` finished its turn. ` +
    `Its recent output is folded in below (equivalent to a default ` +
    `\`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` call), ` +
    `so you do NOT need to call get_recent_messages again — read it and decide the next step.`;
  return `${WAKE_CALLBACK_MARKER}${summary}${WAKE_BODY_SEP}${payloadText}`;
}

// Parse a user-echo text into { summary, body } when it is a wake-callback stub,
// else null. A stub without the body separator degrades to summary-only.
export function parseWakeCallback(text) {
  if (typeof text !== 'string' || !text.startsWith(WAKE_CALLBACK_MARKER)) return null;
  const rest = text.slice(WAKE_CALLBACK_MARKER.length);
  const idx = rest.indexOf(WAKE_BODY_SEP);
  if (idx === -1) return { summary: rest, body: '' };
  return { summary: rest.slice(0, idx), body: rest.slice(idx + WAKE_BODY_SEP.length) };
}
