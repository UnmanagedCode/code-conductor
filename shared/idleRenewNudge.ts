// Shared (server + client) marker format for the idle-renewal nudge.
//
// Shortly before an idle top-level conductor's prompt cache expires, cc injects
// one turn asking it whether to `renew_session` while the cache is still warm
// (src/idleRenewNudge.ts sends it). The text is tagged with an in-band marker
// so it classifies as injected (shared/promptOrigin.ts), is named on every
// label surface (shared/promptPreview.ts) and renders as a folded bubble whose
// summary line is always visible (web/src/conversation/model.ts). In-band, like
// shared/wakeCallback.ts, so it survives resume/replay.
//
// DOM-free: the server imports it too.

export const IDLE_NUDGE_MARKER = '[[cc:idle-renew-nudge]]';
// Separates the always-visible summary line from the folded instruction body.
export const IDLE_NUDGE_BODY_SEP = '\n[[cc:idle-nudge-body]]\n';
// The label surfaces' name for a session whose first prompt is a nudge.
export const IDLE_NUDGE_NAME = '⏰ Idle-renewal nudge';
// The prompt-cache lifetime of an idle session: the nudge's deadline, and the
// age past which a nudge would only pay the cache write it exists to avoid.
export const PROMPT_CACHE_TTL_MINUTES = 60;

const IDLE_NUDGE_BODY = [
  'This turn was sent by CodeConductor, not the user. Decide whether renewing your context '
  + 'now is opportune. Renewing reads the cache while it is warm, so the user\'s next message '
  + 'lands on a small fresh context. If it waits, that message pays a full cache write on this one.',
  '- **Renew** if this context carries history the next exchange will not need. Call '
  + '`mcp__code-conductor__renew_session({summary})` following its summary template, then end '
  + 'this turn immediately: the clear happens when this turn ends, and anything after the call '
  + 'is discarded. Before the call, do only what a renewal needs (e.g. flush durable lessons, '
  + 'one line telling the user you are renewing). Start no other work.',
  '- **If you were waiting on the user** — an open AskUserQuestion, a plan awaiting approval, or '
  + 'a question your last turn ended on — copy that question verbatim into the summary\'s '
  + '`## User context`, with the line "First action after the reseed: re-ask this exactly as '
  + 'before" and how you asked it (AskUserQuestion with the same questions and options, '
  + 'ExitPlanMode with the same plan, or the same closing text). Do not re-ask in this turn. '
  + 'After the reseed, re-ask it and end that turn with nothing after it, so the question is '
  + 'the last thing the user sees.',
  '- **Otherwise**, end this turn now with no tool calls and no text.',
].join('\n\n');

// The nudge text for a conductor idle `idleMinutes` minutes.
export function buildIdleRenewNudge(idleMinutes: number): string {
  const summary = `Idle-renewal nudge: you have been idle ${idleMinutes} min; this session's `
    + `prompt cache expires after ${PROMPT_CACHE_TTL_MINUTES} min of idleness.`;
  return `${IDLE_NUDGE_MARKER}${summary}${IDLE_NUDGE_BODY_SEP}${IDLE_NUDGE_BODY}`;
}

// { summary, body } when `text` is a nudge, else null. A text cut before the
// separator (a stored first-prompt head) degrades to summary-only.
export function parseIdleRenewNudge(text: unknown): { summary: string; body: string } | null {
  if (typeof text !== 'string' || !text.startsWith(IDLE_NUDGE_MARKER)) return null;
  const rest = text.slice(IDLE_NUDGE_MARKER.length);
  const idx = rest.indexOf(IDLE_NUDGE_BODY_SEP);
  if (idx === -1) return { summary: rest, body: '' };
  return { summary: rest.slice(0, idx), body: rest.slice(idx + IDLE_NUDGE_BODY_SEP.length) };
}
