// Pairs the outer user_echo that answers an AskUserQuestion card with that
// card, so the client can render a dedicated answer bubble. The CLI's jsonl
// stores only the answer text, so correlation — not an origin tag — is the one
// signal that exists identically live and on replay. Fed every event in stream
// order by Instance._emitUi (live) and loadPersistedTranscript (disk); the
// stamp lives on the UI event only and is never sent to the CLI.

import { isOuterUserEcho, type UiEvent } from './parser.ts';
import { isUserQuestionAnswerText, type Question } from '../public/userQuestionAnswers.js';

export class QuestionAnswerCorrelator {
  #pending: { toolUseId: string | null; questions: Question[] } | null = null;

  apply(ev: UiEvent): void {
    if (ev.kind === 'user_question') {
      // Sub-agent questions are not tracked: their answer arrives as an outer
      // echo, and sub-agent replay ordering differs from live.
      if (ev.parentToolUseId || !Array.isArray(ev.questions) || ev.questions.length === 0) return;
      this.#pending = {
        toolUseId: typeof ev.toolUseId === 'string' ? ev.toolUseId : null,
        questions: ev.questions as Question[],
      };
      return;
    }
    if (!this.#pending || !isOuterUserEcho(ev)) return;
    // Already stamped from disk and re-emitted through _emitUi: it answered
    // the pending card, so consume the slot without restamping.
    if (ev.questionAnswer) { this.#pending = null; return; }
    if (ev.cliInjected || ev.skillLoad) return;
    // A non-answer echo (e.g. an interleaved wake stub) leaves the slot armed.
    if (!isUserQuestionAnswerText(this.#pending.questions, ev.text)) return;
    ev.questionAnswer = { toolUseId: this.#pending.toolUseId, questions: this.#pending.questions };
    this.#pending = null;
  }
}
