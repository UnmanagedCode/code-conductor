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
//   turn_end                { usage, durationMs, cost, isError, stopReason, subtype }
//   control_response        { requestId, ok, response?, error? }
//   raw                     { line }                        // fallback for unrecognized

import { randomUUID } from 'node:crypto';

export class Parser {
  constructor() {
    this.currentMsgId = null;
    this.blocks = new Map(); // blockIdx -> { type, accumText, accumJson, toolUseId, name }
  }

  reset() {
    this.currentMsgId = null;
    this.blocks.clear();
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
            // No thinking_delta arrived — the model (e.g. Opus 4.7) thought
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
    return [{
      kind: 'assistant_message',
      msgId: msg.id ?? this.currentMsgId,
      message: msg,
    }];
  }

  _handleUser(obj) {
    const msg = obj.message ?? {};
    const content = msg.content;
    if (typeof content === 'string') {
      return [{ kind: 'user_echo', text: content }];
    }
    if (!Array.isArray(content)) return [];
    const out = [];
    // Group text blocks of a single user message into one user_echo so
    // the bubble renders text and attachments together. Text blocks may
    // contain `Attached file:` marker lines that we wrote at send time
    // — extract those into attachment entries so the replayed bubble
    // shows a thumbnail / file chip instead of the raw path text.
    // Tool_result blocks remain their own events.
    const echoTexts = [];
    const echoAttachments = [];
    for (const block of content) {
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

  _handleResult(obj) {
    return [{
      kind: 'turn_end',
      subtype: obj.subtype ?? 'success',
      stopReason: obj.stop_reason ?? null,
      durationMs: obj.duration_ms ?? null,
      cost: obj.total_cost_usd ?? null,
      usage: obj.usage ?? null,
      isError: !!obj.is_error,
    }];
  }
}

// Detect "Attached file: `<path>`" marker lines in a text block (the
// shape we write in instances.js prompt()) and split them out as
// attachment entries. Path must live under .hivemind/attachments/
// to be recognized — anchors the match so unrelated prose mentioning
// "Attached file:" isn't accidentally promoted.
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const ATT_LINE_RE = /^Attached file:\s*`((?:[^`]*\/)?\.hivemind\/attachments\/[^`]+)`\s*$/;

export function extractAttachedMarkers(text) {
  const lines = text.split('\n');
  const keptLines = [];
  const attachments = [];
  for (const line of lines) {
    const m = line.match(ATT_LINE_RE);
    if (!m) { keptLines.push(line); continue; }
    const relPath = m[1];
    const filename = relPath.split('/').pop();
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const kind = IMG_EXT.has(ext) ? 'image' : 'file';
    attachments.push({ kind, path: relPath, filename, name: filename });
  }
  // Trim any trailing blank lines that the marker(s) leave behind, but
  // preserve interior structure so leading prose stays intact.
  while (keptLines.length && keptLines[keptLines.length - 1].trim() === '') keptLines.pop();
  return { text: keptLines.join('\n'), attachments };
}

export default Parser;
