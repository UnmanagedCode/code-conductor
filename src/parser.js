// Normalize Claude Code stream-json events into compact UI events.
//
// Each call to handleLine(line) parses one JSON object emitted on stdout and
// returns an array of UI events (possibly empty). The parser keeps minimal
// per-instance state so streaming content blocks can be merged across many
// stream_event chunks before the matching content_block_stop arrives.
//
// Emitted UI event kinds:
//   message_start           { msgId, usage }                // live context-size signal
//   text_delta              { msgId, blockIdx, text }
//   text_end                { msgId, blockIdx }
//   thinking_delta          { msgId, blockIdx, text }
//   thinking_end            { msgId, blockIdx }
//   tool_use_input_delta    { msgId, blockIdx, toolUseId, partialJson }
//   tool_use                { msgId, blockIdx, toolUseId, name, input }
//   tool_result             { toolUseId, content, isError }
//   user_echo               { text, attachments?: [{kind:'image'|'file', ...}], skillLoad?: {skill} }
//   system                  { subtype, data }
//   hook                    { event, data }
//   assistant_message       { msgId, message }              // final reconciled message
//   turn_end                { usage, durationMs, durationApiMs, cost, costDelta, isError, stopReason, subtype }
//   control_response        { requestId, ok, response?, error? }
//   raw                     { line }                        // fallback for unrecognized

import { randomUUID } from 'node:crypto';

export class Parser {
  constructor() {
    this.currentMsgId = null;
    this.blocks = new Map(); // blockIdx -> { type, accumText, accumJson, toolUseId, name }
    this._lastCost = 0; // tracks cumulative cost to compute per-turn delta
    this._pendingSkillLoads = []; // FIFO of {toolUseId, skill} awaiting their content injection
  }

  reset() {
    this.currentMsgId = null;
    this.blocks.clear();
    this._lastCost = 0;
    this._pendingSkillLoads = [];
  }

  // Signal a genuine turn boundary (a real prompt or interrupt emitted
  // directly by Instance, bypassing _handleUser/attachSkillLoad) so any
  // Skill invocation still awaiting its content injection is dropped rather
  // than surviving to mislabel a later, unrelated isSynthetic message.
  expirePendingSkillLoads() {
    expireSkillLoads(this._pendingSkillLoads);
  }

  handleLine(line) {
    line = typeof line === 'string' ? line.trim() : '';
    if (!line) return [];
    let obj;
    try { obj = JSON.parse(line); }
    catch { return [{ kind: 'raw', line }]; }
    return this.handleObject(obj);
  }

  handleObject(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const events = this._dispatch(obj);
    // Tag every emitted UI event with the parent_tool_use_id (or null) from
    // the wrapping stream-json envelope. The conversation view uses this to
    // route sub-agent events into a nested area under the matching outer
    // Task tool_use block.
    const parentToolUseId = obj.parent_tool_use_id ?? null;
    for (const ev of events) {
      if (!('parentToolUseId' in ev)) ev.parentToolUseId = parentToolUseId;
    }
    return events;
  }

  _dispatch(obj) {
    switch (obj.type) {
      case 'system':       return this._handleSystem(obj);
      case 'stream_event': return this._handleStreamEvent(obj);
      case 'assistant':    return this._handleAssistant(obj);
      case 'user':         return this._handleUser(obj);
      case 'result':       return this._handleResult(obj);
      case 'hook_event':   return [{ kind: 'hook', event: obj.event ?? obj.subtype ?? 'unknown', data: obj }];
      case 'control_response': return this._handleControlResponse(obj);
      case 'control_request':  return this._handleControlRequest(obj);
      case 'keep_alive':       return [];
      default:
        return [{ kind: 'system', subtype: obj.type ?? 'unknown', data: obj }];
    }
  }

  _handleSystem(obj) {
    return [{ kind: 'system', subtype: obj.subtype ?? 'unknown', data: obj }];
  }

  _handleControlRequest(obj) {
    return [{ kind: 'system', subtype: 'control_request', data: obj }];
  }

  _handleControlResponse(obj) {
    const resp = obj.response ?? {};
    const ok = resp.subtype === 'success';
    return [{
      kind: 'control_response',
      requestId: resp.request_id ?? obj.request_id ?? null,
      ok,
      response: ok ? (resp.response ?? null) : null,
      error: ok ? null : (resp.error ?? null),
    }];
  }

  _handleStreamEvent(obj) {
    const ev = obj.event ?? {};
    switch (ev.type) {
      case 'message_start': {
        // Single-writer assumption: only the top-level agent's partials ever
        // arrive as stream_event frames — the CLI hardcodes
        // parent_tool_use_id:null on every stream_event it emits and forwards
        // sub-agent turns as finals-only assistant/user envelopes (their
        // partial forwarding, forwardSubagentText, is SDK-only with no CLI
        // flag). So resetting the shared currentMsgId/blocks here can never
        // clobber an interleaved sub-agent message.
        this.currentMsgId = ev.message?.id ?? `msg_${randomUUID()}`;
        this.blocks.clear();
        // Surface the usage block. Each agent-loop step within a turn
        // fires its own message_start with cumulative input-side counts
        // (input_tokens + cache_read + cache_creation), so this is the
        // signal that lets the context-usage chip update mid-turn rather
        // than only when the final `result` lands. Skip emission when
        // there's no usage payload (defensive — keeps DOM tests stable
        // for fixtures that omit it).
        const usage = ev.message?.usage ?? null;
        if (!usage) return [];
        return [{ kind: 'message_start', msgId: this.currentMsgId, usage, model: ev.message?.model ?? null }];
      }
      case 'content_block_start': {
        const idx = ev.index ?? 0;
        const cb = ev.content_block ?? {};
        const block = {
          type: cb.type,
          accumText: '',
          accumJson: '',
          gotThinkingDelta: false,
          toolUseId: cb.id ?? null,
          name: cb.name ?? null,
        };
        this.blocks.set(idx, block);
        if (cb.type === 'tool_use') {
          return [{
            kind: 'tool_use_start',
            msgId: this.currentMsgId,
            blockIdx: idx,
            toolUseId: block.toolUseId,
            name: block.name,
          }];
        }
        if (cb.type === 'thinking') {
          return [{ kind: 'thinking_start', msgId: this.currentMsgId, blockIdx: idx }];
        }
        return [];
      }
      case 'content_block_delta': {
        const idx = ev.index ?? 0;
        const block = this.blocks.get(idx);
        const delta = ev.delta ?? {};
        if (!block) return [];
        switch (delta.type) {
          case 'text_delta': {
            const text = delta.text ?? '';
            block.accumText += text;
            return [{ kind: 'text_delta', msgId: this.currentMsgId, blockIdx: idx, text }];
          }
          case 'thinking_delta': {
            const text = delta.thinking ?? delta.text ?? '';
            // Opus 4.8 streams empty thinking_delta ("") for redacted thinking
            // (where 4.7 sent only a signature_delta). Ignore empties so
            // gotThinkingDelta stays false and content_block_stop takes the
            // thinking_redacted path — otherwise the block finalizes empty and
            // renders as "thinking (0 chars)" instead of "thinking (redacted)".
            if (!text) return [];
            block.accumText += text;
            block.gotThinkingDelta = true;
            return [{ kind: 'thinking_delta', msgId: this.currentMsgId, blockIdx: idx, text }];
          }
          case 'input_json_delta': {
            const part = delta.partial_json ?? '';
            block.accumJson += part;
            return [{
              kind: 'tool_use_input_delta',
              msgId: this.currentMsgId,
              blockIdx: idx,
              toolUseId: block.toolUseId,
              partialJson: part,
            }];
          }
          case 'signature_delta':
            return [];
          default:
            return [];
        }
      }
      case 'content_block_stop': {
        const idx = ev.index ?? 0;
        const block = this.blocks.get(idx);
        if (!block) return [];
        if (block.type === 'text') {
          return [{ kind: 'text_end', msgId: this.currentMsgId, blockIdx: idx }];
        }
        if (block.type === 'thinking') {
          if (!block.gotThinkingDelta) {
            // No thinking_delta arrived — the model (e.g. Opus 4.7/4.8) thought
            // but the content is encrypted/redacted; only signature_delta
            // streamed. Surface a placeholder so the UI can show something.
            return [
              { kind: 'thinking_redacted', msgId: this.currentMsgId, blockIdx: idx },
              { kind: 'thinking_end', msgId: this.currentMsgId, blockIdx: idx },
            ];
          }
          return [{ kind: 'thinking_end', msgId: this.currentMsgId, blockIdx: idx }];
        }
        if (block.type === 'tool_use') {
          let input = {};
          if (block.accumJson) {
            try { input = JSON.parse(block.accumJson); }
            catch { input = { _raw: block.accumJson }; }
          }
          const out = [{
            kind: 'tool_use',
            msgId: this.currentMsgId,
            blockIdx: idx,
            toolUseId: block.toolUseId,
            name: block.name,
            input,
            startedAt: Date.now(),
          }];
          // AskUserQuestion gets a structured UI event so the conversation
          // view can render the questions as buttons. The CLI in stream-json
          // mode immediately errors out the actual tool execution, so the
          // user_question event is what makes this tool usable here.
          if (block.name === 'AskUserQuestion' && Array.isArray(input?.questions)) {
            out.push({
              kind: 'user_question',
              toolUseId: block.toolUseId,
              questions: input.questions,
            });
          }
          // ExitPlanMode is similar: the CLI auto-errors it in stream-json
          // ("Exit plan mode?"). We surface a plan_request UI event so the
          // user can approve / reject the plan inline. The plan text may be
          // in `input.plan` directly or omitted when the model wrote it to
          // a file first — Instance enriches the event with the file path
          // and content in the latter case.
          if (block.name === 'ExitPlanMode') {
            out.push({
              kind: 'plan_request',
              toolUseId: block.toolUseId,
              plan: typeof input?.plan === 'string' ? input.plan : null,
              planPath: null,
            });
          }
          // Track Skill invocations so the isSynthetic content-injection user
          // message that follows can be identified and titled — see
          // _handleUser for why isSynthetic alone isn't a reliable signal.
          if (block.name === 'Skill') {
            this._pendingSkillLoads.push({ toolUseId: block.toolUseId, skill: input?.skill ?? null });
          }
          return out;
        }
        return [];
      }
      case 'message_delta':
      case 'message_stop':
        return [];
      default:
        return [];
    }
  }

  _handleAssistant(obj) {
    const msg = obj.message ?? {};
    const events = [];
    // Slash commands (registered or not) are handled locally by the CLI and
    // come back as a single `assistant` envelope with `model:"<synthetic>"`
    // and no preceding stream_event frames. The normal delta-driven render
    // path never fires, so without unpacking the text blocks here the UI
    // sees nothing between the user prompt and the turn footer. Emit
    // synthetic text_delta + text_end events so the existing pipeline
    // renders an assistant bubble.
    if (msg.model === '<synthetic>' && Array.isArray(msg.content)) {
      const msgId = msg.id ?? `synthetic_${randomUUID()}`;
      let blockIdx = 0;
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length) {
          events.push({ kind: 'text_delta', msgId, blockIdx, text: block.text });
          events.push({ kind: 'text_end', msgId, blockIdx });
          blockIdx += 1;
        }
      }
    }
    events.push({
      kind: 'assistant_message',
      msgId: msg.id ?? this.currentMsgId,
      message: msg,
    });
    return events;
  }

  _handleUser(obj) {
    const msg = obj.message ?? {};
    const content = msg.content;
    // If the CLI echoes the soft-interrupt steer back on stdout, surface it
    // as a system annotation so the user can see a stop was requested.
    if (isSoftInterruptContent(content)) return [{ kind: 'system', subtype: 'soft_interrupted' }];
    // Background-subagent completion ping the CLI re-injects into a
    // worker's own conversation as though it were a user turn. Drop
    // silently — the streaming `system/task_notification` event already
    // carries this (hidden from the feed by default), so this would be a
    // duplicate, and it never produced a user_echo live.
    if (isTaskNotificationContent(content)) return [];
    if (typeof content === 'string') {
      return [{ kind: 'user_echo', text: content }];
    }
    if (!Array.isArray(content)) return [];
    const events = consolidateUserContent(content);
    return attachSkillLoad(events, obj.isSynthetic === true, this._pendingSkillLoads);
  }

  _handleResult(obj) {
    // total_cost_usd is the cumulative session total, not a per-turn cost.
    // Compute the delta so callers can display / accumulate the actual turn cost.
    const cost = obj.total_cost_usd ?? null;
    const costDelta = cost != null ? cost - this._lastCost : null;
    if (cost != null) this._lastCost = cost;
    return [{
      kind: 'turn_end',
      subtype: obj.subtype ?? 'success',
      stopReason: obj.stop_reason ?? null,
      durationMs: obj.duration_ms ?? null,        // turn walltime (incl. tool exec)
      durationApiMs: obj.duration_api_ms ?? null, // pure inference/API time
      cost,      // raw cumulative session total (kept for reference)
      costDelta, // actual cost of this turn
      usage: obj.usage ?? null,
      isError: !!obj.is_error,
    }];
  }
}

// Detect "Attached file: `<path>`" marker lines in a text block (the
// shape we write in instances.js prompt()) and split them out as
// attachment entries. Path must point inside the orchestrator's central
// store (`.../<ORCH_STORE_DIRNAME>/.../attachments/<file>`) to be
// recognized — anchors the match so unrelated prose mentioning
// "Attached file:" isn't accidentally promoted.
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const ATT_LINE_RE = /^Attached file:\s*`([^`]*?\/\.code-conductor\/[^`]+?\/attachments\/[^`]+)`\s*$/;

// Sentinel on the steering message a SOFT interrupt injects mid-turn
// (Instance.interrupt() without force). The CLI persists the injected prompt
// to the session jsonl — as a `type:"user"` line live, or a
// `type:"attachment"` queued_command line when received mid-turn — so this
// marker lets the live parser, the transcript replay, and the rewind/fork
// prompt-counter all recognise it. It renders as a `system/soft_interrupted`
// annotation rather than a user bubble, and never shifts the user-message index.
export const SOFT_INTERRUPT_MARKER = '[[cc:soft-interrupt]]';

// True when a user-message `content` (string or block array) or a
// queued_command `prompt` array is the hidden soft-interrupt steer —
// detected by the marker appearing anywhere in a text block (marker is
// now appended at the end of the text, not the beginning).
export function isSoftInterruptContent(content) {
  if (typeof content === 'string') return content.includes(SOFT_INTERRUPT_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && b.type === 'text' && typeof b.text === 'string'
           && b.text.includes(SOFT_INTERRUPT_MARKER),
  );
}

// True when a user-message `content` (string or block array) is the CLI's
// own "background subagent finished" ping, re-injected into a worker's own
// conversation as though it were a user turn. Detected by tag shape, not a
// marker, since the CLI — not this codebase — produces the string, so
// there's nothing to append a marker to.
export function isTaskNotificationContent(content) {
  const isTag = (text) => typeof text === 'string' && text.trimStart().startsWith('<task-notification>');
  if (typeof content === 'string') return isTag(content);
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === 'text' && isTag(b.text));
}

// True when a single text block is the mid-turn annotation prepended by
// Instance.prompt() when a message arrives while a worker is in-flight.
// Matched by shape (system-reminder wrapper + 'mid-turn' token), not by
// exact string, so minor wording tweaks don't silently break filtering.
export function isMidTurnNoteContent(text) {
  return typeof text === 'string'
    && text.startsWith('<system-reminder>')
    && text.includes('mid-turn')
    && text.trimEnd().endsWith('</system-reminder>');
}

export function extractAttachedMarkers(text) {
  const lines = text.split('\n');
  const keptLines = [];
  const attachments = [];
  for (const line of lines) {
    const m = line.match(ATT_LINE_RE);
    if (!m) { keptLines.push(line); continue; }
    const attPath = m[1];
    const filename = attPath.split('/').pop();
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const kind = IMG_EXT.has(ext) ? 'image' : 'file';
    attachments.push({ kind, path: attPath, filename, name: filename });
  }
  // Trim any trailing blank lines that the marker(s) leave behind, but
  // preserve interior structure so leading prose stays intact.
  while (keptLines.length && keptLines[keptLines.length - 1].trim() === '') keptLines.pop();
  return { text: keptLines.join('\n'), attachments };
}

// Consolidate one user message's content blocks into UI events: each
// tool_result becomes its own event, and all text blocks (minus mid-turn
// notes and `Attached file:` marker lines) are joined into a single
// `user_echo` carrying any extracted attachments. Shared by the live path
// (Parser._handleUser) and both jsonl-replay branches in transcript.js so
// live vs replay rendering stays byte-for-byte identical.
export function consolidateUserContent(contentBlocks) {
  const out = [];
  const echoTexts = [];
  const echoAttachments = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      out.push({
        kind: 'tool_result',
        toolUseId: block.tool_use_id ?? null,
        content: block.content ?? '',
        isError: !!block.is_error,
        finishedAt: Date.now(),
      });
    } else if (block.type === 'text') {
      if (typeof block.text !== 'string') continue;
      if (isMidTurnNoteContent(block.text)) continue;
      const { text: leftover, attachments } = extractAttachedMarkers(block.text);
      if (leftover.length) echoTexts.push(leftover);
      for (const a of attachments) echoAttachments.push(a);
    }
  }
  if (echoTexts.length || echoAttachments.length) {
    out.push({
      kind: 'user_echo',
      text: echoTexts.join('\n'),
      attachments: echoAttachments,
    });
  }
  return out;
}

// The CLI marks the Skill-content injection (the SKILL.md dumped back as a
// plain user message right after a Skill tool_use/tool_result) with
// `isSynthetic:true` — but it reuses that same flag for unrelated messages
// (compaction-continuation summaries, Stop-hook feedback), so `isSynthetic`
// alone isn't a reliable "this is skill content" signal. Only treat it as a
// skill load when it immediately follows a Skill tool_use nothing else has
// claimed yet (FIFO — matches the CLI's synchronous
// tool_use -> tool_result -> content-injection ordering). `pendingSkillLoads`
// is a per-stream/per-file queue of `{toolUseId, skill}` the caller pushes to
// when it sees a Skill tool_use. Shared by the live path (Parser._handleUser)
// and transcript.js replay so live vs replay rendering stays identical.
//
// The FIFO has no identity link to the content-injection message (it carries
// no `tool_use_id`), so a pending entry left over from a Skill invocation
// whose injection never arrived (the skill errored, or the turn was
// interrupted) would otherwise sit in the queue indefinitely and could
// mislabel a later, unrelated isSynthetic message. Two bounds close the
// realistic causes: (1) an erroring tool_result for the pending entry's
// toolUseId drops it immediately — no injection is coming; (2) a genuine
// (non-synthetic) user_echo — a real prompt — clears the whole queue, since
// the synchronous-ordering guarantee is broken for every still-pending entry
// once a new real turn begins. This can't close a truly adjacent orphan (no
// tool_result at all, immediately followed by an unrelated isSynthetic
// message with no intervening real turn) — there's no signal to distinguish
// that from a real skill load — but that case is a narrow race rather than
// the unbounded, anywhere-later-in-the-file risk this closes.
export function expireSkillLoads(pendingSkillLoads) {
  if (pendingSkillLoads) pendingSkillLoads.length = 0;
}

export function attachSkillLoad(events, isSynthetic, pendingSkillLoads) {
  if (!pendingSkillLoads) return events;
  for (const ev of events) {
    if (ev.kind === 'tool_result' && ev.isError) {
      const idx = pendingSkillLoads.findIndex((p) => p.toolUseId === ev.toolUseId);
      if (idx !== -1) pendingSkillLoads.splice(idx, 1);
    }
  }
  const echo = events.find((e) => e.kind === 'user_echo');
  if (!echo) return events;
  if (!isSynthetic) {
    expireSkillLoads(pendingSkillLoads);
    return events;
  }
  if (!pendingSkillLoads.length) return events;
  const pending = pendingSkillLoads.shift();
  echo.skillLoad = { skill: pending.skill };
  return events;
}

// A `user_echo` for a top-level (non-sub-agent) user prompt — i.e. one that
// marks a turn boundary. Sub-agent echoes carry a parentToolUseId. Shared by
// the event ring (instances.js) and the paging/archive code (eventArchive.js).
export function isOuterUserEcho(ev) {
  return ev?.kind === 'user_echo' && !ev.parentToolUseId;
}

// Snap a window-start index forward/backward so no sub-agent child event in
// [start, end) is orphaned — i.e. every child's owning tool-call head is also
// in range. For each orphan: if its head sits below `start`, pull `start` back
// to include it; if the head is gone entirely (evicted from the ring), advance
// `start` past all of that group's children so the window stays consistent.
// Loops because one adjustment can expose another straddling group. Shared by
// instances.js snapshotTail and eventArchive.js pageInstanceEvents.
export function snapStartToGroupBoundary(arr, start, end) {
  if (start <= 0) return start;
  let changed = true;
  while (changed) {
    changed = false;
    const headIds = new Set();
    for (let i = start; i < end; i++) {
      if (arr[i].toolUseId &&
          (arr[i].kind === 'tool_use_start' || arr[i].kind === 'tool_use')) {
        headIds.add(arr[i].toolUseId);
      }
    }
    for (let i = start; i < end; i++) {
      const pid = arr[i].parentToolUseId;
      if (!pid || headIds.has(pid)) continue;
      headIds.add(pid); // don't re-process this group in the same pass
      let headIdx = -1;
      for (let j = start - 1; j >= 0; j--) {
        if (arr[j].toolUseId === pid &&
            (arr[j].kind === 'tool_use_start' || arr[j].kind === 'tool_use')) {
          headIdx = j; break;
        }
      }
      if (headIdx >= 0) {
        start = headIdx; // head is below — extend backward to include it
      } else {
        // Head is evicted — advance past all children of this group.
        for (let j = start; j < end; j++) {
          if (arr[j].parentToolUseId === pid) start = j + 1;
        }
      }
      changed = true;
      break; // restart with updated start
    }
  }
  return start;
}

// --- Quiescent-point chunking ----------------------------------------------
//
// A cut index i is QUIESCENT when reconstruction state is empty at the seam:
// no outer text/thinking/tool block is mid-stream (text blocks open at their
// first text_delta — there is no text_start) and every outer tool_use seen
// has received its tool_result. A page/tail sliced at a quiescent index
// contains only whole outer blocks and complete tool round-trips, so the
// client's isolated per-chunk renderer never shows a half block. Quiescent
// points are dense — at least one after every resolved tool round-trip and
// between blocks of one message — so a boundary snap normally moves a few
// indices, never a whole turn.
//
// Outer user_echo / turn_end FORCE-RESET the state: they are always
// boundaries. Without the reset, a hard-interrupted turn (a tool_use whose
// tool_result never arrives) would poison every later index forever; the
// dangling tool renders `· incomplete` via the client's finalize backstop.
// A running foreground Task is an open tool span, so no quiescent point
// exists anywhere inside it.
//
// SUB-AGENT events (parentToolUseId != null) are deliberately IGNORED by this
// scan. Async sub-agents interleave their block PARTS with the outer turn's
// (and each other's), so nested-block wholeness CANNOT come from a linear
// quiescence scan — it comes from snapStartToGroupBoundary: any child event
// in the window pulls the start down to the owning Task head, and because
// chunks are contiguous slices the pulled chunk then contains the head plus
// every group event up to its end, while the next-older page ends strictly
// before the head. One group's events — hence every nested block — are never
// split across chunks. Do NOT extend this state machine to nested blocks: it
// would destroy quiescent density across every background-task region while
// adding nothing the group snap doesn't already guarantee.

function blockKey(ev, type) { return `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:${type}`; }

// An outer turn_end also force-resets (see header comment above).
function isOuterTurnEnd(ev) {
  return ev?.kind === 'turn_end' && !ev.parentToolUseId;
}

class QuiescenceScan {
  constructor() {
    this.openBlocks = new Set();   // `${msgId}:${blockIdx}:${type}` mid-stream
    this.pendingTools = new Set(); // toolUseId awaiting its tool_result
  }
  get empty() { return this.openBlocks.size === 0 && this.pendingTools.size === 0; }
  apply(ev) {
    if (!ev || ev.parentToolUseId) return; // nested — group integrity covers these
    switch (ev.kind) {
      case 'user_echo':
      case 'turn_end':
        this.openBlocks.clear(); this.pendingTools.clear(); break;
      case 'text_delta':     this.openBlocks.add(blockKey(ev, 'text')); break;
      case 'text_end':       this.openBlocks.delete(blockKey(ev, 'text')); break;
      case 'thinking_start':
      case 'thinking_delta': this.openBlocks.add(blockKey(ev, 'thinking')); break;
      case 'thinking_end':   this.openBlocks.delete(blockKey(ev, 'thinking')); break;
      case 'tool_use_start':
      case 'tool_use_input_delta':
        this.openBlocks.add(blockKey(ev, 'tool'));
        if (ev.toolUseId) this.pendingTools.add(ev.toolUseId);
        break;
      case 'tool_use': // block finalized; the SPAN stays open until tool_result
        this.openBlocks.delete(blockKey(ev, 'tool'));
        if (ev.toolUseId) this.pendingTools.add(ev.toolUseId);
        break;
      case 'tool_result':
        if (ev.toolUseId) this.pendingTools.delete(ev.toolUseId);
        break;
      default: break; // message_start / system / assistant_message / … are state-neutral
    }
  }
}

// Nearest index <= i where the scan state is known: index 0 (array start),
// `resetIdx` (an externally-declared discontinuity, e.g. the archive→ring
// seam — state must never be scanned across it), or an outer
// user_echo/turn_end (both force-reset).
function nearestResetOrigin(arr, i, resetIdx) {
  for (let j = i; j > 0; j--) {
    if (j === resetIdx || isOuterUserEcho(arr[j]) || isOuterTurnEnd(arr[j])) return j;
  }
  return 0;
}

// Core quiescent search. Returns `start` when it is already quiescent, else
// (allowForward) the first quiescent index inside (start, end) — keeps the
// window small — else the nearest quiescent index below `start`. A backward
// result always exists within the current turn (its reset origin is
// reachable), so the reach is bounded by one turn / one giant block run,
// never unbounded. Index 0, `resetIdx` and outer user_echo indices are
// quiescent BY FIAT (cutting right before a turn boundary is the legacy
// behavior; the seam and the array start are boundaries by construction).
function quiesceStart(arr, start, end, resetIdx, allowForward) {
  if (start <= 0) return 0;
  if (start === resetIdx || isOuterUserEcho(arr[start])) return start;
  const r = nearestResetOrigin(arr, start - 1, resetIdx);
  // At a turn_end origin the state BEFORE the event is unknown — it only
  // becomes known-empty after applying it, so index r itself is not claimable.
  const originValid = r === 0 || r === resetIdx || isOuterUserEcho(arr[r]);
  const scan = new QuiescenceScan();
  let best = -1;
  for (let i = r; i < end; i++) {
    const fiat = i === resetIdx || isOuterUserEcho(arr[i]);
    const quiescent = fiat || (scan.empty && (i > r || originValid));
    if (quiescent) {
      if (i === start) return start;
      if (i < start) best = i;
      else if (allowForward) return i;
      else break;
    } else if (i > start && !allowForward) break;
    scan.apply(arr[i]);
  }
  return best !== -1 ? best : start; // nothing reachable — raw start stands
}

// Smallest quiescent index in [from, bound), or -1. Used by EventLog._trim
// to keep the post-eviction ring head on whole blocks when no turn boundary
// is in reach. Assumes arr[0] opens on a boundary (true by induction over
// trims, except after a plain-cut last resort — a documented degradation).
export function firstQuiescentAtOrAfter(arr, from, bound) {
  if (from <= 0) return 0;
  const r = nearestResetOrigin(arr, from, -1);
  const originValid = r === 0 || isOuterUserEcho(arr[r]);
  const scan = new QuiescenceScan();
  for (let i = r; i < bound; i++) {
    const fiat = isOuterUserEcho(arr[i]);
    const quiescent = fiat || (scan.empty && (i > r || originValid));
    if (quiescent && i >= from) return i;
    scan.apply(arr[i]);
  }
  return -1;
}

// Snap a window-start index to a quiescent point, then enforce sub-agent
// group integrity. `resetIdx` marks the archive→ring seam inside a combined
// array (see eventArchive.js) — quiescent by fiat, opaque to the scan.
//
// After the quiescent snap, snapStartToGroupBoundary runs. A BACKWARD pull
// (a child's head below the window — e.g. a background Task from an earlier
// turn) re-triggers the backward quiescent snap so the window still opens on
// a whole-block boundary at or below that head; a FORWARD move (head evicted
// entirely — the archive gap case) is final. Group integrity is unbounded by
// design (an orphaned child would be silently dropped by the renderer, so
// the head must be included at any cost) — and it is the SOLE guarantee that
// nested (sub-agent) blocks are never cut, since the quiescence scan ignores
// child events (see the header comment above). Shared by instances.js
// snapshotTail and eventArchive.js pageInstanceEvents.
export function snapStartToQuiescent(arr, start, end, { resetIdx = -1 } = {}) {
  start = quiesceStart(arr, start, end, resetIdx, true);
  // Fixpoint loop: each backward group pull re-snaps to a quiescent point,
  // which can expose another straddling group. Backward moves are monotonic
  // (bounded by index 0); the iteration cap is a defensive net only.
  for (let iter = 0; iter < 20; iter++) {
    const snapped = snapStartToGroupBoundary(arr, start, end);
    if (snapped >= start) return snapped;
    const re = quiesceStart(arr, snapped, end, resetIdx, false);
    if (re === snapped) return snapped; // no quiescent point below the pulled-in head
    start = re;
  }
  return snapStartToGroupBoundary(arr, start, end);
}

export default Parser;
