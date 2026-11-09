// Locating a renewal boundary: which segments a "Context renewed" divider
// separates, and where the pre-renewal transcript is cut when a rewind or fork
// is taken there (Instance.rewindAcrossRenewal, Instance.forkAtRenewal).
// Pure: no fs, no store — callers hand in the chain and the file texts.

import { isPureUserPromptLine, type PersistedLine } from './transcript.ts';
import { replayedPromptText } from './sessionEdit.ts';
import { parseRenewSeed } from '../shared/renewSeed.ts';
import { CC_MCP_SERVER_NAME } from './settings.ts';
import { RENEW_SESSION_TOOL } from './sessionRenew.ts';
import { httpError } from './httpError.ts';
import type { LineageSegment } from './sessionLineage.ts';

// `code` on the 400 for a label that names no renewal boundary of the chain.
export const NOT_A_RENEWAL_BOUNDARY = 'NOT_A_RENEWAL_BOUNDARY';

// The wire name a worker's `renew_session` call carries in its transcript.
export const RENEW_TOOL_WIRE_NAME = `mcp__${CC_MCP_SERVER_NAME}__${RENEW_SESSION_TOOL}`;

export interface RenewalBoundary {
  // The segment the conversation ran in before the renewal.
  pre: LineageSegment;
  // Every chain entry from the renew entry to the end, tombstones included.
  post: LineageSegment[];
}

// `label` is a `segment_seam`'s `segmentId`: always the NEWER side of the
// divider, and possibly a prune copy — for `[A, B renew, C prune]` the walk
// labels the A|C divider `C` (lineageSteps, src/lineagePager.ts). Prune entries
// are stepped over to the renew entry they follow. Whether `pre` is a tombstone
// is the caller's check.
export function renewalBoundaryAt(chain: LineageSegment[], label: string): RenewalBoundary {
  let i = chain.findIndex(s => s.id === label);
  while (i > 0 && chain[i].reason === 'prune') i--;
  if (i <= 0 || chain[i].reason !== 'renew') {
    throw httpError(400, 'segment is not a renewal boundary of this session', { code: NOT_A_RENEWAL_BOUNDARY });
  }
  return { pre: chain[i - 1], post: chain.slice(i) };
}

function parsedLines(text: string): Array<PersistedLine | null> {
  return text.split('\n').filter(raw => raw.length > 0).map((raw) => {
    try {
      const obj: unknown = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj as PersistedLine : null;
    } catch { return null; }
  });
}

// A cc-managed renewal's post-renewal transcript holds the reseed among its
// prompts — not necessarily first: prompt() is open between the `/clear`
// rotation and the deferred reseed, so a prompt can land ahead of it. Read off
// the post file rather than off a `renew_session` call in the pre file, which
// a renewal issued from `run_code` never records. A typed `/clear` has no
// reseed, and neither has a managed renewal whose reseed never landed.
function isManagedRenewal(postText: string): boolean {
  return parsedLines(postText).some(obj =>
    obj !== null && isPureUserPromptLine(obj) && parseRenewSeed(replayedPromptText(obj)) !== null);
}

// A SELF-form `renew_session` call: the targeted form names another worker in
// `sessionId` and renews nothing here.
function callsRenewSession(obj: PersistedLine | null): boolean {
  if (obj?.type !== 'assistant' || obj.isSidechain) return false;
  const content: unknown = obj.message?.content;
  return Array.isArray(content) && content.some(b => b?.type === 'tool_use' && b.name === RENEW_TOOL_WIRE_NAME
    && typeof (b.input as { sessionId?: unknown } | undefined)?.sessionId !== 'string');
}

// Where the pre-renewal transcript is cut: the pure user prompt that OPENED the
// turn in which the session's own `renew_session` was called — as the file prompt ordinal and the
// replayed text splitAtUserMessage re-verifies. Anchored on the tool call, not
// on the file's last prompt: a steer inside the arming turn (a `queued_command`
// attachment) and a prompt sent while the renewal was armed but deferred both
// come later, and a targeted call (another worker's renewal) is no anchor.
// A managed renewal with no such call (issued from `run_code`) cuts
// before the file's last turn opener. Null when the renewal is not managed:
// the pre segment is then restored whole.
export function renewalCut(preText: string, postText: string): { userMessageIndex: number; text: string } | null {
  if (!isManagedRenewal(postText)) return null;
  const lines = parsedLines(preText);
  let anchor = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (callsRenewSession(lines[i])) { anchor = i; break; }
  }
  let ordinal = 0;
  let cut: { userMessageIndex: number; text: string } | null = null;
  for (let i = 0; i < anchor; i++) {
    const obj = lines[i];
    if (!obj || !isPureUserPromptLine(obj)) continue;
    if (obj.type === 'user') cut = { userMessageIndex: ordinal, text: replayedPromptText(obj) };
    ordinal++;
  }
  if (!cut) throw httpError(409, 'cannot locate the renewal request in the pre-renewal transcript');
  return cut;
}
