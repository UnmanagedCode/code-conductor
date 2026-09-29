// Who wrote a user turn, judged from the bytes the browser holds. No event,
// frame, jsonl line or store record carries an author, so the answer is the
// in-band shape of the text plus the parser's event flags — the same evidence
// src/awaitingUser.ts's classifyUserTurn reads, whose text/flag rules live here
// (isInjectedUserTurn) so the two cannot disagree.
//
// promptOrigin → 'typed' | 'template' | 'synthetic':
//   typed     — reads as something a person (or a conductor's send_prompt, which
//               is byte-identical) wrote;
//   template  — a server-formatted wrapper around a decision or answer a person
//               (or conductor) made: a plan decision carrying feedback, a
//               question answer, a forward frame's instruction;
//   synthetic — the CLI or the server wrote it, or it has nothing to show.
// isPinEligible turns that into "does the sticky prompt header pin it".
//
// Known limits: a composer prompt and a send_prompt brief are indistinguishable,
// so a brief into a non-worker session reads typed; a human prompt opening with
// a template lead reads as that template, and one whose FIRST TOKEN is a single
// `/word` (SLASH_COMMAND: a bare `/tmp`, or `/tmp is full`) reads as a slash
// command. A multi-segment path such as `/etc/hosts` is typed.
//
// DOM-free: src/awaitingUser.ts imports this module directly.

import { WAKE_CALLBACK_MARKER } from './wakeCallback.js';
import { parseRenewSeed } from './renewSeed.js';
import { FORWARD_FRAME_HEADER, parseForwardFrame } from './forwardFrame.js';
import { parsePlanDecision } from './planApproval.js';
import { isQuestionAnswerShape } from './userQuestionAnswers.js';
import {
  RENEW_REQUEST_LEAD, RESTART_NOTICE_TRUNK, REBASE_PROMPT_LEAD,
  AUTO_RESUME_TEXT, IDLE_PARKED_RESUME_TEXT, QUEUED_ONLY_RESUME_TEXT, QUEUED_SECTION_LEAD,
} from './injectedTurns.js';

const OVERAGE_BASES = [AUTO_RESUME_TEXT, IDLE_PARKED_RESUME_TEXT, QUEUED_ONLY_RESUME_TEXT];

// A slash command is a first token of `/` + a letter + word characters (`\w`,
// `:`, `-`), ended by whitespace or the end of the text. That is also true of a
// bare single-segment path like `/tmp`; the CLI's command-name wrapper is
// matched separately in promptOrigin.
const SLASH_COMMAND = /^\/[a-z][\w:-]*(\s|$)/i;

// True for the server- and CLI-authored turns listed in docs/architecture.md →
// "Ownership and awaitingUser".
export function isInjectedUserTurn(ev) {
  if (ev.cliInjected === true) return true;
  const text = typeof ev.text === 'string' ? ev.text : '';
  if (text.startsWith(WAKE_CALLBACK_MARKER)) return true;
  if (parseRenewSeed(text) !== null) return true;
  if (text.startsWith(RENEW_REQUEST_LEAD)) return true;
  if (text.startsWith(FORWARD_FRAME_HEADER)) return true;
  if (text.startsWith(RESTART_NOTICE_TRUNK)) return true;
  // An overage resume is injected only as a bare preamble; one carrying the
  // user's queued messages is how those messages reach the session.
  if (OVERAGE_BASES.some(b => text.startsWith(b)) && !text.includes(`\n\n${QUEUED_SECTION_LEAD} `)) {
    return true;
  }
  // Renew's `/clear`: the queued_command shape replays as the bare text, the
  // type:"user" shape as the CLI's command-name wrapper.
  if (text === '/clear' || text.startsWith('<command-name>/clear</command-name>')) return true;
  if (text.startsWith('/effort ') || text.startsWith('<command-name>/effort</command-name>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;
  return false;
}

export function promptOrigin(ev) {
  if (ev.parentToolUseId || ev.skillLoad || ev.compactSummary || ev.cliInjected === true) return 'synthetic';
  const text = typeof ev.text === 'string' ? ev.text : '';
  if (!text.trim()) return 'synthetic';
  // Before the injected check: a frame carrying an instruction is a template
  // (the pin shows the instruction alone); a payload-only frame never pins.
  const forward = parseForwardFrame(text);
  if (forward) return forward.instruction.trim() ? 'template' : 'synthetic';
  if (isInjectedUserTurn(ev)) return 'synthetic';
  if (SLASH_COMMAND.test(text) || text.startsWith('<command-name>')) return 'synthetic';
  if (text.startsWith(REBASE_PROMPT_LEAD)) return 'synthetic';
  const plan = parsePlanDecision(text);
  if (plan) return plan.feedback ? 'template' : 'synthetic';
  if (isQuestionAnswerShape(text)) return 'template';
  return 'typed';
}

// Whether the sticky prompt header pins a prompt of this origin. `conducted` is
// the session role: a worker's conductor-authored templates count as its
// prompts; anywhere else they are a person's clicks, not prompts.
export function isPinEligible(origin, { conducted }) {
  if (origin === 'typed') return true;
  if (origin === 'template') return !!conducted;
  return false;
}
