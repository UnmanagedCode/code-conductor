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
//   user_echo               { text, attachments?: [{kind:'image'|'file', ...}] }
//   system                  { subtype, data }
//   hook                    { event, data }
//   assistant_message       { msgId, message }              // final reconciled message
//   turn_end                { usage, durationMs, cost, costDelta, isError, stopReason, subtype }
//   control_response        { requestId, ok, response?, error? }
//   raw                     { line }                        // fallback for unrecognized

import { randomUUID } from 'node:crypto';

export class Parser {
  constructor() {
    this.currentMsgId = null;
    this.blocks = new Map(); // blockIdx -> { type, accumText, accumJson, toolUseId, name }
    this._lastCost = 0; // tracks cumulative cost to compute per-turn delta
  }

  reset() {
    this.currentMsgId = null;
    this.blocks.clear();
    this._lastCost = 0;
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
        return [{ kind: 'message_start', msgId: this.currentMsgId, usage }];
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
    if (typeof content === 'string') {
      return [{ kind: 'user_echo', text: content }];
    }
    if (!Array.isArray(content)) return [];
    return consolidateUserContent(content);
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
      durationMs: obj.duration_ms ?? null,
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

export default Parser;
