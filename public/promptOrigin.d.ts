// Hand-written declaration for public/promptOrigin.js — the src→public import
// (src/awaitingUser.ts) needs a typed surface while public/ stays .js this
// round. The shapes below are the module's actual runtime contract; keep them
// in sync with the implementation.

// The user_echo fields the classifiers read.
export interface PromptOriginEvent {
  text?: unknown;
  cliInjected?: unknown;
  skillLoad?: unknown;
  compactSummary?: unknown;
  parentToolUseId?: unknown;
}

export type PromptOrigin = 'typed' | 'template' | 'synthetic';

export function isInjectedUserTurn(ev: PromptOriginEvent): boolean;
export function promptOrigin(ev: PromptOriginEvent): PromptOrigin;
export function isPinEligible(origin: unknown, opts: { conducted: boolean }): boolean;
