// `awaitingUser`: is this session waiting on the user? The pure core — no IO,
// no import of src/instances.ts. Two feeds reduce into the same state through
// this module: the live event stream (LiveAskFacts, driven by Instance._emitUi)
// and the persisted transcript (src/awaitingUserTranscript.ts, which scans it
// backward). Both classify user turns with ONE function, classifyUserTurn, so a
// session's value is the same before and after a restart.
//
// The state is STICKY: the most recent ask with no REAL user message after it.
//   - a tool ask (AskUserQuestion / ExitPlanMode) always overwrites;
//   - a text ask (a turn ending in a question or an offer) sets it only when
//     nothing is pending — it never downgrades a tool ask;
//   - a real user message clears it; an injected one (a wake callback, a restart
//     notice, a renew reseed, a CLI-injected line…) leaves it alone.
//
// Known limit: an MCP send into a non-worker (send_prompt, answer_question,
// approve_plan, reject_plan) is byte-identical to the user's own and so reads as
// real. Workers never carry the flag (Instance feeds nothing when conducted).

import { WAKE_CALLBACK_MARKER } from '../public/wakeCallback.js';
import { parseRenewSeed } from '../public/renewSeed.js';
import {
  RENEW_REQUEST_LEAD, RESTART_NOTICE_TRUNK, FORWARD_FRAME_HEADER,
  AUTO_RESUME_TEXT, IDLE_PARKED_RESUME_TEXT, QUEUED_ONLY_RESUME_TEXT, QUEUED_SECTION_LEAD,
} from './injectedTurns.ts';
import type { UiEvent } from './parser.ts';

export type AskKind = 'question' | 'plan';
export type AskSource = 'tool' | 'text';
export type AskState = { kind: AskKind; source: AskSource } | null;

export type AskFact =
  | { t: 'toolAsk'; kind: AskKind; toolUseId?: string | null }
  | { t: 'endTurn'; text: string }
  | { t: 'userTurn'; ev: UiEvent };

// ── Text-ask detector ─────────────────────────────────────────────────────

// Trailing whitespace and markdown closers, so `**Proceed?**` and `(ok?)` read
// as ending in `?`.
const TRAILING_CLOSERS = /[\s*_`)"']+$/;
const OFFER_PHRASE = /\b(should i|shall i|want me to|would you like|do you want|let me know)\b/i;

export function isTextAsk(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.replace(TRAILING_CLOSERS, '');
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const paragraphs = t.split(/\n[ \t]*\n/);
  return OFFER_PHRASE.test(paragraphs[paragraphs.length - 1]);
}

// ── User-turn classifier ──────────────────────────────────────────────────

const OVERAGE_BASES = [AUTO_RESUME_TEXT, IDLE_PARKED_RESUME_TEXT, QUEUED_ONLY_RESUME_TEXT];

// 'real' for anything a person (or, per the limit above, an MCP driver) sent;
// 'injected' for the server- and CLI-authored turns listed in
// docs/architecture.md → "Ownership and awaitingUser".
export function classifyUserTurn(ev: UiEvent): 'real' | 'injected' {
  if (ev.cliInjected === true) return 'injected';
  const text = typeof ev.text === 'string' ? ev.text : '';
  if (text.startsWith(WAKE_CALLBACK_MARKER)) return 'injected';
  if (parseRenewSeed(text) !== null) return 'injected';
  if (text.startsWith(RENEW_REQUEST_LEAD)) return 'injected';
  if (text.startsWith(FORWARD_FRAME_HEADER)) return 'injected';
  if (text.startsWith(RESTART_NOTICE_TRUNK)) return 'injected';
  // An overage resume is injected only as a bare preamble; one carrying the
  // user's queued messages is how those messages reach the session.
  if (OVERAGE_BASES.some(b => text.startsWith(b)) && !text.includes(`\n\n${QUEUED_SECTION_LEAD} `)) {
    return 'injected';
  }
  // Renew's `/clear`: the queued_command shape replays as the bare text, the
  // type:"user" shape as the CLI's command-name wrapper.
  if (text === '/clear' || text.startsWith('<command-name>/clear</command-name>')) return 'injected';
  if (text.startsWith('/effort ') || text.startsWith('<command-name>/effort</command-name>')) return 'injected';
  if (text.startsWith('<local-command-stdout>')) return 'injected';
  return 'real';
}

// ── Reducer ───────────────────────────────────────────────────────────────

export function reduceAsk(state: AskState, fact: AskFact): AskState {
  switch (fact.t) {
    case 'toolAsk': return { kind: fact.kind, source: 'tool' };
    case 'endTurn': return state ?? (isTextAsk(fact.text) ? { kind: 'question', source: 'text' } : null);
    case 'userTurn': return classifyUserTurn(fact.ev) === 'real' ? null : state;
  }
}

// ── Summary algebra ───────────────────────────────────────────────────────
//
// Any range of facts folds to one of two shapes:
//   const(v)   — the range holds a tool ask or a real user turn, so its result
//                is v whatever came before;
//   inherit(c) — it holds neither, so its result is `incoming ?? c`, where c is
//                the OLDEST text ask in the range (or null).
// That is what lets the transcript be scanned newest-first and stop at the
// first decisive fact, and lets a memoised prefix be extended by a new tail.

export type AskSummary = { t: 'const'; v: AskState } | { t: 'inherit'; c: AskState };

export const IDENTITY_SUMMARY: AskSummary = Object.freeze({ t: 'inherit', c: null }) as AskSummary;

export function summaryOfFact(fact: AskFact): AskSummary {
  switch (fact.t) {
    case 'toolAsk': return { t: 'const', v: { kind: fact.kind, source: 'tool' } };
    case 'userTurn':
      return classifyUserTurn(fact.ev) === 'real' ? { t: 'const', v: null } : IDENTITY_SUMMARY;
    case 'endTurn':
      return isTextAsk(fact.text) ? { t: 'inherit', c: { kind: 'question', source: 'text' } } : IDENTITY_SUMMARY;
  }
}

// `newer` applied over `older` (newer covers the later range).
export function composeSummaries(newer: AskSummary, older: AskSummary): AskSummary {
  if (newer.t === 'const') return newer;
  if (older.t === 'const') return { t: 'const', v: older.v ?? newer.c };
  return { t: 'inherit', c: older.c ?? newer.c };
}

export function applySummary(summary: AskSummary, incoming: AskState): AskState {
  return summary.t === 'const' ? summary.v : (incoming ?? summary.c);
}

// ── Event → fact mapping (shared by both feeds) ──────────────────────────

// Top-level events only. The caller deduplicates tool asks per toolUseId.
export function askFactsOfEvent(ev: UiEvent): AskFact[] {
  if (ev.parentToolUseId) return [];
  const toolUseId = typeof ev.toolUseId === 'string' ? ev.toolUseId : null;
  if (ev.kind === 'user_question') return [{ t: 'toolAsk', kind: 'question', toolUseId }];
  if (ev.kind === 'plan_request' && !ev.autoApproved) return [{ t: 'toolAsk', kind: 'plan', toolUseId }];
  if (ev.kind === 'user_echo') return [{ t: 'userTurn', ev }];
  return [];
}

// ── Live feed ─────────────────────────────────────────────────────────────

interface EnvelopeBlock { type?: unknown; id?: unknown; name?: unknown; text?: unknown; input?: { questions?: unknown } | null }

// Turns an Instance's UiEvents into facts. Tool asks arrive on two arms — the
// streamed `user_question`/`plan_request` and the reconciled `assistant_message`
// envelope (which the CLI sends first) — and are emitted once per toolUseId from
// whichever lands first. The turn's final text is the last text block of its
// last message, from either arm (both carry the same text); a turn that ends
// with stop_reason end_turn yields one endTurn fact carrying it.
export class LiveAskFacts {
  #planAutoApproves: () => boolean;
  #seen = new Set<string>();
  // msgId → text of that message's latest text block (per blockIdx while streaming).
  #blocks = new Map<string, Map<number, string>>();
  #lastMsgId: string | null = null;

  // `planAutoApproves` is the same rule the plan_request auto-approve gate
  // reads (Instance._planAutoApproves), for the envelope arm, which arrives
  // before the event that gate annotates.
  constructor(planAutoApproves: () => boolean) {
    this.#planAutoApproves = planAutoApproves;
  }

  onTurnStart(): void {
    this.#seen.clear();
    this.#blocks.clear();
    this.#lastMsgId = null;
  }

  feed(ev: UiEvent): AskFact[] {
    if (ev.parentToolUseId) return [];
    const msgId = typeof ev.msgId === 'string' ? ev.msgId : null;
    if (msgId) this.#lastMsgId = msgId;
    if (ev.kind === 'text_delta' && msgId) {
      const idx = typeof ev.blockIdx === 'number' ? ev.blockIdx : 0;
      const m = this.#blocks.get(msgId) ?? new Map<number, string>();
      m.set(idx, (m.get(idx) ?? '') + (typeof ev.text === 'string' ? ev.text : ''));
      this.#blocks.set(msgId, m);
      return [];
    }
    if (ev.kind === 'assistant_message') return this.#fromEnvelope(ev, msgId);
    if (ev.kind === 'turn_end') {
      const facts: AskFact[] = [];
      if (!ev.isError && ev.stopReason === 'end_turn') facts.push({ t: 'endTurn', text: this.#finalText() });
      this.onTurnStart();
      return facts;
    }
    return askFactsOfEvent(ev).filter(f => this.#firstSighting(f));
  }

  #fromEnvelope(ev: UiEvent, msgId: string | null): AskFact[] {
    const message = ev.message as { content?: unknown } | null | undefined;
    const content = Array.isArray(message?.content) ? message.content as EnvelopeBlock[] : [];
    const facts: AskFact[] = [];
    const texts = new Map<number, string>();
    content.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text' && typeof b.text === 'string') texts.set(i, b.text);
      if (b.type !== 'tool_use') return;
      const toolUseId = typeof b.id === 'string' ? b.id : null;
      let fact: AskFact | null = null;
      if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) fact = { t: 'toolAsk', kind: 'question', toolUseId };
      else if (b.name === 'ExitPlanMode' && !this.#planAutoApproves()) fact = { t: 'toolAsk', kind: 'plan', toolUseId };
      if (fact && this.#firstSighting(fact)) facts.push(fact);
    });
    if (msgId && texts.size) this.#blocks.set(msgId, texts);
    return facts;
  }

  #firstSighting(fact: AskFact): boolean {
    if (fact.t !== 'toolAsk' || !fact.toolUseId) return true;
    if (this.#seen.has(fact.toolUseId)) return false;
    this.#seen.add(fact.toolUseId);
    return true;
  }

  #finalText(): string {
    const m = this.#lastMsgId ? this.#blocks.get(this.#lastMsgId) : undefined;
    if (!m || !m.size) return '';
    return m.get(Math.max(...m.keys())) ?? '';
  }
}
