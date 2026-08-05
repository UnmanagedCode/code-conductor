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
import { encodeCwd, claudeProjectsRoot } from './projects.ts';
import {
  consolidateUserContent, isSoftInterruptContent, isTaskNotificationContent, attachSkillLoad,
  type UiEvent, type WireEnvelope, type WireContentBlock, type PendingSkillLoad,
} from './parser.ts';

// A persisted jsonl line is a WireEnvelope plus the fields the CLI writes to
// disk that the live stream never carries (uuid, isSidechain, attachment,
// toolUseResult). All wire fields stay `unknown` (or loosely typed) — the
// on-disk format is owned by the CLI, so every value is narrowed at point of
// use rather than trusted. Exported so the sibling editors (sessionEdit.ts's
// rewind/fork and sessionPrune.ts's transform) share the one shape.
export interface PersistedLine extends WireEnvelope {
  uuid?: unknown;
  sessionId?: unknown;
  isSidechain?: boolean;
  attachment?: { type?: unknown; prompt?: unknown } | null;
  toolUseResult?: { agentId?: string } | null;
}

// The subset of a persisted assistant line's `message.usage` that the replay
// reads as a context-size snapshot (see loadPersistedTranscript's header note).
interface PersistedUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Predicate: does this persisted jsonl object emit at least one `user_echo`
// UI event when replayed? Mirrors the live-path emission in
// `parser.ts:_handleUser` so the rewind/fork code can count "user prompt"
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
// one). CLI-internal `<task-notification>` lines/queued commands (either
// a `type:"user"` line or an attachment with a string `prompt`) are
// excluded in both shapes — they never produced a user_echo.
export function isPureUserPromptLine(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const line = obj as PersistedLine;
  if (line.isSidechain) return false;
  if (line.type === 'user') {
    const content = line.message?.content;
    // Soft-interrupt steer never produces a user_echo bubble (it renders as a
    // system/soft_interrupted annotation instead) — don't count it, or
    // fork/rewind indices would drift past the user_echo count.
    if (isSoftInterruptContent(content)) return false;
    // Background-subagent completion ping — dropped silently, never a
    // user_echo. See parser.ts:_handleUser.
    if (isTaskNotificationContent(content)) return false;
    if (typeof content === 'string') return content.length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((b) => b && b.type === 'text' && typeof b.text === 'string');
  }
  if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
    const prompt = line.attachment.prompt;
    if (!Array.isArray(prompt)) return false;
    if (isSoftInterruptContent(prompt)) return false; // system annotation, not a user_echo
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
export function replayPersistedLine(
  obj: unknown,
  { seqHint = 0, parentToolUseId = null, allowSidechain = false, blockCursor = null, pendingSkillLoads = null }: {
    seqHint?: number;
    parentToolUseId?: string | null;
    allowSidechain?: boolean;
    blockCursor?: Map<string, number> | null;
    pendingSkillLoads?: PendingSkillLoad[] | null;
  } = {},
): UiEvent[] {
  const events: UiEvent[] = [];
  const line = obj as PersistedLine;
  const tagAndReturn = (): UiEvent[] => {
    // Mirror parser.handleObject's contract: every emitted UI event carries a
    // parentToolUseId (null when there's no enclosing sub-agent), so consumers
    // never have to distinguish undefined vs null.
    for (const ev of events) {
      if (!('parentToolUseId' in ev)) ev.parentToolUseId = parentToolUseId;
    }
    return events;
  };
  if (!obj || typeof obj !== 'object') return events;
  // Input hygiene for the CLI-owned transcript format, not backwards compat:
  // old parent jsonls contain inline isSidechain traces, but the CLI now
  // writes those to a sibling `subagents/` directory instead. Skip by
  // default — callers replaying a sub-agent file explicitly opt in via
  // allowSidechain.
  if (line.isSidechain && !allowSidechain) return events;

  if (line.type === 'user') {
    const msg = line.message ?? {};
    const content = msg.content;
    // Soft-interrupt steer — show as a system annotation, not a user bubble.
    if (isSoftInterruptContent(content)) {
      events.push({ kind: 'system', subtype: 'soft_interrupted' });
      return tagAndReturn();
    }
    // Background-subagent completion ping — drop silently, same as live
    // (parser.ts:_handleUser): it's a duplicate of the already-hidden
    // streaming system/task_notification event, and never produced a
    // user_echo live.
    if (isTaskNotificationContent(content)) return tagAndReturn();
    if (typeof content === 'string') {
      events.push({ kind: 'user_echo', text: content });
      return tagAndReturn();
    }
    if (Array.isArray(content)) {
      // Group text blocks of a single user message into one user_echo so
      // the bubble renders text and attachments together — mirrors the
      // live `parser.ts:_handleUser` consolidation. tool_result blocks
      // remain their own events.
      const userEvents = consolidateUserContent(content);
      attachSkillLoad(userEvents, line, pendingSkillLoads);
      for (const ev of userEvents) events.push(ev);
    }
    return tagAndReturn();
  }

  if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
    // Prompts received via stdin while the CLI is mid-turn get persisted
    // as this attachment shape instead of a `type:"user"` line. Replay the
    // same `user_echo` the live path emitted from `inst.prompt()` so the
    // bubble count survives a reload / resume. CLI-internal queued
    // commands (e.g. `<task-notification>...</task-notification>`) carry a
    // string `prompt` — they never produced a user_echo live, so skip.
    const prompt = line.attachment.prompt;
    if (!Array.isArray(prompt)) return tagAndReturn();
    if (isSoftInterruptContent(prompt)) {
      events.push({ kind: 'system', subtype: 'soft_interrupted' });
      return tagAndReturn();
    }
    // queued_command prompts are orchestrator-authored text blocks (no
    // tool_result), so consolidateUserContent emits just the one user_echo.
    const queuedEvents = consolidateUserContent(prompt);
    // A queued prompt is a genuine (non-injected) turn boundary — expires
    // any Skill invocation still awaiting its content injection, same as
    // the primary `type:"user"` branch above. queued_command lines carry no
    // injection marker, so passing the line itself normalizes to exactly
    // that.
    attachSkillLoad(queuedEvents, line, pendingSkillLoads);
    for (const ev of queuedEvents) events.push(ev);
    return tagAndReturn();
  }

  if (line.type === 'assistant') {
    const msg = line.message ?? {};
    const msgId = typeof msg.id === 'string' ? msg.id
      : typeof line.uuid === 'string' ? line.uuid
      : `replay-${seqHint}`;
    const blocks = Array.isArray(msg.content) ? msg.content as WireContentBlock[] : [];
    // The async-worker CLI persists one logical message as N single-block
    // assistant lines sharing message.id. The per-line array index alone
    // would give every block of a fragmented message blockIdx 0, colliding
    // same-type blocks on the UI's `${msgId}:${blockIdx}:${type}` dedup key
    // (two thinking blocks merge into one on replay). `blockCursor` — a
    // per-file Map(msgId → blocks seen so far) threaded in by the
    // load*Transcript loops — continues the index across lines so replayed
    // indices match the live stream's content_block_start indices. Callers
    // replaying a single line in isolation omit it (per-line indexing).
    const base = blockCursor?.get(msgId) ?? 0;
    if (blockCursor && blocks.length) blockCursor.set(msgId, base + blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const blockIdx = base + i;
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        events.push({ kind: 'text_delta', msgId, blockIdx, text: typeof b.text === 'string' ? b.text : '' });
        events.push({ kind: 'text_end', msgId, blockIdx });
      } else if (b.type === 'thinking') {
        const text = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
        events.push({ kind: 'thinking_start', msgId, blockIdx });
        if (text) events.push({ kind: 'thinking_delta', msgId, blockIdx, text });
        else events.push({ kind: 'thinking_redacted', msgId, blockIdx });
        events.push({ kind: 'thinking_end', msgId, blockIdx });
      } else if (b.type === 'tool_use') {
        const toolUseId = typeof b.id === 'string' ? b.id : null;
        const name = typeof b.name === 'string' ? b.name : null;
        events.push({ kind: 'tool_use_start', msgId, blockIdx, toolUseId, name });
        events.push({ kind: 'tool_use', msgId, blockIdx, toolUseId, name, input: b.input ?? {} });
        // Mirror the parser's structured event emission for the live
        // path — a replayed AskUserQuestion / ExitPlanMode should
        // render as a question / plan card, not just a collapsed
        // generic tool block.
        if (name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
          events.push({
            kind: 'user_question',
            toolUseId,
            questions: b.input.questions,
          });
        }
        if (name === 'ExitPlanMode') {
          events.push({
            kind: 'plan_request',
            toolUseId,
            plan: typeof b.input?.plan === 'string' ? b.input.plan : null,
            planPath: null,
          });
        }
        // Track Skill invocations — mirrors parser.ts so the isSynthetic
        // content-injection user line that follows can be identified and
        // titled with the actual invoked skill id (see attachSkillLoad).
        if (name === 'Skill' && pendingSkillLoads) {
          const skill = typeof b.input?.skill === 'string' ? b.input.skill : null;
          pendingSkillLoads.push({ toolUseId, skill });
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
export async function loadSubAgentTranscript(options: {
  cwd: string;
  sessionId: string;
  agentId: string;
  parentToolUseId: string;
  seqHint?: number;
}): Promise<UiEvent[]> {
  const { cwd, sessionId, agentId, parentToolUseId, seqHint = 0 } = options;
  if (!cwd || !sessionId || !agentId || !parentToolUseId) return [];
  const file = path.join(
    claudeProjectsRoot(), encodeCwd(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`,
  );
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return []; throw e; }
  const out: UiEvent[] = [];
  let seq = seqHint;
  const blockCursor = new Map<string, number>();
  const pendingSkillLoads: PendingSkillLoad[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const lineEvents = replayPersistedLine(obj, {
      seqHint: seq, parentToolUseId, allowSidechain: true, blockCursor, pendingSkillLoads,
    });
    for (const ev of lineEvents) out.push(ev);
    seq += lineEvents.length;
    // Recurse: a sub-agent may itself invoke another Agent. Its user
    // tool_result line carries toolUseResult.agentId for the nested run.
    const line = obj as PersistedLine;
    if (line.type === 'user' && line.toolUseResult?.agentId) {
      const innerContent = line.message?.content;
      const innerToolUseId = Array.isArray(innerContent)
        ? innerContent.find(b => b?.type === 'tool_result')?.tool_use_id
        : undefined;
      if (innerToolUseId) {
        const innerEvents = await loadSubAgentTranscript({
          cwd, sessionId,
          agentId: line.toolUseResult.agentId,
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
// can track the latest leaf for `claude --resume`'s picker) and
// `lastAssistantUsage` (the current context-size reading — see below).
// Returns `null` if the file is missing — caller treats that as "no history".
//
// `lastAssistantUsage` is `{ msgId, usage } | null`: the newest assistant
// line's `message.usage`, which the caller replays as a synthetic
// `message_start` so a resumed session's ctx chip is populated before its
// first live turn (replay emits no `message_start` of its own). Trustworthy
// as a context-size SNAPSHOT, not a sum: each line's
// input+cache_read+cache_creation equals the previous call's total (the
// per-call prompt ladder), and the per-turn sum the `ctx 743%` bug came from
// (`turn_end.usage`, see public/usage.js) is a stream-only `result` frame the
// CLI never persists — there is no `type:"result"` line in a session jsonl,
// so that value is structurally unreachable from here.
export async function loadPersistedTranscript(options: {
  cwd: string;
  sessionId: string;
  seqHint?: number;
}): Promise<{
  lines: Array<{ events: UiEvent[] }>;
  replayedCount: number;
  lastLeafUuid: string | null;
  lastAssistantUsage: { msgId: string | null; usage: PersistedUsage } | null;
} | null> {
  const { cwd, sessionId, seqHint = 0 } = options;
  if (!cwd || !sessionId) return null;
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }

  const lines: Array<{ events: UiEvent[] }> = [];
  let lastLeafUuid: string | null = null;
  let lastAssistantUsage: { msgId: string | null; usage: PersistedUsage } | null = null;
  let replayedCount = 0;
  let seq = seqHint;
  const blockCursor = new Map<string, number>();
  const pendingSkillLoads: PendingSkillLoad[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const line = obj as PersistedLine;

    // Latch this session's context-size reading (see the header). Three
    // independent guards, each load-bearing:
    //   - `model: '<synthetic>'` — the CLI's API-error / interrupt placeholder
    //     is not real model output, so its usage never counts WHATEVER it
    //     holds. Read-time tolerance for a format we don't own (the CLI's
    //     jsonl), and the same predicate readLastSessionModel applies to it.
    //   - `isSidechain` — a sub-agent's prompt size is a DIFFERENT context
    //     window, not this session's. (Sub-agent files go through
    //     loadSubAgentTranscript, which deliberately has no equivalent latch.)
    //   - the zero-prompt floor — every synthetic line observed in practice
    //     carries an all-zero usage block, and such a line is frequently the
    //     LAST assistant line of an interrupted session; seeding 0 would render
    //     `ctx 0 · 0%`, strictly worse than `ctx —`.
    // The async-worker CLI persists one logical message as N single-block
    // lines sharing message.id (see replayPersistedLine) — every copy carries
    // the IDENTICAL usage, so plain last-wins needs no dedup.
    if (line.type === 'assistant' && !line.isSidechain
        && line.message?.usage != null && line.message.model !== '<synthetic>') {
      const u = line.message.usage as PersistedUsage;
      const prompt = (u.input_tokens ?? 0)
                   + (u.cache_read_input_tokens ?? 0)
                   + (u.cache_creation_input_tokens ?? 0);
      if (prompt > 0) lastAssistantUsage = {
        msgId: typeof line.message.id === 'string' ? line.message.id : null,
        usage: u,
      };
    }

    // When the line is the parent's tool_result for an Agent invocation, the
    // CLI persists the sub-agent's own assistant/user transcript in a sibling
    // `subagents/agent-<agentId>.jsonl` rather than inlining it here. Live
    // runs receive those events over stdout tagged with parent_tool_use_id;
    // replay has to load + tag them explicitly so the conversation view can
    // nest them under the Agent tool block.
    const events: UiEvent[] = [];
    if (line.type === 'user' && line.toolUseResult?.agentId) {
      const tuid = Array.isArray(line.message?.content)
        ? line.message.content.find(b => b?.type === 'tool_result')?.tool_use_id
        : null;
      if (tuid) {
        const subEvents = await loadSubAgentTranscript({
          cwd, sessionId,
          agentId: line.toolUseResult.agentId,
          parentToolUseId: tuid,
          seqHint: seq,
        });
        for (const ev of subEvents) events.push(ev);
        seq += subEvents.length;
      }
    }
    const ownEvents = replayPersistedLine(obj, { seqHint: seq, blockCursor, pendingSkillLoads });
    for (const ev of ownEvents) events.push(ev);

    if (events.length > 0) {
      replayedCount++;
      seq += ownEvents.length;
    }
    if (typeof line.uuid === 'string') lastLeafUuid = line.uuid;
    lines.push({ events });
  }
  return { lines, replayedCount, lastLeafUuid, lastAssistantUsage };
}

// Scan the persisted jsonl and return the bare model id from the
// most-recent `type:"assistant"` line, or null if none found / file
// missing.
//
// The CLI records this id LOSSILY (any `[1m]` build tag and `:tag` variant
// dropped), so it is a last-resort recovery source only: on a substitution
// backend the session sidecar's exact id wins, because that string is the
// registry key. For a `claude` session the bare id is enough — canonicalizeModel
// re-applies the catalog launch tag, and capacity comes from the catalog rather
// than from anything persisted here.
export async function readLastSessionModel(options: { cwd: string; sessionId: string }): Promise<string | null> {
  const { cwd, sessionId } = options;
  if (!cwd || !sessionId) return null;
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
  let lastModel: string | null = null;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const line = obj as PersistedLine;
    if (line.type === 'assistant' && typeof line.message?.model === 'string'
        && line.message.model !== '<synthetic>') {
      lastModel = line.message.model;
    }
  }
  return lastModel;
}

// True iff the session jsonl exists AND contains at least one real
// conversation record (user/assistant) — i.e. `claude --resume <sid>` would
// find a conversation rather than exit 1 with "No conversation found".
// Marker-only stubs (last-prompt/permission-mode/ai-title) do NOT count: a
// crash-during-resume can leave a jsonl holding only our best-effort markers,
// and the CLI treats that as a non-existent session. Used as a resume
// pre-flight so a mistyped/bogus resume id is refused before we spawn a
// subprocess that would only crash-loop.
export async function hasResumableConversation(options: { cwd: string; sessionId: string }): Promise<boolean> {
  const { cwd, sessionId } = options;
  if (!cwd || !sessionId) return false;
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return false; throw e; }
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const line = obj as PersistedLine;
    if (line.type === 'user' || line.type === 'assistant') return true;
  }
  return false;
}

// Append metadata markers to the session jsonl so `claude --resume`'s
// shell picker can discover and label the session. Best-effort — caller
// swallows errors. permissionMode is the CLI-level value (the
// orchestrator's 'ask' is collapsed to 'bypassPermissions' before
// reaching this function; see cliPermissionMode in instances.ts).
export async function writeSessionMetadata(options: {
  cwd: string;
  sessionId: string;
  leafUuid: string | null;
  permissionMode: string;
}): Promise<void> {
  const { cwd, sessionId, leafUuid, permissionMode } = options;
  if (!cwd || !sessionId || !leafUuid) return;
  const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines =
    JSON.stringify({ type: 'last-prompt', leafUuid, sessionId }) + '\n' +
    JSON.stringify({ type: 'permission-mode', permissionMode, sessionId }) + '\n';
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(file, lines);
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
