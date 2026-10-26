// Prompt authorship for CONDUCTED workers: whether a prompt came from the human
// (the web UI) or the conductor (an MCP send), recorded in-band so it persists in
// the worker's own CLI jsonl — and the quoting that reports the human's prompts
// back to the conductor (the wake notice, send-time `humanPrompts`).
//
// The record is a separate trailing text block holding exactly one AUTHOR_MARKER
// literal, appended by Instance.prompt only when the instance is conducted. Its
// own block for the reason MID_TURN_NOTE is (the prefix-safety invariant,
// docs/architecture.md); LAST so a reader taking a line's first text block as
// "the prompt" keeps reading the prompt. consolidateUserContent (src/parser.ts)
// turns it into `user_echo.author` and drops it from the text. A line without
// one is author unknown: nothing falls back to text shape.

import type { PromptAuthor } from '../shared/uiEvent.ts';

export const AUTHOR_MARKER: Readonly<Record<PromptAuthor, string>> = {
  human: '[[cc:author:human]]',
  conductor: '[[cc:author:conductor]]',
};

export function authorMarkerBlock(author: PromptAuthor): { type: 'text'; text: string } {
  return { type: 'text', text: AUTHOR_MARKER[author] };
}

// The author a text block records, or null when it is not a marker block.
export function parseAuthorMarker(text: unknown): PromptAuthor | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === AUTHOR_MARKER.human) return 'human';
  if (t === AUTHOR_MARKER.conductor) return 'conductor';
  return null;
}

// `text` without a trailing marker — for a reader handed a marked line's blocks
// already joined into one string (the CLI's `last-prompt` record), whatever the
// separator.
const TRAILING_MARKER = /\s*\[\[cc:author:(?:human|conductor)\]\]\s*$/;
export function stripAuthorMarker(text: string): string {
  return text.replace(TRAILING_MARKER, '');
}

// One CLI line carries one marker, so a coalesced delivery (parked steers, the
// overage queue's combined resume) is the human's if any part was: quoted back,
// the conductor still recognises its own words in it.
export function combineAuthors(authors: ReadonlyArray<PromptAuthor | undefined>): PromptAuthor | undefined {
  if (authors.includes('human')) return 'human';
  if (authors.includes('conductor')) return 'conductor';
  return undefined;
}

// Per quoted prompt, in code points; and how many of the most recent are quoted.
export const HUMAN_PROMPT_QUOTE_MAX_CHARS = 500;
export const HUMAN_PROMPT_QUOTE_MAX_COUNT = 3;

const HUMAN_NOTICE = 'The user prompted this worker directly since your last wake — not your brief. '
  + 'Treat their words as the user\'s instruction to it; don\'t re-steer over them without checking '
  + 'with the user. Their message(s), oldest first:';

function cutPrompt(text: string): string {
  const cps = Array.from(text);
  if (cps.length <= HUMAN_PROMPT_QUOTE_MAX_CHARS) return text;
  return `${cps.slice(0, HUMAN_PROMPT_QUOTE_MAX_CHARS).join('')}… `
    + `[+${cps.length - HUMAN_PROMPT_QUOTE_MAX_CHARS} chars — get_transcript has it in full]`;
}

function selectPrompts(texts: readonly string[]): { omitted: number; kept: string[] } {
  return {
    omitted: Math.max(0, texts.length - HUMAN_PROMPT_QUOTE_MAX_COUNT),
    kept: texts.slice(-HUMAN_PROMPT_QUOTE_MAX_COUNT).map(cutPrompt),
  };
}

const omissionLine = (n: number): string =>
  `(${n} earlier user message(s) not shown — get_transcript has them)`;

// The prompts as the send-time `humanPrompts` field carries them: oldest first,
// each cut, led by an omission entry when older ones were dropped.
export function quoteHumanPrompts(texts: readonly string[]): string[] {
  const { omitted, kept } = selectPrompts(texts);
  return omitted ? [omissionLine(omitted), ...kept] : kept;
}

// The wake stub's leading notice. Every quoted line is prefixed `> ` (prompts
// separated by a bare `>` line), so no quoted text can forge the stub's
// `\n[[cc:wake-body]]\n` separator.
export function humanPromptsNote(texts: readonly string[]): string {
  const { omitted, kept } = selectPrompts(texts);
  const quoted = kept.map(t => t.split('\n').map(line => `> ${line}`).join('\n')).join('\n>\n');
  return [HUMAN_NOTICE, ...(omitted ? [omissionLine(omitted)] : []), quoted].join('\n');
}
