// Hand-written declaration for public/forwardFrame.js — the src→public imports
// (src/mcp/handlers.ts, src/awaitingUser.ts) need a typed surface for this .js
// module. The shapes below are the module's actual runtime contract; keep
// them in sync with the implementation.

export const FORWARD_FRAME_HEADER: string;
export const FORWARD_FRAME_FOOTER: string;

export function buildForwardFrame(input: {
  messages: string[];
  instruction: string;
}): string;

export function parseForwardFrame(text: unknown): {
  payload: string;
  instruction: string;
} | null;

export function splitForwardedMessages(payload: string): string[];
