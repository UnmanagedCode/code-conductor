// Hand-written declaration for public/renewSeed.js — the src→public import
// (src/sessionRenew.ts) needs a typed surface while public/ stays .js this
// round. The shapes below are the module's actual runtime contract; keep them
// in sync with the implementation.

export const RENEW_SEED_PREAMBLE: string;
export const HANDOFF_FENCE: string;
export const FOLLOWUP_FENCE: string;
export const MECHANICAL_STATE_HEADER: string;
export const RENEW_SUMMARY_SECTIONS: Readonly<{
  roster: string;
  completed: string;
  userContext: string;
}>;

export function buildRenewSeed(input?: {
  summary?: string;
  followUp?: string | null;
  stateBlock?: string | null;
}): string;

export function parseRenewSeed(text: unknown): {
  summary: string;
  followUp: string | null;
  state: string | null;
} | null;

export function splitSummarySections(summary: string): Array<{ title: string | null; body: string }>;
