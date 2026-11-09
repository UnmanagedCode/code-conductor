// Synthetic pre/post-renewal transcripts shaped like a real managed renewal:
// the pre-renewal file holds a declined renewal request, then the request whose
// turn called renew_session (a ToolSearch round trip first, the closing text
// after), then the `/clear`'s queue pair. The `/clear` line itself is the first
// prompt of the POST-renewal file, followed by the reseed.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() ignores it.

import { RENEW_REQUEST_LEAD } from '../shared/injectedTurns.ts';
import { buildRenewSeed } from '../shared/renewSeed.ts';

// The wire name the CLI records for a renew_session call — written out, not
// derived from src/, so a wrong derivation there fails these fixtures.
export const RENEW_TOOL = 'mcp__code-conductor__renew_session';

export const prompt = (uuid, content) => ({ type: 'user', uuid, message: { role: 'user', content } });
export const reply = (uuid, blocks) => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', content: blocks } });
export const text = (t) => ({ type: 'text', text: t });
export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
export const toolResult = (uuid, id, content) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
export const steer = (uuid, t) => ({ type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: [{ type: 'text', text: t }] } });
export const queuePair = () => [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-03T00:00:00.000Z', content: '/clear' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-03T00:00:00.010Z' },
];

export const declinedRequest = (tag) => `${RENEW_REQUEST_LEAD} (${tag}, declined)`;
export const renewRequest = (tag) => `${RENEW_REQUEST_LEAD} (${tag})`;

// A targeted renew_session call — asking ANOTHER worker to renew — and its result.
export const targetedRenewCall = (tag) => [
  reply(`${tag}-tg`, [toolUse(`${tag}-tg-t`, RENEW_TOOL, { sessionId: 'w0rker01', directive: 'wrap up' })]),
  toolResult(`${tag}-tgr`, `${tag}-tg-t`, '{"ok":true,"requested":true}'),
];

// The arming turn's lines after its opener: ToolSearch round trip, the
// self-form renew_session call and its result, the closing text.
export function armingTurn(tag, { betweenToolSearchAndRenew = [] } = {}) {
  return [
    reply(`${tag}-ts`, [toolUse(`${tag}-t1`, 'ToolSearch', { query: 'renew' })]),
    toolResult(`${tag}-tsr`, `${tag}-t1`, 'found'),
    ...betweenToolSearchAndRenew,
    reply(`${tag}-rn`, [toolUse(`${tag}-t2`, RENEW_TOOL, { summary: 's' })]),
    toolResult(`${tag}-rnr`, `${tag}-t2`, '{"ok":true}'),
    reply(`${tag}-close`, [text('context will clear when this turn ends')]),
  ];
}

// The pre-renewal records. Pure prompts: 0 the brief, 1 the declined request,
// 2 the request that armed the renewal (the cut). `afterDeclined` lines sit
// between the declined request and its reply.
export function preRenewalRecords(tag, { afterDeclined = [], ...opts } = {}) {
  return [
    prompt(`${tag}-u0`, `${tag} brief`),
    reply(`${tag}-a0`, [text(`${tag} brief done`)]),
    prompt(`${tag}-u1`, declinedRequest(tag)),
    ...afterDeclined,
    reply(`${tag}-a1`, [text('not now, mid-task')]),
    prompt(`${tag}-u2`, renewRequest(tag)),
    ...armingTurn(tag, opts),
    ...queuePair(),
  ];
}

export const reseedText = (tag) => buildRenewSeed({ summary: `${tag} handoff summary` });

// A managed renewal's post-renewal records, WITHOUT the `/clear` head
// (segmentChain's RENEW_HEAD, which seedSegmentChain prepends to a renew file).
export function postRenewalRecords(tag) {
  return [
    prompt(`${tag}-seed`, reseedText(tag)),
    reply(`${tag}-seed-a`, [text(`${tag} resumed from the summary`)]),
  ];
}

// A typed `/clear`'s post records: the next prompt is the user's own.
export function postTypedClearRecords(tag) {
  return [
    prompt(`${tag}-p0`, `${tag} after a typed clear`),
    reply(`${tag}-p0-a`, [text(`${tag} fresh reply`)]),
  ];
}

export const jsonl = (records) => records.map(r => JSON.stringify(r) + '\n').join('');
