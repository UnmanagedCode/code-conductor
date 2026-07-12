// Message-reconstruction engine for get_recent_messages. Rebuilds ordered
// assistant messages from a UI-event array (ring or disk-replayed), merges the
// in-memory ring with the on-disk transcript tail, and caps oversized block
// inputs. Lifted out of the handler shell in ./handlers.js — the metadata
// block shape, ring-vs-disk merge, omittedToolOnly counting, inputTruncated
// capping, and oldest-first ordering are a documented MCP contract; keep them
// identical.

import { loadPersistedTranscript } from '../transcript.js';

// Per-message text cap for get_recent_messages raw blocks — mirror
// project_read/project_diff's bounded-output pattern so no tool can emit an
// unbounded body.
export const MSG_TEXT_CAP = 32 * 1024;
// Upper bound on how many trailing on-disk events get_recent_messages
// reconstructs in its (rare) disk-fallback path, so a multi-MB session jsonl
// can't make the call pathological. We only need the last ≤50 messages, which
// fit comfortably in this many events.
const DISK_REPLAY_TAIL_CAP = 5000;

// Cap a string to `cap` bytes, returning { text, truncated }.
export function capText(s, cap) {
  const str = typeof s === 'string' ? s : '';
  if (Buffer.byteLength(str, 'utf8') <= cap) return { text: str, truncated: false };
  return { text: Buffer.from(str, 'utf8').subarray(0, cap).toString('utf8'), truncated: true };
}

// Reconstruct ordered assistant messages from an event array (ring or disk-
// replayed — both carry the same UI-event shape). Collects distinct top-level
// msgIds (skipping sub-agent content) then rebuilds each message.
export function reconstructMessages(events, includeThinking) {
  const seen = new Set();
  const reverseIds = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.parentToolUseId) continue; // ignore sub-agent content
    if (!ev.msgId) continue;
    if (ev.kind !== 'text_delta' && ev.kind !== 'text_end'
        && ev.kind !== 'assistant_message' && ev.kind !== 'tool_use') continue;
    if (seen.has(ev.msgId)) continue;
    seen.add(ev.msgId);
    reverseIds.push(ev.msgId);
  }
  const orderedIds = reverseIds.reverse();
  return orderedIds.map(msgId => buildMessageFromRing(events, msgId, includeThinking));
}

// Disk-fallback for getRecentMessages: load the on-disk transcript tail and
// merge its reconstructed messages with the ring's, keyed by msgId. The ring
// entry wins on collision (freshest / in-flight); disk fills evicted and
// completed-but-evicted current-turn messages. Bounded by DISK_REPLAY_TAIL_CAP.
// Returns null when no transcript exists (e.g. exited temp session) so the
// caller degrades gracefully to ring-only.
export async function mergeRecentWithDisk(inst, ringMessages, includeThinking) {
  const result = await loadPersistedTranscript({
    cwd: inst.cwd, sessionId: inst.sessionId, seqHint: 0,
  }).catch(() => null);
  if (!result) return null;
  let diskEvents = [];
  for (const line of result.lines) for (const ev of line.events) diskEvents.push(ev);
  if (diskEvents.length > DISK_REPLAY_TAIL_CAP) diskEvents = diskEvents.slice(-DISK_REPLAY_TAIL_CAP);
  const diskMessages = reconstructMessages(diskEvents, includeThinking);
  // Ordered merge by msgId: disk first (chronological), ring overrides in place
  // / appends newer (Map keeps first-insert position, updates value).
  const byId = new Map();
  for (const m of diskMessages) byId.set(m.msgId, m);
  for (const m of ringMessages) byId.set(m.msgId, m);
  return [...byId.values()];
}

// Cap a block's large field for inline inclusion in the metadata block. A
// tool_use input stays a structured object when small; when oversized it
// becomes a truncated JSON string flagged with inputTruncated. A thinking
// block's text is capped the same way.
export function capBlockInput(b) {
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
export function hasPlanOrQuestions(m) {
  return !!m.plan || (Array.isArray(m.questions) && m.questions.length > 0);
}

// Index the ring for turn-scoped bonding: map each top-level msgId to the _seq
// of its first ring event, and collect the non-parent turn_end seqs. The
// current turn's messages are always in the ring (they just streamed), so this
// lets the default-count bond scope its walk-back to the turn that produced the
// last message even when the surrounding message list came from the disk merge.
export function ringTurnIndex(ring) {
  const firstSeqByMsgId = new Map();
  const turnEndSeqs = [];
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
export function bondTrailingTurn(filtered, ringTurn) {
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

function buildMessageFromRing(ring, targetMsgId, includeThinking = false) {
  const byBlock = new Map();
  const blockOrder = [];
  const otherBlocks = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantContent = null; // content blocks merged across all assistant_message envelopes for this msgId
  let plan = null;
  let questions = null;
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.msgId !== targetMsgId) continue;
    if (ev.kind === 'text_delta') {
      if (!byBlock.has(ev.blockIdx)) {
        byBlock.set(ev.blockIdx, '');
        blockOrder.push(ev.blockIdx);
      }
      byBlock.set(ev.blockIdx, byBlock.get(ev.blockIdx) + (ev.text ?? ''));
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
      } else if (ev.name === 'AskUserQuestion') {
        const q = ev.input?.questions;
        if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
      }
      if (!hoisted) {
        otherBlocks.push({ type: 'tool_use', name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
      }
    } else if (ev.kind === 'assistant_message') {
      const content = ev.message?.content;
      if (Array.isArray(content) && content.length) (assistantContent ??= []).push(...content);
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
    const textParts = [];
    const blocks = [];
    for (const block of assistantContent) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
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
        } else if (block.name === 'AskUserQuestion') {
          const q = block.input?.questions;
          if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
        }
        if (!hoisted) {
          blocks.push({ type: 'tool_use', name: block.name, input: block.input, toolUseId: block.id });
        }
      } else if (block?.type === 'thinking' && includeThinking) {
        blocks.push({ type: 'thinking', text: block.thinking ?? '' });
      }
    }
    let text = textParts.join('');
    // Never regress below what the deltas captured: if the envelopes carried
    // no text block but deltas streamed one, prefer the delta accumulation.
    if (!text) text = blockOrder.map(idx => byBlock.get(idx)).join('');
    return { msgId: targetMsgId, text, ...(blocks.length ? { blocks } : {}), hasToolUse,
      ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
  }
  const text = blockOrder.map(idx => byBlock.get(idx)).join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse,
    ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
}
