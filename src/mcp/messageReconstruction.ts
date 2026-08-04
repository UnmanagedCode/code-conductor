// Message-reconstruction engine for get_recent_messages. Rebuilds ordered
// assistant messages from a UI-event array (ring or disk-replayed), merges the
// in-memory ring with the on-disk transcript tail, and caps oversized block
// inputs. Lifted out of the handler shell in ./handlers.js — the metadata
// block shape, ring-vs-disk merge, omittedToolOnly counting, inputTruncated
// capping, and oldest-first ordering are a documented MCP contract; keep them
// identical.

import { loadPersistedTranscript } from '../transcript.ts';
import type { InstanceLike } from '../instanceTypes.ts';
import type { UiEvent } from '../parser.ts';

// Per-message text cap for get_recent_messages raw blocks — mirror
// project_read/project_diff's bounded-output pattern so no tool can emit an
// unbounded body.
export const MSG_TEXT_CAP = 32 * 1024;
// Upper bound on how many trailing on-disk events get_recent_messages
// reconstructs in its (rare) disk-fallback path, so a multi-MB session jsonl
// can't make the call pathological. We only need the last few messages the `count` cap allows, which
// fit comfortably in this many events.
const DISK_REPLAY_TAIL_CAP = 5000;

// Cap a string to `cap` bytes, returning { text, truncated }.
export function capText(s: unknown, cap: number): { text: string; truncated: boolean } {
  const str = typeof s === 'string' ? s : '';
  if (Buffer.byteLength(str, 'utf8') <= cap) return { text: str, truncated: false };
  return { text: Buffer.from(str, 'utf8').subarray(0, cap).toString('utf8'), truncated: true };
}

// A ring/archive event narrowed to the fields this engine reads. `_seq` is
// required because every ring event carries it. The boundary into this type is
// a single narrowing cast in reconstructMessages (`events as ReconEvent[]`) —
// ring and replayed events both carry these fields, and ReconEvent is
// assignable to UiEvent, so the cast is one-directional.
interface ReconEvent extends UiEvent {
  msgId?: string | null;
  blockIdx?: number;
  text?: string;
  name?: string;
  input?: Record<string, unknown> | null;
  toolUseId?: string | null;
  message?: { content?: unknown } | null;
  _seq: number;
}

// A block inside a reconstructed message's `blocks` array — either a
// `tool_use` (from the delta or reconciled path) or a `thinking` block.
interface ReconBlockOut {
  type: string;
  name?: unknown;
  input?: unknown;
  toolUseId?: unknown;
  text?: unknown;
}

// A content block from a reconciled `assistant_message` envelope (JSON-shaped).
interface ReconBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: Record<string, unknown> | null;
  id?: unknown;
  thinking?: unknown;
}

// A reconstructed assistant message.
export interface ReconMessage {
  msgId: string;
  text: string;
  blocks?: Array<ReconBlockOut>;
  hasToolUse: boolean;
  plan?: string;
  questions?: unknown;
  textSeq?: number;
  planSeq?: number;
  questionsSeq?: number;
}

// Reconstruct ordered assistant messages from an event array (ring or disk-
// replayed — both carry the same UI-event shape). Collects distinct top-level
// msgIds (skipping sub-agent content) then rebuilds each message.
export function reconstructMessages(events: UiEvent[], includeThinking: boolean): ReconMessage[] {
  const ring = events as ReconEvent[];
  const seen = new Set<string>();
  const reverseIds: string[] = [];
  for (let i = ring.length - 1; i >= 0; i--) {
    const ev = ring[i];
    if (ev.parentToolUseId) continue; // ignore sub-agent content
    if (!ev.msgId) continue;
    if (ev.kind !== 'text_delta' && ev.kind !== 'text_end'
        && ev.kind !== 'assistant_message' && ev.kind !== 'tool_use') continue;
    if (seen.has(ev.msgId)) continue;
    seen.add(ev.msgId);
    reverseIds.push(ev.msgId);
  }
  const orderedIds = reverseIds.reverse();
  return orderedIds.map(msgId => buildMessageFromRing(ring, msgId, includeThinking));
}

// Disk-fallback for getRecentMessages: load the on-disk transcript tail and
// merge its reconstructed messages with the ring's, keyed by msgId. The ring
// entry wins on collision (freshest / in-flight); disk fills evicted and
// completed-but-evicted current-turn messages. Bounded by DISK_REPLAY_TAIL_CAP.
// Returns null when no transcript exists (e.g. exited temp session) so the
// caller degrades gracefully to ring-only.
export async function mergeRecentWithDisk(inst: InstanceLike, ringMessages: ReconMessage[], includeThinking: boolean): Promise<ReconMessage[] | null> {
  const result = await loadPersistedTranscript({
    cwd: inst.cwd, sessionId: inst.sessionId as string, seqHint: 0,
  }).catch(() => null);
  if (!result) return null;
  let diskEvents: UiEvent[] = [];
  for (const line of result.lines) for (const ev of line.events) diskEvents.push(ev);
  if (diskEvents.length > DISK_REPLAY_TAIL_CAP) diskEvents = diskEvents.slice(-DISK_REPLAY_TAIL_CAP);
  const diskMessages = reconstructMessages(diskEvents, includeThinking);
  // Ordered merge by msgId: disk first (chronological), ring overrides in place
  // / appends newer (Map keeps first-insert position, updates value).
  const byId = new Map<string, ReconMessage>();
  for (const m of diskMessages) byId.set(m.msgId, m);
  for (const m of ringMessages) byId.set(m.msgId, m);
  return [...byId.values()];
}

// Cap a block's large field for inline inclusion in the metadata block. A
// tool_use input stays a structured object when small; when oversized it
// becomes a truncated JSON string flagged with inputTruncated. A thinking
// block's text is capped the same way.
export function capBlockInput(b: ReconBlockOut) {
  if (b.type === 'tool_use') {
    const json = JSON.stringify(b.input ?? null);
    const { text, truncated } = capText(json, MSG_TEXT_CAP);
    return {
      type: 'tool_use', name: b.name, toolUseId: b.toolUseId,
      input: truncated ? text : b.input,
      inputTruncated: truncated,
    };
  }
  if (b.type === 'thinking') {
    const { text, truncated } = capText(b.text ?? '', MSG_TEXT_CAP);
    return { type: 'thinking', text, inputTruncated: truncated };
  }
  return b;
}

// A reconstructed message carries an actionable plan or questions (hoisted from
// an ExitPlanMode / AskUserQuestion tool_use).
export function hasPlanOrQuestions(m: ReconMessage): boolean {
  return !!m.plan || (Array.isArray(m.questions) && m.questions.length > 0);
}

// Index the ring for turn-scoped bonding: map each top-level msgId to the _seq
// of its first ring event, and collect the non-parent turn_end seqs. The
// current turn's messages are always in the ring (they just streamed), so this
// lets the default-count bond scope its walk-back to the turn that produced the
// last message even when the surrounding message list came from the disk merge.
export function ringTurnIndex(ring: ReconEvent[]): { firstSeqByMsgId: Map<string, number>; turnEndSeqs: number[] } {
  const firstSeqByMsgId = new Map<string, number>();
  const turnEndSeqs: number[] = [];
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.kind === 'turn_end') { if (ev._seq != null) turnEndSeqs.push(ev._seq); continue; }
    if (ev.msgId && ev._seq != null && !firstSeqByMsgId.has(ev.msgId)) {
      firstSeqByMsgId.set(ev.msgId, ev._seq);
    }
  }
  return { firstSeqByMsgId, turnEndSeqs };
}

// Default-count selection for get_recent_messages / the wake fold. Given the
// text-bearing `filtered` messages (oldest-first) and the ring turn index,
// return the trailing slice to surface. When the last message is pure prose,
// walk back WITHIN THE SAME TURN and bond from the nearest preceding
// plan/question message through the end of the turn — so a turn whose trailing
// prose spans 2+ messages still surfaces the plan/question the conductor must
// act on. A plan from a previous turn is never pulled in (the walk stops at the
// turn boundary), and a last message that already carries its own plan/question
// is returned alone.
export function bondTrailingTurn(filtered: ReconMessage[], ringTurn: { firstSeqByMsgId: Map<string, number>; turnEndSeqs: number[] }): ReconMessage[] {
  const lastIdx = filtered.length - 1;
  const last = filtered[lastIdx];
  if (!last) return filtered;
  const lastIsPureProse = !hasPlanOrQuestions(last) && (last.text ?? '').length > 0;
  if (!lastIsPureProse) return [last];
  const lastFirstSeq = ringTurn.firstSeqByMsgId.get(last.msgId);
  if (lastFirstSeq == null) return [last]; // last off-ring (shouldn't happen) — no bond
  // Turn boundary = the largest turn_end seq strictly before the last message's
  // start; messages at/below it belong to an earlier turn.
  let boundary = -1;
  for (const s of ringTurn.turnEndSeqs) if (s < lastFirstSeq && s > boundary) boundary = s;
  let startIdx = lastIdx;
  for (let i = lastIdx - 1; i >= 0; i--) {
    const fs = ringTurn.firstSeqByMsgId.get(filtered[i].msgId);
    if (fs == null || fs <= boundary) break;    // crossed the turn boundary / off-ring
    startIdx = i;
    if (hasPlanOrQuestions(filtered[i])) break;  // include the plan/question msg and stop
  }
  // Only bond if we actually reached a plan/question message this turn.
  if (startIdx === lastIdx || !hasPlanOrQuestions(filtered[startIdx])) return [last];
  return filtered.slice(startIdx);
}

function buildMessageFromRing(ring: ReconEvent[], targetMsgId: string, includeThinking = false): ReconMessage {
  const byBlock = new Map<number, string>();
  const blockOrder: number[] = [];
  const otherBlocks: ReconBlockOut[] = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantContent: ReconBlock[] | null = null; // content blocks merged across all assistant_message envelopes for this msgId
  let plan: string | null = null;
  let questions: unknown = null;
  // seq/*Seq: arrival-order position of each segment within the message, so
  // the body renderer (handlers.js) can interleave prose/plan/questions in the
  // order the underlying blocks actually occurred instead of hardcoding
  // "prose then plan" — set once, at each segment's first occurrence.
  let seq = 0;
  let textSeq: number | null = null, planSeq: number | null = null, questionsSeq: number | null = null;
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.msgId !== targetMsgId) continue;
    if (ev.kind === 'text_delta') {
      const idx = ev.blockIdx as number; // text_delta always carries blockIdx
      if (!byBlock.has(idx)) {
        byBlock.set(idx, '');
        blockOrder.push(idx);
        if (textSeq === null) textSeq = seq++;
      }
      byBlock.set(idx, (byBlock.get(idx) ?? '') + (ev.text ?? ''));
    } else if (ev.kind === 'tool_use') {
      hasToolUse = true;
      let hoisted = false;
      if (ev.name === 'ExitPlanMode') {
        const p = ev.input?.plan;
        if (typeof p === 'string' && p.length > 0) {
          plan = p;
          hoisted = true;
        } else {
          const fp = ev.input?.planFilePath ?? ev.input?.planPath;
          if (typeof fp === 'string' && fp.length > 0) { plan = `(plan at ${fp})`; hoisted = true; }
        }
        if (hoisted && planSeq === null) planSeq = seq++;
      } else if (ev.name === 'AskUserQuestion') {
        const q = ev.input?.questions;
        if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
        if (hoisted && questionsSeq === null) questionsSeq = seq++;
      }
      if (!hoisted) {
        otherBlocks.push({ type: 'tool_use', name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
      }
    } else if (ev.kind === 'assistant_message') {
      const content = ev.message?.content;
      if (Array.isArray(content) && content.length) (assistantContent ??= []).push(...content as ReconBlock[]);
    }
  }
  // If reconciled assistant_message envelopes arrived (real CLI), they're the
  // authoritative source — extract text blocks from them instead of the
  // delta accumulation (handles edge cases like deltas trimmed by the ring).
  // A message may arrive as ONE multi-block envelope (legacy CLI) or as N
  // single-block envelopes sharing the msgId, one per finalized content block
  // (async-worker CLI); both are the concatenation of envelope content in
  // arrival order, which matches block order.
  if (assistantContent) {
    const textParts: string[] = [];
    const blocks: ReconBlockOut[] = [];
    let seq2 = 0;
    let textSeq2: number | null = null, planSeq2: number | null = null, questionsSeq2: number | null = null;
    for (const block of assistantContent) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        if (textSeq2 === null) textSeq2 = seq2++;
      } else if (block?.type === 'tool_use') {
        hasToolUse = true;
        let hoisted = false;
        if (block.name === 'ExitPlanMode') {
          const p = block.input?.plan;
          if (typeof p === 'string' && p.length > 0) {
            plan = p;
            hoisted = true;
          } else {
            const fp = block.input?.planFilePath ?? block.input?.planPath;
            if (typeof fp === 'string' && fp.length > 0) { plan = `(plan at ${fp})`; hoisted = true; }
          }
          if (hoisted && planSeq2 === null) planSeq2 = seq2++;
        } else if (block.name === 'AskUserQuestion') {
          const q = block.input?.questions;
          if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
          if (hoisted && questionsSeq2 === null) questionsSeq2 = seq2++;
        }
        if (!hoisted) {
          blocks.push({ type: 'tool_use', name: block.name, input: block.input, toolUseId: block.id });
        }
      } else if (block?.type === 'thinking' && includeThinking) {
        blocks.push({ type: 'thinking', text: (block.thinking ?? '') as string });
      }
    }
    let text = textParts.join('');
    // Never regress below what the deltas captured: if the envelopes carried
    // no text block but deltas streamed one, prefer the delta accumulation.
    // Its seq lives on a DIFFERENT counter (seq, not seq2) than the rest of
    // this reconciled pass, so it can't be compared against planSeq2/
    // questionsSeq2 by value — instead pin it to -1 (guaranteed to sort
    // before any seq2, which starts at 0). This is also semantically right:
    // an envelope-less text block can only be the delta stream's own block,
    // which — per the arrival-order comment above — always finalizes before
    // any block a reconciled envelope in THIS pass reports on.
    if (!text) { text = blockOrder.map(idx => byBlock.get(idx) ?? '').join(''); if (text) textSeq2 = -1; }
    return { msgId: targetMsgId, text, ...(blocks.length ? { blocks } : {}), hasToolUse,
      ...(plan ? { plan } : {}), ...(questions ? { questions } : {}),
      ...(textSeq2 !== null ? { textSeq: textSeq2 } : {}),
      ...(planSeq2 !== null ? { planSeq: planSeq2 } : {}),
      ...(questionsSeq2 !== null ? { questionsSeq: questionsSeq2 } : {}) };
  }
  const text = blockOrder.map(idx => byBlock.get(idx) ?? '').join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse,
    ...(plan ? { plan } : {}), ...(questions ? { questions } : {}),
    ...(textSeq !== null ? { textSeq } : {}),
    ...(planSeq !== null ? { planSeq } : {}),
    ...(questionsSeq !== null ? { questionsSeq } : {}) };
}
