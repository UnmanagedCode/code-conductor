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
import { extractAttachedMarkers } from './parser.js';

// Predicate: does this persisted jsonl object emit at least one `user_echo`
// UI event when replayed? Mirrors the live-path emission in
// `parser.js:_handleUser` so the rewind/fork code can count "user prompt"
// lines in the jsonl and have the count match the Nth user_echo in the
// orchestrator's event stream. tool_result-only `type:"user"` lines are
// excluded; sidechain lines are excluded too (consistent with replay).
//
// `type:"attachment"` queued_command lines also count when their `prompt`
// is the array shape `inst.prompt()` writes to stdin — the CLI persists
// prompts received mid-turn as this attachment shape instead of a
// `type:"user"` line, so without recognising them here the fork/rewind
// counter would drift below the live `user_echo` count (every queued
// auto-approve / user-typed-during-busy prompt would shift indices by
// one). CLI-internal `<task-notification>` queued commands carry a
// string `prompt` and are excluded — they never produced a user_echo.
export function isPureUserPromptLine(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.isSidechain) return false;
  if (obj.type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') return content.length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((b) => b && b.type === 'text' && typeof b.text === 'string');
  }
  if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command') {
    const prompt = obj.attachment.prompt;
    if (!Array.isArray(prompt)) return false;
    return prompt.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
  }
  return false;
}

// Convert one persisted jsonl object into the UI events that would
// have been emitted live. Returns an array (possibly empty); the
// caller pushes them through its normal emit path so the snapshot
// ring and WS broadcast logic stay centralized.
//
// `seqHint` is used to manufacture a stable msgId for replay blocks
// whose original message had no `id` and no `uuid` (rare but
// possible) — passing the ring's current length keeps replays
// reproducible across reruns.
export function replayPersistedLine(obj, { seqHint = 0, parentToolUseId = null, allowSidechain = false } = {}) {
  const events = [];
  const tagAndReturn = () => {
    // Mirror parser.handleObject's contract: every emitted UI event carries a
    // parentToolUseId (null when there's no enclosing sub-agent), so consumers
    // never have to distinguish undefined vs null.
    for (const ev of events) {
      if (!('parentToolUseId' in ev)) ev.parentToolUseId = parentToolUseId;
    }
    return events;
  };
  if (!obj || typeof obj !== 'object') return events;
  // Parent jsonls used to occasionally include inline isSidechain traces; the
  // CLI now keeps them in a sibling `subagents/` directory instead. Default
  // is to skip — callers replaying a sub-agent file explicitly opt in.
  if (obj.isSidechain && !allowSidechain) return events;

  if (obj.type === 'user') {
    const msg = obj.message ?? {};
    const content = msg.content;
    if (typeof content === 'string') {
      events.push({ kind: 'user_echo', text: content });
      return tagAndReturn();
    }
    if (Array.isArray(content)) {
      // Group text blocks of a single user message into one user_echo so
      // the bubble renders text and attachments together — mirrors the
      // live `parser.js:_handleUser` consolidation. tool_result blocks
      // remain their own events.
      const echoTexts = [];
      const echoAttachments = [];
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
          if (typeof block.text !== 'string') continue;
          const { text: leftover, attachments } = extractAttachedMarkers(block.text);
          if (leftover.length) echoTexts.push(leftover);
          for (const a of attachments) echoAttachments.push(a);
        }
      }
      if (echoTexts.length || echoAttachments.length) {
        events.push({
          kind: 'user_echo',
          text: echoTexts.join('\n'),
          attachments: echoAttachments,
        });
      }
    }
    return tagAndReturn();
  }

  if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command') {
    // Prompts received via stdin while the CLI is mid-turn get persisted
    // as this attachment shape instead of a `type:"user"` line. Replay the
    // same `user_echo` the live path emitted from `inst.prompt()` so the
    // bubble count survives a reload / resume. CLI-internal queued
    // commands (e.g. `<task-notification>...</task-notification>`) carry a
    // string `prompt` — they never produced a user_echo live, so skip.
    const prompt = obj.attachment.prompt;
    if (!Array.isArray(prompt)) return tagAndReturn();
    const echoTexts = [];
    const echoAttachments = [];
    for (const block of prompt) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const { text: leftover, attachments } = extractAttachedMarkers(block.text);
      if (leftover.length) echoTexts.push(leftover);
      for (const a of attachments) echoAttachments.push(a);
    }
    if (echoTexts.length || echoAttachments.length) {
      events.push({
        kind: 'user_echo',
        text: echoTexts.join('\n'),
        attachments: echoAttachments,
      });
    }
    return tagAndReturn();
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
    return tagAndReturn();
  }

  return tagAndReturn();
}

// Read a single sub-agent transcript jsonl at
// `<projects-root>/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl`
// and return the UI events that should be injected under the matching outer
// Agent tool block. Live runs receive these events over stdout tagged with
// parent_tool_use_id; persistence drops them in this sibling file instead, so
// replay has to load them explicitly.
export async function loadSubAgentTranscript({ cwd, sessionId, agentId, parentToolUseId, seqHint = 0 }) {
  if (!cwd || !sessionId || !agentId || !parentToolUseId) return [];
  const file = path.join(
    claudeProjectsRoot(), encodeCwd(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`,
  );
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  let seq = seqHint;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const lineEvents = replayPersistedLine(obj, {
      seqHint: seq, parentToolUseId, allowSidechain: true,
    });
    for (const ev of lineEvents) out.push(ev);
    seq += lineEvents.length;
    // Recurse: a sub-agent may itself invoke another Agent. Its user
    // tool_result line carries toolUseResult.agentId for the nested run.
    if (obj.type === 'user' && obj.toolUseResult?.agentId) {
      const innerToolUseId = obj.message?.content?.find?.(b => b?.type === 'tool_result')?.tool_use_id;
      if (innerToolUseId) {
        const innerEvents = await loadSubAgentTranscript({
          cwd, sessionId,
          agentId: obj.toolUseResult.agentId,
          parentToolUseId: innerToolUseId,
          seqHint: seq,
        });
        for (const ev of innerEvents) out.push(ev);
        seq += innerEvents.length;
      }
    }
  }
  return out;
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

    // When the line is the parent's tool_result for an Agent invocation, the
    // CLI persists the sub-agent's own assistant/user transcript in a sibling
    // `subagents/agent-<agentId>.jsonl` rather than inlining it here. Live
    // runs receive those events over stdout tagged with parent_tool_use_id;
    // replay has to load + tag them explicitly so the conversation view can
    // nest them under the Agent tool block.
    const events = [];
    if (obj.type === 'user' && obj.toolUseResult?.agentId) {
      const tuid = Array.isArray(obj.message?.content)
        ? obj.message.content.find(b => b?.type === 'tool_result')?.tool_use_id
        : null;
      if (tuid) {
        const subEvents = await loadSubAgentTranscript({
          cwd, sessionId,
          agentId: obj.toolUseResult.agentId,
          parentToolUseId: tuid,
          seqHint: seq,
        });
        for (const ev of subEvents) events.push(ev);
        seq += subEvents.length;
      }
    }
    const ownEvents = replayPersistedLine(obj, { seqHint: seq });
    for (const ev of ownEvents) events.push(ev);

    if (events.length > 0) {
      replayedCount++;
      seq += ownEvents.length;
    }
    if (typeof obj.uuid === 'string') lastLeafUuid = obj.uuid;
    lines.push({ events });
  }
  return { lines, replayedCount, lastLeafUuid };
}

// Scan the persisted jsonl and return the bare model id from the
// most-recent `type:"assistant"` line, or null if none found / file
// missing. The caller (instances.js create) re-derives the context window
// from the family via canonicalizeModel() — the window is never persisted,
// so the bare id recorded by the CLI is all we need.
export async function readLastSessionModel({ cwd, sessionId }) {
  if (!cwd || !sessionId) return null;
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let lastModel = null;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && obj.type === 'assistant' && typeof obj.message?.model === 'string') {
      lastModel = obj.message.model;
    }
  }
  return lastModel;
}

// Append metadata markers to the session jsonl so `claude --resume`'s
// shell picker can discover and label the session. Best-effort — caller
// swallows errors. permissionMode is the CLI-level value (the
// orchestrator's 'ask' is collapsed to 'bypassPermissions' before
// reaching this function; see cliPermissionMode in instances.js).
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
