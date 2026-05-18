// Persisted-session helpers: pure replay of `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`
// into the orchestrator's UI-event shape, and best-effort append of
// the two metadata markers (`last-prompt`, `permission-mode`) that
// claude --resume's interactive picker uses.
//
// These functions don't reach into an Instance — the caller passes
// what it needs, the helpers return pure data. That keeps the
// session-storage concern testable in isolation and keeps Instance
// focused on subprocess lifecycle.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeCwd, claudeProjectsRoot } from './projects.js';

// Convert one persisted jsonl object into the UI events that would
// have been emitted live. Returns an array (possibly empty); the
// caller pushes them through its normal emit path so the snapshot
// ring and WS broadcast logic stay centralized.
//
// `seqHint` is used to manufacture a stable msgId for replay blocks
// whose original message had no `id` and no `uuid` (rare but
// possible) — passing the ring's current length keeps replays
// reproducible across reruns.
export function replayPersistedLine(obj, { seqHint = 0 } = {}) {
  const events = [];
  if (!obj || typeof obj !== 'object') return events;
  if (obj.isSidechain) return events; // skip sidechain/subagent traces — they're noisy

  if (obj.type === 'user') {
    const msg = obj.message ?? {};
    const content = msg.content;
    if (typeof content === 'string') {
      events.push({ kind: 'user_echo', text: content });
      return events;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            toolUseId: block.tool_use_id ?? null,
            content: block.content ?? '',
            isError: !!block.is_error,
          });
        } else if (block.type === 'text') {
          events.push({ kind: 'user_echo', text: block.text ?? '' });
        }
      }
    }
    return events;
  }

  if (obj.type === 'assistant') {
    const msg = obj.message ?? {};
    const msgId = msg.id ?? obj.uuid ?? `replay-${seqHint}`;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        events.push({ kind: 'text_delta', msgId, blockIdx: i, text: b.text ?? '' });
        events.push({ kind: 'text_end', msgId, blockIdx: i });
      } else if (b.type === 'thinking') {
        const text = b.thinking ?? b.text ?? '';
        events.push({ kind: 'thinking_start', msgId, blockIdx: i });
        if (text) events.push({ kind: 'thinking_delta', msgId, blockIdx: i, text });
        else events.push({ kind: 'thinking_redacted', msgId, blockIdx: i });
        events.push({ kind: 'thinking_end', msgId, blockIdx: i });
      } else if (b.type === 'tool_use') {
        events.push({ kind: 'tool_use_start', msgId, blockIdx: i, toolUseId: b.id ?? null, name: b.name ?? null });
        events.push({ kind: 'tool_use', msgId, blockIdx: i, toolUseId: b.id ?? null, name: b.name ?? null, input: b.input ?? {} });
        // Mirror the parser's structured event emission for the live
        // path — a replayed AskUserQuestion / ExitPlanMode should
        // render as a question / plan card, not just a collapsed
        // generic tool block.
        if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
          events.push({
            kind: 'user_question',
            toolUseId: b.id ?? null,
            questions: b.input.questions,
          });
        }
        if (b.name === 'ExitPlanMode') {
          events.push({
            kind: 'plan_request',
            toolUseId: b.id ?? null,
            plan: typeof b.input?.plan === 'string' ? b.input.plan : null,
            planPath: null,
          });
        }
      }
    }
    return events;
  }

  return events;
}

// Reads the persisted jsonl at the conventional path. Yields each line's
// already-replayed UI events plus the line's own `uuid` (so the caller
// can track the latest leaf for `claude --resume`'s picker). Returns
// `null` if the file is missing — caller treats that as "no history".
export async function loadPersistedTranscript({ cwd, sessionId, seqHint = 0 }) {
  if (!cwd || !sessionId) return null;
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }

  const lines = [];
  let lastLeafUuid = null;
  let replayedCount = 0;
  let seq = seqHint;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const events = replayPersistedLine(obj, { seqHint: seq });
    if (events.length > 0) {
      replayedCount++;
      seq += events.length;
    }
    if (typeof obj.uuid === 'string') lastLeafUuid = obj.uuid;
    lines.push({ events });
  }
  return { lines, replayedCount, lastLeafUuid };
}

// Append the two metadata markers claude --resume's interactive
// picker uses to discover a session. Best-effort — caller swallows
// errors. permissionMode is the CLI-level value (the orchestrator's
// 'ask' is collapsed to 'bypassPermissions' before reaching this
// function; see cliPermissionMode in instances.js).
export async function writeSessionMetadata({ cwd, sessionId, leafUuid, permissionMode }) {
  if (!cwd || !sessionId || !leafUuid) return;
  const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines =
    JSON.stringify({ type: 'last-prompt', leafUuid, sessionId }) + '\n' +
    JSON.stringify({ type: 'permission-mode', permissionMode, sessionId }) + '\n';
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(file, lines);
}
