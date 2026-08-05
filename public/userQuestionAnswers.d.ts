// Hand-written declaration for public/userQuestionAnswers.js — the one
// src→public import (src/mcp/handlers.ts) needs a typed surface while
// public/ stays .js this round. The shapes below are the module's actual
// runtime contract; keep them in sync with the implementation.

// A question in an AskUserQuestion payload (as the CLI persists it and
// reconstructMessages hoists it).
export interface Question {
  header?: string;
  question?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

// The per-question answer states formatUserQuestionAnswers consumes and
// parseUserQuestionAnswers produces.
export type UserQuestionAnswer =
  | { kind: 'option'; label: string; note?: string }
  | { kind: 'multi'; labels: string[]; note?: string }
  | { kind: 'custom'; text: string }
  | { kind: 'none' };

export function formatUserQuestionAnswers(questions: Question[], answers: Array<UserQuestionAnswer | undefined>): string;

export function isUserQuestionAnswerText(questions: Question[], text: unknown): boolean;

export function parseUserQuestionAnswers(questions: Question[], text: unknown): UserQuestionAnswer[];
