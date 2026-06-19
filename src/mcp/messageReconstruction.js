// Message-reconstruction engine for get_recent_messages. Rebuilds ordered
// assistant messages from a UI-event array (ring or disk-replayed), merges the
// in-memory ring with the on-disk transcript tail, and caps oversized block
// inputs. Lifted out of the handler shell in ./handlers.js — the metadata
// block shape, ring-vs-disk merge, omittedToolOnly counting, inputTruncated
// capping, and oldest-first ordering are a documented MCP contract; keep them
// identical.

import { loadPersistedTranscript } from '../transcript.js';

// Per-message text cap for get_recent_messages raw blocks — mirror
// read_file/get_worktree_diff's bounded-output pattern so no tool can emit an
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

function buildMessageFromRing(ring, targetMsgId, includeThinking = false) {
  const byBlock = new Map();
  const blockOrder = [];
  const otherBlocks = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantMessage = null;
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
      assistantMessage = ev.message ?? null;
    }
  }
  // If a reconciled assistant_message arrived (real CLI), it's the
  // authoritative source — extract text blocks from it instead of the
  // delta accumulation (handles edge cases like deltas trimmed by the ring).
  if (assistantMessage && Array.isArray(assistantMessage.content)) {
    const textParts = [];
    const blocks = [];
    for (const block of assistantMessage.content) {
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
    return { msgId: targetMsgId, text: textParts.join(''), ...(blocks.length ? { blocks } : {}), hasToolUse,
      ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
  }
  const text = blockOrder.map(idx => byBlock.get(idx)).join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse,
    ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
}
