// Message-reconstruction engine for get_recent_messages. Rebuilds ordered
// assistant messages from a UI-event array (ring or disk-replayed), merges the
// in-memory ring with the on-disk transcript tail, and renders tool_use inputs
// as a per-argument descriptor unless the caller asked for them verbatim.
// Lifted out of the handler shell in ./handlers.ts — the metadata block shape,
// ring-vs-disk merge, omittedToolOnly counting, inputTruncated / descriptor
// rendering, and oldest-first ordering are a documented MCP contract; keep
// them identical.

import { loadPersistedTranscript } from '../transcript.ts';
// One-directional edge into the archive stamper (eventArchive.ts imports
// nothing from this module), so the disk-replay seq space is stamped in exactly
// one place for both the paging and the message-selection reads.
import { stampArchiveEvents } from '../eventArchive.ts';
import type { InstanceLike } from '../instanceTypes.ts';
import { isOuterUserEcho, type UiEvent } from '../parser.ts';

// Per-message text cap for get_recent_messages raw blocks — mirror
// project_read/project_diff's bounded-output pattern so no tool can emit an
// unbounded body.
export const MSG_TEXT_CAP = 32 * 1024;
// Per-ARGUMENT cap for the default (descriptor) rendering of a tool_use input.
// Deliberately three orders of magnitude below MSG_TEXT_CAP: the default read is
// for orientation, and the actionable part of a tool call is its pointers — a
// file_path, a command, a pattern — not its payload. 512 bytes holds every
// realistic pointer whole (the longest observed plan path is ~90 bytes; a Bash
// command or Grep pattern runs 100-300) while keeping a whole descriptor to a few
// hundred bytes per key. Verbatim payloads are one includeToolCalls:true away.
export const TOOL_ARG_VALUE_CAP = 512;
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
  planPath?: string;
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
  // The plan file backing an ExitPlanMode is resolved once, upstream, onto the
  // `plan_request` event (src/planFile.ts) — it is never re-derived here. That
  // event carries no msgId, so the join key into the owning message is the
  // toolUseId both the delta-path `tool_use` event and the reconciled
  // envelope's `block.id` carry. The event's own `plan` rides along: when the
  // tool input was empty the enrichment read the file, and its contents are
  // the plan text (the tool_use block has none).
  const planPaths = new Map<string, { planPath: string; plan?: string }>();
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.kind !== 'plan_request') continue;
    const p = (ev as { planPath?: unknown }).planPath;
    const t = (ev as { plan?: unknown }).plan;
    if (typeof ev.toolUseId === 'string' && typeof p === 'string' && p) {
      planPaths.set(ev.toolUseId, { planPath: p, ...(typeof t === 'string' && t ? { plan: t } : {}) });
    }
  }
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
  return orderedIds.map(msgId => buildMessageFromRing(ring, msgId, includeThinking, planPaths));
}

// Disk-fallback for getRecentMessages: load the on-disk transcript tail and
// merge its reconstructed messages with the ring's, keyed by msgId. The ring
// entry wins on collision (freshest / in-flight); disk fills evicted and
// completed-but-evicted current-turn messages. Bounded by DISK_REPLAY_TAIL_CAP.
// Returns null when no transcript exists (e.g. exited temp session) so the
// caller degrades gracefully to ring-only.
export async function mergeRecentWithDisk(inst: InstanceLike, ringMessages: ReconMessage[], includeThinking: boolean): Promise<ReconMessage[] | null> {
  const result = await loadPersistedTranscript({
    cwd: inst.cwd, sessionId: inst.backingSessionId as string, seqHint: 0,
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

// Describe ONE tool argument for the default rendering: keep it verbatim when
// small, else replace it with a marker naming its type and size. The rule is
// type-agnostic — a node is kept WHOLE or replaced WHOLE, never partially
// recursed into — which is what bounds a huge array of individually-small
// elements (its own JSON blows the cap, so the array collapses to one marker).
// Strings gate on their raw utf8 bytes, so "an argument up to
// TOOL_ARG_VALUE_CAP bytes rides verbatim" is literally true and the marker's
// byte count is the number a reader can compare against a file on disk;
// everything else gates on its JSON encoding, which the marker labels.
function describeArg(v: unknown): { value: unknown; omitted: boolean } {
  if (typeof v === 'string') {
    const bytes = Buffer.byteLength(v, 'utf8');
    if (bytes <= TOOL_ARG_VALUE_CAP) return { value: v, omitted: false };
    return { value: `[omitted: string, ${bytes} bytes]`, omitted: true };
  }
  // `?? 'null'` because JSON.stringify(undefined) returns undefined, not a
  // string — an explicitly-undefined argument would otherwise throw in
  // Buffer.byteLength. Tool inputs come from JSON.parse of the CLI stream, so
  // BigInt / circular values cannot occur here.
  const json = JSON.stringify(v) ?? 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= TOOL_ARG_VALUE_CAP) return { value: v, omitted: false };
  if (Array.isArray(v)) return { value: `[omitted: array, ${v.length} items, ${bytes} bytes of JSON]`, omitted: true };
  if (v && typeof v === 'object') {
    return { value: `[omitted: object, ${Object.keys(v).length} keys, ${bytes} bytes of JSON]`, omitted: true };
  }
  return { value: `[omitted: ${bytes} bytes of JSON]`, omitted: true };
}

// Per-argument descriptor for a whole tool_use input, preserving key order.
function describeToolInput(input: Record<string, unknown> | null | undefined): { input: unknown; omitted: boolean } {
  if (!input || typeof input !== 'object') return { input: input ?? null, omitted: false };
  const out: Record<string, unknown> = {};
  let omitted = false;
  for (const [k, v] of Object.entries(input)) {
    const d = describeArg(v);
    out[k] = d.value;
    if (d.omitted) omitted = true;
  }
  return { input: out, omitted };
}

// Cap a block's large field for inline inclusion in the metadata block.
//
// `verbatim` is the caller's includeToolCalls. FALSE (the default read, and the
// idle-subscription wake fold) emits a per-ARGUMENT descriptor: pointers ride
// whole, oversized arguments become `[omitted: …]` markers, and the block
// carries inputTruncated:true. TRUE emits the whole input, capped as one unit at
// MSG_TEXT_CAP exactly as before.
//
// The MSG_TEXT_CAP cap stays on BOTH paths, so it remains a hard structural
// ceiling: even a pathological input with dozens of keys can only ever grow the
// descriptor to what today's single cap already allowed.
//
// A thinking block is unchanged on both paths — includeThinking already gates it,
// and its text is prose through the same cap as message text, not JSON-escaped
// tool arguments.
export function capBlockInput(b: ReconBlockOut, verbatim: boolean) {
  if (b.type === 'tool_use') {
    const described = verbatim ? { input: b.input ?? null, omitted: false } : describeToolInput(b.input as Record<string, unknown> | null | undefined);
    const json = JSON.stringify(described.input ?? null);
    const { text, truncated } = capText(json, MSG_TEXT_CAP);
    return {
      type: 'tool_use', name: b.name, toolUseId: b.toolUseId,
      input: truncated ? text : described.input,
      inputTruncated: truncated || described.omitted,
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
  return !!m.plan || !!m.planPath || (Array.isArray(m.questions) && m.questions.length > 0);
}

// What bondTrailingTurn needs to scope a walk-back to one turn: where each
// top-level message starts, and the seqs that separate one turn from the next.
// `turnBoundarySeqs` is deliberately not "turn_end seqs" — the ring supplies
// turn_end seqs, the disk supplies outer-user_echo seqs (see diskTurnIndex),
// and both partition the message list identically.
export interface TurnIndex {
  firstSeqByMsgId: Map<string, number>;
  turnBoundarySeqs: number[];
}

// Index the ring for turn-scoped bonding: map each top-level msgId to the _seq
// of its first ring event, and collect the non-parent turn_end seqs. The
// current turn's messages are always in the ring (they just streamed), so this
// lets the default-count bond scope its walk-back to the turn that produced the
// last message even when the surrounding message list came from the disk merge.
export function ringTurnIndex(ring: ReconEvent[]): TurnIndex {
  const firstSeqByMsgId = new Map<string, number>();
  const turnBoundarySeqs: number[] = [];
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.kind === 'turn_end') { if (ev._seq != null) turnBoundarySeqs.push(ev._seq); continue; }
    if (ev.msgId && ev._seq != null && !firstSeqByMsgId.has(ev.msgId)) {
      firstSeqByMsgId.set(ev.msgId, ev._seq);
    }
  }
  return { firstSeqByMsgId, turnBoundarySeqs };
}

// The same index over DISK-replayed events. `turn_end` is stream-only — the CLI
// never persists it (src/transcript.ts; the reason is recorded in the header of
// src/eventArchive.ts) — so a replayed array carries no turn_end at all and a
// ringTurnIndex over it would hand bondTrailingTurn an empty boundary list,
// silently pulling a previous turn's plan into the bond.
//
// The substitution: an outer `user_echo` STARTS a turn, so it sits between the
// previous turn's last message and this turn's first — exactly the position a
// turn_end occupies for partitioning purposes. Feeding echo seqs where
// bondTrailingTurn expects boundary seqs yields the same partition, so its
// comparison logic is unchanged.
export function diskTurnIndex(events: ReconEvent[]): TurnIndex {
  const firstSeqByMsgId = new Map<string, number>();
  const turnBoundarySeqs: number[] = [];
  for (const ev of events) {
    if (ev.parentToolUseId) continue;
    if (isOuterUserEcho(ev)) { if (ev._seq != null) turnBoundarySeqs.push(ev._seq); continue; }
    if (ev.msgId && ev._seq != null && !firstSeqByMsgId.has(ev.msgId)) {
      firstSeqByMsgId.set(ev.msgId, ev._seq);
    }
  }
  return { firstSeqByMsgId, turnBoundarySeqs };
}

// Reconstruct a NON-LIVE session's recent messages entirely from its persisted
// jsonl — no instance, no ring (src/mcp/handlers.ts getInstOrDisk's `{disk}`
// branch). Returns null when no transcript exists, so the caller degrades to
// the same empty-result path a live session with nothing to show takes.
//
// The DISK_REPLAY_TAIL_CAP slice happens AFTER stamping, so the surviving seqs
// keep their original dense values — they stay monotonic, which is all
// bondTrailingTurn compares. (Truncating away the echo that opened the last
// turn is possible only for a turn longer than the cap; bonding then safely
// degrades to last-message-only.)
export async function loadDiskSelection({ cwd, backingSessionId, includeThinking }: {
  cwd: string; backingSessionId: string; includeThinking: boolean;
}): Promise<{ messages: ReconMessage[]; turnIndex: TurnIndex } | null> {
  const result = await loadPersistedTranscript({ cwd, sessionId: backingSessionId, seqHint: 0 }).catch(() => null);
  if (!result) return null;
  let events: ReconEvent[] = stampArchiveEvents(result.lines) as ReconEvent[];
  if (events.length > DISK_REPLAY_TAIL_CAP) events = events.slice(-DISK_REPLAY_TAIL_CAP);
  return { messages: reconstructMessages(events, includeThinking), turnIndex: diskTurnIndex(events) };
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
export function bondTrailingTurn(filtered: ReconMessage[], ringTurn: TurnIndex): ReconMessage[] {
  const lastIdx = filtered.length - 1;
  const last = filtered[lastIdx];
  if (!last) return filtered;
  const lastIsPureProse = !hasPlanOrQuestions(last) && (last.text ?? '').length > 0;
  if (!lastIsPureProse) return [last];
  const lastFirstSeq = ringTurn.firstSeqByMsgId.get(last.msgId);
  if (lastFirstSeq == null) return [last]; // last off-ring (shouldn't happen) — no bond
  // Turn boundary = the largest boundary seq strictly before the last message's
  // start; messages at/below it belong to an earlier turn.
  let boundary = -1;
  for (const s of ringTurn.turnBoundarySeqs) if (s < lastFirstSeq && s > boundary) boundary = s;
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

// Message-level fields hoisted OUT of a tool_use block. Shared by both passes
// of buildMessageFromRing: the delta pass writes them first, and if reconciled
// envelopes exist that pass may overwrite them with the same values.
interface HoistTarget {
  plan: string | null;
  planPath: string | null;
  questions: unknown;
}

// One pass's arrival-order counter plus the position stamped on each segment.
// PER PASS, never shared: the delta pass and the reconciled pass number their
// segments on independent counters.
interface SegmentSeqs {
  next: number;
  textSeq: number | null;
  planSeq: number | null;
  questionsSeq: number | null;
}

// Hoist an ExitPlanMode / AskUserQuestion tool_use out of a message's blocks[]
// into the message-level plan / planPath / questions fields, stamping the
// segment's arrival position on this pass's counter. `name`/`id` are `unknown`
// because the delta path supplies `ev.name`/`ev.toolUseId` and the reconciled
// path supplies `block.name`/`block.id`; both are guarded by the same
// `typeof … === 'string'` / literal comparisons.
//
// Returns true when the block WAS hoisted — the caller must then NOT also push
// it into blocks[] ("not duplicated in blocks[]", the contract in mcp/tools.ts).
// The flag is per CALL, never derived from `out`: a second pass seeing an
// unhoistable ExitPlanMode still pushes it even though the first pass already
// filled `out.plan`.
//
// A path with no text still hoists: bonding survives either way (planPath is
// set outside `hoisted`), but without it the ExitPlanMode block ALSO lands in
// blocks[], contradicting that contract, and planSeq is never assigned so the
// plan segment sorts last instead of in arrival order.
function hoistPlanAndQuestions(
  name: unknown,
  input: Record<string, unknown> | null | undefined,
  id: unknown,
  planPaths: Map<string, { planPath: string; plan?: string }>,
  out: HoistTarget,
  seqs: SegmentSeqs,
): boolean {
  let hoisted = false;
  if (name === 'ExitPlanMode') {
    const p = input?.plan;
    const pathFromEvent = typeof id === 'string' ? planPaths.get(id) : undefined;
    if (typeof p === 'string' && p.length > 0) { out.plan = p; hoisted = true; }
    else if (pathFromEvent?.plan) { out.plan = pathFromEvent.plan; hoisted = true; }
    if (pathFromEvent) { out.planPath = pathFromEvent.planPath; hoisted = true; }
    if (hoisted && seqs.planSeq === null) seqs.planSeq = seqs.next++;
  } else if (name === 'AskUserQuestion') {
    const q = input?.questions;
    if (Array.isArray(q) && q.length > 0) { out.questions = q; hoisted = true; }
    if (hoisted && seqs.questionsSeq === null) seqs.questionsSeq = seqs.next++;
  }
  return hoisted;
}

function buildMessageFromRing(ring: ReconEvent[], targetMsgId: string, includeThinking = false, planPaths: Map<string, { planPath: string; plan?: string }> = new Map()): ReconMessage {
  const byBlock = new Map<number, string>();
  const blockOrder: number[] = [];
  const otherBlocks: ReconBlockOut[] = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantContent: ReconBlock[] | null = null; // content blocks merged across all assistant_message envelopes for this msgId
  // SHARED across both passes below — the delta pass writes these first and the
  // reconciled pass, if it runs, writes into the same object.
  const hoist: HoistTarget = { plan: null, planPath: null, questions: null };
  // next/*Seq: arrival-order position of each segment within the message, so
  // the body renderer (handlers.ts) can interleave prose/plan/questions in the
  // order the underlying blocks actually occurred instead of hardcoding
  // "prose then plan" — set once, at each segment's first occurrence.
  const d: SegmentSeqs = { next: 0, textSeq: null, planSeq: null, questionsSeq: null };
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.msgId !== targetMsgId) continue;
    if (ev.kind === 'text_delta') {
      const idx = ev.blockIdx as number; // text_delta always carries blockIdx
      if (!byBlock.has(idx)) {
        byBlock.set(idx, '');
        blockOrder.push(idx);
        if (d.textSeq === null) d.textSeq = d.next++;
      }
      byBlock.set(idx, (byBlock.get(idx) ?? '') + (ev.text ?? ''));
    } else if (ev.kind === 'tool_use') {
      hasToolUse = true;
      if (!hoistPlanAndQuestions(ev.name, ev.input, ev.toolUseId, planPaths, hoist, d)) {
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
    // A FRESH counter — the delta pass's positions live on `d` and are never
    // comparable by value against these.
    const r: SegmentSeqs = { next: 0, textSeq: null, planSeq: null, questionsSeq: null };
    for (const block of assistantContent) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        if (r.textSeq === null) r.textSeq = r.next++;
      } else if (block?.type === 'tool_use') {
        hasToolUse = true;
        if (!hoistPlanAndQuestions(block.name, block.input, block.id, planPaths, hoist, r)) {
          blocks.push({ type: 'tool_use', name: block.name, input: block.input, toolUseId: block.id });
        }
      } else if (block?.type === 'thinking' && includeThinking) {
        blocks.push({ type: 'thinking', text: (block.thinking ?? '') as string });
      }
    }
    let text = textParts.join('');
    // Never regress below what the deltas captured: if the envelopes carried
    // no text block but deltas streamed one, prefer the delta accumulation.
    // Its seq lives on a DIFFERENT counter (`d`, not `r`) than the rest of
    // this reconciled pass, so it can't be compared against r.planSeq/
    // r.questionsSeq by value — instead pin it to -1 (guaranteed to sort
    // before any r.next, which starts at 0). This is also semantically right:
    // an envelope-less text block can only be the delta stream's own block,
    // which — per the arrival-order comment above — always finalizes before
    // any block a reconciled envelope in THIS pass reports on.
    if (!text) { text = blockOrder.map(idx => byBlock.get(idx) ?? '').join(''); if (text) r.textSeq = -1; }
    return { msgId: targetMsgId, text, ...(blocks.length ? { blocks } : {}), hasToolUse,
      ...(hoist.plan ? { plan: hoist.plan } : {}),
      ...(hoist.planPath ? { planPath: hoist.planPath } : {}),
      ...(hoist.questions ? { questions: hoist.questions } : {}),
      ...(r.textSeq !== null ? { textSeq: r.textSeq } : {}),
      ...(r.planSeq !== null ? { planSeq: r.planSeq } : {}),
      ...(r.questionsSeq !== null ? { questionsSeq: r.questionsSeq } : {}) };
  }
  const text = blockOrder.map(idx => byBlock.get(idx) ?? '').join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse,
    ...(hoist.plan ? { plan: hoist.plan } : {}),
    ...(hoist.planPath ? { planPath: hoist.planPath } : {}),
    ...(hoist.questions ? { questions: hoist.questions } : {}),
    ...(d.textSeq !== null ? { textSeq: d.textSeq } : {}),
    ...(d.planSeq !== null ? { planSeq: d.planSeq } : {}),
    ...(d.questionsSeq !== null ? { questionsSeq: d.questionsSeq } : {}) };
}
