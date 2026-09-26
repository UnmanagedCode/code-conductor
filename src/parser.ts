// Normalize Claude Code stream-json events into compact UI events.
//
// Each call to handleLine(line) parses one JSON object emitted on stdout and
// returns an array of UI events (possibly empty). The parser keeps minimal
// per-instance state so streaming content blocks can be merged across many
// stream_event chunks before the matching content_block_stop arrives.
//
// Emitted UI event kinds:
//   message_start           { msgId, usage }                // live context-size signal
//   context_usage           { msgId, usage }                // fallback context-size signal (see _ctxFallbackArmed)
//   text_delta              { msgId, blockIdx, text }
//   text_end                { msgId, blockIdx }
//   thinking_delta          { msgId, blockIdx, text }
//   thinking_end            { msgId, blockIdx }
//   tool_use_input_delta    { msgId, blockIdx, toolUseId, partialJson }
//   tool_use                { msgId, blockIdx, toolUseId, name, input }
//   tool_result             { toolUseId, content, isError, yielded?: true }
//   user_echo               { text, attachments?: [{kind:'image'|'file', ...}], skillLoad?: {skill}, cliInjected?: true }
//   system                  { subtype, data }
//   hook                    { event, data }
//   assistant_message       { msgId, message }              // final reconciled message
//   turn_end                { usage, durationMs, durationApiMs, durationApiMsDelta, cost, costDelta, isError, stopReason, subtype }
//   control_response        { requestId, ok, response?, error? }
//   raw                     { line }                        // fallback for unrecognized
//
// The CLI's stream-json wire shapes are an UNTYPED external boundary — the
// envelope/block/delta interfaces below declare only the fields this file
// reads, loosely (unknown), and each read narrows at the point of use. A
// non-conforming value fails toward a safe default rather than propagating
// (recorded as deliberate edge-tightening in the batch commit).

import { randomUUID } from 'node:crypto';
import { planPathFromInput } from './planFile.ts';
import { AWAITING_INPUT_MESSAGE, EARLIER_AWAITING_INPUT_MESSAGES } from './settings.ts';

// UI event shape. `kind` is the discriminator; the per-kind payload fields
// ride on the index signature (consumers read what they know).
export interface UiEvent {
  kind: string;
  parentToolUseId?: string | null;
  [key: string]: unknown;
}

// ── CLI stream-json wire shapes ───────────────────────────────────────────

export interface WireContentBlock {
  type?: unknown;
  name?: unknown;
  id?: unknown;
  text?: unknown;
  thinking?: unknown;
  input?: Record<string, unknown> | null;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

export interface WireMessage {
  id?: unknown;
  model?: unknown;
  usage?: unknown;
  content?: unknown;
}

interface WireStreamEvent {
  type?: unknown;
  index?: unknown;
  message?: WireMessage | null;
  content_block?: WireContentBlock | null;
  delta?: { type?: unknown; text?: unknown; thinking?: unknown; partial_json?: unknown } | null;
  usage?: unknown; // message_delta only — the ctx fallback source
}

export interface WireEnvelope {
  type?: unknown;
  subtype?: unknown;
  message?: WireMessage | null;
  event?: WireStreamEvent | null;
  parent_tool_use_id?: unknown;
  request_id?: unknown;
  response?: { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } | null;
  total_cost_usd?: unknown;
  duration_api_ms?: unknown;
  duration_ms?: unknown;
  stop_reason?: unknown;
  usage?: unknown;
  is_error?: unknown;
  isSynthetic?: unknown;
  isMeta?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  sourceToolUseID?: unknown;
}

// Per-block merge state keyed by blockIdx.
interface BlockState {
  type: string | null;
  accumText: string;
  accumJson: string;
  gotThinkingDelta: boolean;
  toolUseId: string | null;
  name: string | null;
}

export interface PendingSkillLoad {
  toolUseId: string | null;
  skill: string | null;
}

interface BoundaryInterval {
  left: number;
  right: number;
  headless: boolean;
}

interface GroupState {
  head: number;
  interval: BoundaryInterval | null;
}

function eventIndex(ev: WireStreamEvent): number {
  const idx = ev.index;
  return typeof idx === 'number' ? idx : 0;
}

// The prompt size of one API call: the three input-side fields the ctx readout
// sums. One definition, because both context-reading sources (message_start
// and the message_delta fallback) apply the same "a zero sum is not a
// measurement" floor and must not drift apart — and Prune's estimate reads the
// same sum off persisted usage (sessionPrune.ts).
export function promptTokenSum(usage: unknown): number {
  const u = (usage ?? {}) as {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  return (u.input_tokens ?? 0)
       + (u.cache_read_input_tokens ?? 0)
       + (u.cache_creation_input_tokens ?? 0);
}

export class Parser {
  currentMsgId: string | null = null;
  blocks = new Map<number, BlockState>(); // blockIdx -> { type, accumText, accumJson, toolUseId, name }
  _lastCost = 0; // tracks cumulative cost to compute per-turn delta
  _lastApiMs = 0; // tracks cumulative duration_api_ms to compute per-turn delta
  _pendingSkillLoads: PendingSkillLoad[] = []; // {toolUseId, skill} entries awaiting their content injection
  // Armed by a present-but-all-zero message_start.usage — the shape a
  // substitution backend's gateway reports on every frame — so this message's
  // message_delta.usage can supply the ctx reading instead. Disarmed by a
  // usage-bearing message_start, which makes the two sources mutually
  // exclusive within one message (see the message_delta arm).
  _ctxFallbackArmed = false;

  reset() {
    this.currentMsgId = null;
    this.blocks.clear();
    this._lastCost = 0;
    this._lastApiMs = 0;
    this._pendingSkillLoads = [];
    this._ctxFallbackArmed = false;
  }

  // Signal a genuine turn boundary (a real prompt or interrupt emitted
  // directly by Instance, bypassing _handleUser/attachSkillLoad) so any
  // Skill invocation still awaiting its content injection is dropped rather
  // than surviving to mislabel a later, unrelated isSynthetic message.
  expirePendingSkillLoads() {
    expireSkillLoads(this._pendingSkillLoads);
  }

  handleLine(line: unknown): UiEvent[] {
    const text = typeof line === 'string' ? line.trim() : '';
    if (!text) return [];
    let obj: unknown;
    try { obj = JSON.parse(text); }
    catch { return [{ kind: 'raw', line: text }]; }
    return this.handleObject(obj);
  }

  handleObject(obj: unknown): UiEvent[] {
    if (!obj || typeof obj !== 'object') return [];
    const events = this._dispatch(obj as WireEnvelope);
    // Tag every emitted UI event with the parent_tool_use_id (or null) from
    // the wrapping stream-json envelope. The conversation view uses this to
    // route sub-agent events into a nested area under the matching outer
    // Task tool_use block.
    const parentToolUseId = obj as WireEnvelope;
    const rawParent = parentToolUseId.parent_tool_use_id;
    const tag = typeof rawParent === 'string' ? rawParent : null;
    for (const ev of events) {
      if (!('parentToolUseId' in ev)) ev.parentToolUseId = tag;
    }
    return events;
  }

  _dispatch(obj: WireEnvelope): UiEvent[] {
    const type = typeof obj.type === 'string' ? obj.type : '';
    switch (type) {
      case 'system':       return this._handleSystem(obj);
      case 'stream_event': return this._handleStreamEvent(obj);
      case 'assistant':    return this._handleAssistant(obj);
      case 'user':         return this._handleUser(obj);
      case 'result':       return this._handleResult(obj);
      case 'hook_event':   return [{ kind: 'hook', event: obj.event?.type ?? obj.subtype ?? 'unknown', data: obj }];
      case 'control_response': return this._handleControlResponse(obj);
      case 'control_request':  return this._handleControlRequest(obj);
      case 'keep_alive':       return [];
      default:
        return [{ kind: 'system', subtype: obj.type ?? 'unknown', data: obj }];
    }
  }

  _handleSystem(obj: WireEnvelope): UiEvent[] {
    return [{ kind: 'system', subtype: obj.subtype ?? 'unknown', data: obj }];
  }

  _handleControlRequest(obj: WireEnvelope): UiEvent[] {
    return [{ kind: 'system', subtype: 'control_request', data: obj }];
  }

  _handleControlResponse(obj: WireEnvelope): UiEvent[] {
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

  _handleStreamEvent(obj: WireEnvelope): UiEvent[] {
    const ev = obj.event ?? {};
    const type = typeof ev.type === 'string' ? ev.type : '';
    switch (type) {
      case 'message_start': {
        // Single-writer assumption: only the top-level agent's partials ever
        // arrive as stream_event frames — the CLI hardcodes
        // parent_tool_use_id:null on every stream_event it emits and forwards
        // sub-agent turns as finals-only assistant/user envelopes (their
        // partial forwarding, forwardSubagentText, is SDK-only with no CLI
        // flag). So resetting the shared currentMsgId/blocks here can never
        // clobber an interleaved sub-agent message.
        const rawId = ev.message?.id;
        this.currentMsgId = typeof rawId === 'string' ? rawId : `msg_${randomUUID()}`;
        this.blocks.clear();
        // Surface the usage block. Each agent-loop step within a turn
        // fires its own message_start with cumulative input-side counts
        // (input_tokens + cache_read + cache_creation), so this is the
        // signal that lets the context-usage chip update mid-turn rather
        // than only when the final `result` lands. Skip emission when
        // there's no usage payload (defensive — keeps DOM tests stable
        // for fixtures that omit it).
        //
        // A zero prompt sum is not a measurement: some substitution
        // backends' gateways report an all-zero usage block on EVERY
        // message_start (real numbers only on the final `result`, in the
        // jsonl, and — on some of them — on this message's
        // `message_delta.usage`), which latched verbatim renders a false
        // `ctx 0% · 0/200k` forever. So drop the BLOCK, not the event —
        // message_start also carries the turn-boundary model reading and
        // the idle→turn flip for a turn we didn't initiate (see
        // Instance._emitUi), and suppressing it would strand such turns
        // at `idle`. `usage: null` is the shape both latches already read
        // as "no reading". The replay path applies the same floor over
        // the same three fields (loadPersistedTranscript in
        // src/transcript.ts).
        const usage = ev.message?.usage ?? null;
        // An ABSENT usage suppresses the event and leaves the fallback flag
        // untouched: nothing armed it, so there is nothing to disarm, and the
        // absent-then-delta shape has no in-tree evidence to arm on.
        if (!usage) return [];
        const prompt = promptTokenSum(usage);
        // Arm the message_delta fallback exactly when this message produced no
        // reading, and disarm when it did. That gate is what makes the two
        // sources mutually exclusive per message — a backend whose
        // message_start carries real numbers never emits a context_usage, so
        // there is nothing to interleave with its own readings.
        this._ctxFallbackArmed = prompt === 0;
        return [{
          kind: 'message_start',
          msgId: this.currentMsgId,
          usage: prompt > 0 ? usage : null,
          model: ev.message?.model ?? null,
        }];
      }
      case 'content_block_start': {
        const idx = eventIndex(ev);
        const cb = ev.content_block ?? {};
        const block: BlockState = {
          type: typeof cb.type === 'string' ? cb.type : null,
          accumText: '',
          accumJson: '',
          gotThinkingDelta: false,
          toolUseId: typeof cb.id === 'string' ? cb.id : null,
          name: typeof cb.name === 'string' ? cb.name : null,
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
        const idx = eventIndex(ev);
        const block = this.blocks.get(idx);
        const delta = ev.delta ?? {};
        if (!block) return [];
        const deltaType = typeof delta.type === 'string' ? delta.type : '';
        switch (deltaType) {
          case 'text_delta': {
            const text = typeof delta.text === 'string' ? delta.text : '';
            block.accumText += text;
            return [{ kind: 'text_delta', msgId: this.currentMsgId, blockIdx: idx, text }];
          }
          case 'thinking_delta': {
            const raw = delta.thinking ?? delta.text;
            const text = typeof raw === 'string' ? raw : '';
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
            const part = typeof delta.partial_json === 'string' ? delta.partial_json : '';
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
        const idx = eventIndex(ev);
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
          let input: Record<string, unknown> = {};
          if (block.accumJson) {
            try {
              const parsed: unknown = JSON.parse(block.accumJson);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                input = parsed as Record<string, unknown>;
              }
            } catch {
              input = { _raw: block.accumJson };
            }
          }
          const out: UiEvent[] = [{
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
          if (block.name === 'AskUserQuestion' && Array.isArray(input.questions)) {
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
          // a file first — Instance's PlanFileTracker enriches the event with
          // the file path and content in the latter case. A path named by the
          // input itself wins over that enrichment.
          if (block.name === 'ExitPlanMode') {
            out.push({
              kind: 'plan_request',
              toolUseId: block.toolUseId,
              plan: typeof input.plan === 'string' ? input.plan : null,
              planPath: planPathFromInput(input),
            });
          }
          // Skill invocations are NOT registered here — _handleAssistant is
          // the single registration point. See the note there.
          return out;
        }
        return [];
      }
      case 'message_delta': {
        // Normally discarded. The one exception: this message's message_start
        // reported an all-zero prompt (armed above), and this backend puts the
        // real prompt size here instead — event-level `usage`, not
        // `delta.usage` (see tests/fixtures/scenario-live-skill-load.json for
        // the captured envelope). Emitted as its OWN kind rather than a second
        // `message_start`, which would feed the delta's cache numbers into
        // cross-turn cache-miss bookkeeping (Instance._handleMessageStart).
        if (!this._ctxFallbackArmed) return [];
        const usage = ev.usage ?? null;
        // Same floor as message_start, for the same reason: a zero renders
        // `ctx 0% · 0/200k`, which is worse than `ctx —`.
        if (!usage || promptTokenSum(usage) === 0) return [];
        // Deliberately stays armed — "last non-zero delta wins" is the latch's
        // job, and the next message_start always re-decides the flag.
        return [{ kind: 'context_usage', msgId: this.currentMsgId, usage }];
      }
      case 'message_stop':
        return [];
      default:
        return [];
    }
  }

  _handleAssistant(obj: WireEnvelope): UiEvent[] {
    const msg = obj.message ?? {};
    const events: UiEvent[] = [];
    // THE single registration point for Skill invocations awaiting their
    // content injection. Nothing arrives streaming-only: measured over the 11
    // stdout captures on disk (12,226 lines, 6 model ids), 353 tool_use ids
    // appeared on both the envelope and the streaming frames, 0 on the
    // streaming frames alone, and the envelope arrived first in 353/353. So
    // registering here loses nothing, and registering in the
    // content_block_stop branch as well would only ever double-register: the
    // envelope lands first, so the entry is still pending when the stop frame
    // arrives. (A trimmed live capture of one such turn is committed as
    // tests/fixtures/scenario-live-skill-load.json.)
    //
    // Sub-agent tool_uses are deliberately NOT registered. The CLI forwards
    // sub-agent turns as envelopes tagged with parent_tool_use_id, but no
    // injection was ever observed to follow one: the ONE captured sub-agent
    // Skill call — in a capture since deleted, so this rests on n=1 and is no
    // longer re-derivable — went tool_use -> tool_result -> system with no
    // injection. No surviving capture contains a sub-agent turn at all, so
    // there is no corroborating evidence either way. An entry registered here could
    // therefore never be consumed by its own injection: it would sit at the
    // head of the queue and steal the next TOP-LEVEL injection instead. Not
    // registering is the conservative reading — it forgoes folding we have no
    // evidence is possible rather than risking a mislabel. A sub-agent Skill
    // still folds on replay, where the persisted jsonl does record the
    // injection (loadSubAgentTranscript, src/transcript.ts, pinned against a
    // real fixture in tests/transcript-skill-load.test.mjs).
    if (!obj.parent_tool_use_id) {
      for (const raw of Array.isArray(msg.content) ? msg.content : []) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as WireContentBlock;
        if (b.type !== 'tool_use' || b.name !== 'Skill') continue;
        this._pendingSkillLoads.push({
          toolUseId: typeof b.id === 'string' ? b.id : null,
          skill: typeof b.input?.skill === 'string' ? b.input.skill : null,
        });
      }
    }
    // Slash commands (registered or not) are handled locally by the CLI and
    // come back as a single `assistant` envelope with `model:"<synthetic>"`
    // and no preceding stream_event frames. The normal delta-driven render
    // path never fires, so without unpacking the text blocks here the UI
    // sees nothing between the user prompt and the turn footer. Emit
    // synthetic text_delta + text_end events so the existing pipeline
    // renders an assistant bubble.
    if (msg.model === '<synthetic>' && Array.isArray(msg.content)) {
      const rawMsgId = msg.id;
      const msgId = typeof rawMsgId === 'string' ? rawMsgId : `synthetic_${randomUUID()}`;
      let blockIdx = 0;
      for (const raw of msg.content) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as WireContentBlock;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length) {
          events.push({ kind: 'text_delta', msgId, blockIdx, text: b.text });
          events.push({ kind: 'text_end', msgId, blockIdx });
          blockIdx += 1;
        }
      }
    }
    // Sub-agent turns arrive as finals-only envelopes: no stream_event frames
    // ever carry a depth-2+ tool_use, so its head must be unpacked here or no
    // event in the ring ever names it (see the module-level note on why the
    // gate below is load-bearing).
    if (obj.parent_tool_use_id) {
      const msgId = msg.id ?? this.currentMsgId;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (let i = 0; i < content.length; i++) {
        const raw = content[i];
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as WireContentBlock;
        if (b.type !== 'tool_use') continue;
        events.push({
          kind: 'tool_use', msgId, blockIdx: i,
          toolUseId: typeof b.id === 'string' ? b.id : null,
          name: typeof b.name === 'string' ? b.name : null,
          input: b.input ?? {},
        });
      }
    }
    events.push({
      kind: 'assistant_message',
      msgId: msg.id ?? this.currentMsgId,
      message: msg,
    });
    return events;
  }

  _handleUser(obj: WireEnvelope): UiEvent[] {
    const msg = obj.message ?? {};
    const content = msg.content;
    // If the CLI echoes a marked wind-down steer back on stdout (historical jsonls
    // only — nothing writes them now), surface it
    // as a system annotation so the user can see a stop was requested.
    if (isSoftInterruptContent(content)) return [{ kind: 'system', subtype: 'soft_interrupted' }];
    // The CLI's own post-abort marker line. Same annotation, same reason: a
    // deferred (⏸) interrupt now produces one on every stop, and a user bubble
    // would both render wrong and shift the rewind/fork prompt index.
    if (isInterruptMarkerContent(content)) return [{ kind: 'system', subtype: 'soft_interrupted' }];
    // Background-subagent completion ping the CLI re-injects into a
    // worker's own conversation as though it were a user turn. Drop
    // silently — the streaming `system/task_notification` event already
    // carries this (hidden from the feed by default), so this would be a
    // duplicate, and it never produced a user_echo live.
    if (isTaskNotificationContent(content)) return [];
    if (typeof content === 'string') {
      return stampCliInjected([{ kind: 'user_echo', text: content }], obj);
    }
    if (!Array.isArray(content)) return [];
    const events = consolidateUserContent(content);
    return stampCliInjected(attachSkillLoad(events, obj, this._pendingSkillLoads), obj);
  }

  _handleResult(obj: WireEnvelope): UiEvent[] {
    // total_cost_usd and duration_api_ms are both cumulative session totals in
    // the SDK result, not per-turn values. Convert each to a per-turn delta so
    // callers can display / accumulate the actual turn cost and LLM time.
    // (duration_ms — turn walltime — is genuinely per-turn and left as-is.)
    const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
    const costDelta = cost != null ? cost - this._lastCost : null;
    if (cost != null) this._lastCost = cost;
    const apiMs = typeof obj.duration_api_ms === 'number' ? obj.duration_api_ms : null;
    const durationApiMsDelta = apiMs != null ? apiMs - this._lastApiMs : null;
    if (apiMs != null) this._lastApiMs = apiMs;
    return [{
      kind: 'turn_end',
      subtype: obj.subtype ?? 'success',
      stopReason: obj.stop_reason ?? null,
      durationMs: obj.duration_ms ?? null,        // turn walltime (incl. tool exec), per-turn
      durationApiMs: apiMs,                        // raw cumulative session API time (kept for reference)
      durationApiMsDelta,                          // per-turn LLM/inference time
      cost,      // raw cumulative session total (kept for reference)
      costDelta, // actual cost of this turn
      usage: obj.usage ?? null,
      isError: !!obj.is_error,
    }];
  }
}

// Detect "Attached file: `<path>`" marker lines in a text block (the
// shape we write in instances.ts prompt()) and split them out as
// attachment entries. Path must point inside the orchestrator's central
// store (`.../<ORCH_STORE_DIRNAME>/.../attachments/<file>`) to be
// recognized — anchors the match so unrelated prose mentioning
// "Attached file:" isn't accidentally promoted.
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const ATT_LINE_RE = /^Attached file:\s*`([^`]*?\/\.code-conductor\/[^`]+?\/attachments\/[^`]+)`\s*$/;

export interface Attachment {
  kind: 'image' | 'file';
  path: string;
  filename: string;
  name: string;
}

// Sentinel on the orchestrator wind-down steers of every session recorded before
// the drain and the overage stop became plain aborts. READ-ONLY now — nothing
// writes it any more, but historical jsonls still carry it, so the VALUE must not
// change and every recognition site below stays live. The
// CLI persists the injected prompt to the session jsonl — as a `type:"user"`
// line live, or a `type:"attachment"` queued_command line when received
// mid-turn — so this marker lets the live parser, the transcript replay, and the
// rewind/fork prompt-counter all recognise it. It renders as a
// `system/soft_interrupted` annotation rather than a user bubble, and never
// shifts the user-message index.
export const SOFT_INTERRUPT_MARKER = '[[cc:soft-interrupt]]';

// True when a user-message `content` (string or block array) or a
// queued_command `prompt` array is a marked orchestrator steer — detected by
// the marker appearing anywhere in a text block (marker is appended at the end
// of the text, not the beginning).
export function isSoftInterruptContent(content: unknown): boolean {
  if (typeof content === 'string') return content.includes(SOFT_INTERRUPT_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === 'object' && (b as { type?: unknown; text?: unknown }).type === 'text'
           && typeof (b as { text?: unknown }).text === 'string'
           && (b as { text: string }).text.includes(SOFT_INTERRUPT_MARKER),
  );
}

// The CLI writes its own marker line as a plain `type:"user"` message after
// an `interrupt` control_request lands — "…for tool use" when the abort caught
// a dispatched tool, the bare form otherwise. Anchored to a LONE text block so
// a model quoting the phrase mid-answer is never swallowed. Filtered at the
// same three sites as SOFT_INTERRUPT_MARKER.
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user(?: for tool use)?\]$/;

export function isInterruptMarkerContent(content: unknown): boolean {
  const isMarker = (text: unknown) => typeof text === 'string' && INTERRUPT_MARKER_RE.test(text.trim());
  if (typeof content === 'string') return isMarker(content);
  if (!Array.isArray(content) || content.length !== 1) return false;
  const b = content[0];
  return !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
    && isMarker((b as { text?: unknown }).text);
}

// True when a user-message `content` (string or block array) is the CLI's
// own "background subagent finished" ping, re-injected into a worker's own
// conversation as though it were a user turn. Detected by tag shape, not a
// marker, since the CLI — not this codebase — produces the string, so
// there's nothing to append a marker to.
export function isTaskNotificationContent(content: unknown): boolean {
  const isTag = (text: unknown) => typeof text === 'string' && text.trimStart().startsWith('<task-notification>');
  if (typeof content === 'string') return isTag(content);
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === 'object' && (b as { type?: unknown; text?: unknown }).type === 'text' && isTag((b as { text?: unknown }).text));
}

// True when a single text block is the mid-turn annotation prepended by
// Instance.prompt() when a message arrives while a worker is in-flight.
// Matched by shape (system-reminder wrapper + 'mid-turn' token), not by
// exact string, so minor wording tweaks don't silently break filtering.
export function isMidTurnNoteContent(text: unknown): boolean {
  return typeof text === 'string'
    && text.startsWith('<system-reminder>')
    && text.includes('mid-turn')
    && text.trimEnd().endsWith('</system-reminder>');
}

export function extractAttachedMarkers(text: string): { text: string; attachments: Attachment[] } {
  const lines = text.split('\n');
  const keptLines: string[] = [];
  const attachments: Attachment[] = [];
  for (const line of lines) {
    const m = line.match(ATT_LINE_RE);
    if (!m) { keptLines.push(line); continue; }
    const attPath = m[1];
    const filename = attPath.split('/').pop() ?? '';
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const kind = IMG_EXT.has(ext) ? 'image' : 'file';
    attachments.push({ kind, path: attPath, filename, name: filename });
  }
  // Trim any trailing blank lines that the marker(s) leave behind, but
  // preserve interior structure so leading prose stays intact.
  while (keptLines.length && keptLines[keptLines.length - 1].trim() === '') keptLines.pop();
  return { text: keptLines.join('\n'), attachments };
}

// Every text the orchestrator's interactive-tool deny carries, current and
// earlier; matched exactly.
const YIELDED_RESULT_TEXTS: ReadonlySet<unknown> = new Set([AWAITING_INPUT_MESSAGE, ...EARLIER_AWAITING_INPUT_MESSAGES]);

// Consolidate one user message's content blocks into UI events: each
// tool_result becomes its own event, and all text blocks (minus mid-turn
// notes and `Attached file:` marker lines) are joined into a single
// `user_echo` carrying any extracted attachments. Shared by the live path
// (Parser._handleUser) and both jsonl-replay branches in transcript.ts so
// live vs replay rendering stays byte-for-byte identical.
export function consolidateUserContent(contentBlocks: unknown[]): UiEvent[] {
  const out: UiEvent[] = [];
  const echoTexts: string[] = [];
  const echoAttachments: Attachment[] = [];
  for (const raw of contentBlocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as WireContentBlock;
    if (block.type === 'tool_result') {
      out.push({
        kind: 'tool_result',
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        content: block.content ?? '',
        isError: !!block.is_error,
        // The orchestrator's own can_use_tool deny of an interactive tool:
        // handed to the user, not a failure. isError stays for the model's view.
        ...(YIELDED_RESULT_TEXTS.has(block.content) ? { yielded: true } : {}),
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
// plain user message right after a Skill tool_use/tool_result) as a
// CLI-injected rather than user-typed message — but it reuses that same mark
// for unrelated messages (compaction-continuation summaries, Stop-hook
// feedback), so the mark alone isn't a reliable "this is skill content"
// signal. `pendingSkillLoads` is a per-stream/per-file queue of
// `{toolUseId, skill}` the caller pushes to when it sees a Skill tool_use;
// this correlates an injection back to its invocation. Shared by the live
// path (Parser._handleUser) and transcript.ts replay so live vs replay
// rendering stays identical.
//
// The two surfaces name the mark differently AND support different
// correlation strengths — see skillInjectionMarker. Where only FIFO order is
// available (stdout), a pending entry left over from a Skill invocation whose
// injection never arrived (the skill errored, or the turn was interrupted)
// would otherwise sit in the queue indefinitely and could mislabel a later,
// unrelated injected message. Two bounds close the realistic causes: (1) an
// erroring tool_result for the pending entry's toolUseId drops it immediately
// — no injection is coming; (2) a genuine (non-injected) user_echo — a real
// prompt — clears the whole queue, since the synchronous-ordering guarantee is
// broken for every still-pending entry once a new real turn begins. This can't
// close a truly adjacent orphan (no tool_result at all, immediately followed
// by an unrelated injected message with no intervening real turn) — there's no
// signal to distinguish that from a real skill load — but that case is a
// narrow race rather than the unbounded, anywhere-later-in-the-file risk this
// closes. Replay, which has identity, is not exposed to any of it.
export function expireSkillLoads(pendingSkillLoads: PendingSkillLoad[] | null | undefined): void {
  if (pendingSkillLoads) pendingSkillLoads.length = 0;
}

// Normalize a source line into the marker attachSkillLoad reasons about. The
// CLI names the same fact differently per surface, and the surfaces are NOT
// interchangeable:
//   stdout envelope — `isSynthetic` (the CLI builds it as
//     `isMeta || isVisibleInTranscriptOnly`) and never carries
//     `sourceToolUseID`, so FIFO order is the only correlation available.
//   persisted jsonl — `isMeta` / `isVisibleInTranscriptOnly`, and every skill
//     injection carries `sourceToolUseID`: the id of the Skill tool_use it
//     belongs to. Exact identity, so the meta lines that are NOT skill
//     injections (compaction continuations, hook feedback) cannot steal a
//     pending entry.
// Deriving both facts here — rather than at each call site — is the point:
// the replay path testing the stdout field name is what shipped the
// skill-bubble-only-renders-live bug.
function skillInjectionMarker(obj: WireEnvelope): { injected: boolean; sourceToolUseId: string | null; identityOnly: boolean } {
  const persisted = obj?.isMeta === true || obj?.isVisibleInTranscriptOnly === true;
  const streamed = obj?.isSynthetic === true;
  return {
    injected: persisted || streamed,
    sourceToolUseId: typeof obj?.sourceToolUseID === 'string' ? obj.sourceToolUseID : null,
    // jsonl-shaped: identity is the only legal correlation on this surface.
    identityOnly: persisted && !streamed,
  };
}

// True for a user line the CLI itself injected — a skill's content, a command
// caveat, a compaction continuation (its `isCompactSummary` lines also carry
// `isVisibleInTranscriptOnly`, so that field adds nothing), hook feedback. The
// same line-level mark skillInjectionMarker reads, on both surfaces.
export function isCliInjectedLine(obj: WireEnvelope): boolean {
  return skillInjectionMarker(obj).injected;
}

// Stamp `cliInjected: true` on the user_echo a CLI-injected line produced,
// whether or not a pending skill load matched it. Shared by the live path
// (Parser._handleUser) and transcript.ts replay, so the awaiting-user
// classifier (src/awaitingUser.ts) reads the same flag on both.
export function stampCliInjected(events: UiEvent[], source: WireEnvelope): UiEvent[] {
  if (!isCliInjectedLine(source)) return events;
  for (const ev of events) if (ev.kind === 'user_echo') ev.cliInjected = true;
  return events;
}

// `source` is the raw line: a stream-json stdout envelope live, a persisted
// jsonl object on replay.
export function attachSkillLoad(events: UiEvent[], source: WireEnvelope, pendingSkillLoads: PendingSkillLoad[] | null): UiEvent[] {
  if (!pendingSkillLoads) return events;
  for (const ev of events) {
    if (ev.kind === 'tool_result' && ev.isError) {
      const idx = pendingSkillLoads.findIndex((p) => p.toolUseId === ev.toolUseId);
      if (idx !== -1) pendingSkillLoads.splice(idx, 1);
    }
  }
  const echo = events.find((e) => e.kind === 'user_echo');
  if (!echo) return events;
  const { injected, sourceToolUseId, identityOnly } = skillInjectionMarker(source);
  if (sourceToolUseId) {
    // Exact match: this line names the Skill tool_use it was injected for.
    const idx = pendingSkillLoads.findIndex((p) => p.toolUseId === sourceToolUseId);
    if (idx !== -1) {
      const [pending] = pendingSkillLoads.splice(idx, 1);
      echo.skillLoad = { skill: pending.skill };
    }
    // Otherwise the id names nothing pending. Not "an injection for another
    // tool" — every sourceToolUseID line in the persisted corpus names a
    // Skill tool_use. It means the entry is gone or was never made: expired
    // by an intervening real turn, dropped by an erroring tool_result, or its
    // Skill tool_use sits outside the range being replayed. Either way there
    // is nothing to correlate with, so leave the queue alone (no FIFO
    // consumption) and don't expire: this isn't a real user turn.
    return events;
  }
  if (identityOnly) {
    // Distinct from the branch above: a jsonl-shaped injected line with no id
    // AT ALL — a compaction continuation or hook feedback, since every real
    // skill injection in a jsonl carries sourceToolUseID. No FIFO fallback
    // here; on this surface it could only ever mis-stamp. (An id-less skill
    // injection from some older CLI would simply not fold — same as before
    // this correlation existed, not a regression.)
    return events;
  }
  if (!injected) {
    expireSkillLoads(pendingSkillLoads);
    return events;
  }
  // Streamed injection: no identity on this surface, so fall back to the
  // CLI's synchronous tool_use -> tool_result -> injection ordering.
  if (!pendingSkillLoads.length) return events;
  const pending = pendingSkillLoads.shift();
  if (!pending) return events; // defensive — length was just checked; keeps the shift result honest
  echo.skillLoad = { skill: pending.skill };
  return events;
}

// A `user_echo` for a top-level (non-sub-agent) user prompt — i.e. one that
// marks a turn boundary. Sub-agent echoes carry a parentToolUseId. Shared by
// the event ring (instances.ts) and the paging/archive code (eventArchive.ts).
export function isOuterUserEcho(ev: UiEvent | null | undefined): boolean {
  return ev?.kind === 'user_echo' && !ev.parentToolUseId;
}

// A child at index c whose nearest preceding head sits at h forbids cuts
// h < start <= c: such a suffix includes the child but not its head. A child
// with no head at or before it forbids every cut through c. Intervals are
// per-child, not per-group, so a head arriving AFTER one of its own children
// cannot cover it — the child is pushed out instead of rendered head-less.
// Merging the integer intervals resolves all overlapping constraints at once
// instead of oscillating between groups. Each (group, head-generation) opens
// at most one interval, so the sort stays O(g log g) in practice.
function groupBoundaryComponents(arr: UiEvent[], end: number): BoundaryInterval[] {
  const intervals: BoundaryInterval[] = [];
  const groups = new Map<string, GroupState>();
  const stateFor = (id: string): GroupState => {
    let state = groups.get(id);
    if (!state) {
      state = { head: -1, interval: null };
      groups.set(id, state);
    }
    return state;
  };

  for (let i = 0; i < end; i++) {
    const ev = arr[i];
    if (!ev) continue;
    const toolUseId = typeof ev.toolUseId === 'string' ? ev.toolUseId : null;
    if (toolUseId && (ev.kind === 'tool_use_start' || ev.kind === 'tool_use')) {
      const state = stateFor(toolUseId);
      state.head = i;
      state.interval = null; // a new head opens a new generation
    }
    const parentToolUseId = typeof ev.parentToolUseId === 'string' ? ev.parentToolUseId : null;
    if (parentToolUseId) {
      const state = stateFor(parentToolUseId);
      if (state.interval) {
        state.interval.right = i; // same generation — extend to the later child
      } else {
        state.interval = {
          left: state.head >= 0 ? state.head + 1 : 0,
          right: i,
          headless: state.head < 0,
        };
        intervals.push(state.interval);
      }
    }
  }
  intervals.sort((a, b) => a.left - b.left || a.right - b.right);

  const merged: BoundaryInterval[] = [];
  for (const interval of intervals) {
    const tail = merged[merged.length - 1];
    if (!tail || interval.left > tail.right + 1) {
      merged.push({ ...interval });
      continue;
    }
    tail.right = Math.max(tail.right, interval.right);
    tail.headless ||= interval.headless;
  }
  return merged;
}

function forbiddenComponentAt(components: BoundaryInterval[], index: number): BoundaryInterval | null {
  let lo = 0, hi = components.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (components[mid].left <= index) lo = mid + 1;
    else hi = mid;
  }
  const component = components[lo - 1] ?? null;
  return component && index <= component.right ? component : null;
}

function resolveGroupBoundary(components: BoundaryInterval[], start: number): number {
  const component = forbiddenComponentAt(components, start);
  if (!component) return start;
  return component.headless ? component.right + 1 : component.left - 1;
}

// Does [start, end) hold a sub-agent child whose owning head is missing from
// arr[0, end)? Such a child can never be served from `arr` alone — the snap
// pushes the window start PAST it (see resolveGroupBoundary's headless branch)
// — so backward paging uses this to decide whether more history has to be
// loaded before the window is resolved (eventArchive.ts needArchive). Headless-
// ness is judged over [0, end), exactly as groupBoundaryComponents does, so a
// child whose head sits below `start` is servable and does NOT count.
export function hasHeadlessChildIn(arr: UiEvent[], start: number, end: number): boolean {
  end = Math.max(0, Math.min(end, arr.length));
  start = Math.max(0, Math.min(start, end));
  // A component's `right` IS a child index, so right >= start means at least
  // one of its children lies inside the window.
  return groupBoundaryComponents(arr, end).some(c => c.headless && c.right >= start);
}

// Test-only export: no production caller.
// Snap a window-start index so no sub-agent child event in [start, end) is
// orphaned: a child whose head is available pulls the start back to that head,
// a child with no head at or before it pushes the start past THAT CHILD (and
// the component it merges into) — not past its whole group, whose later
// children may still have a head above them and stay servable.
// NOT on the production path — snapshotTail (instances.ts) and
// pageInstanceEvents (eventArchive.ts) both call snapStartToQuiescent, which
// resolves the same components itself while also honoring quiescence. This
// export isolates the group resolver for direct unit testing; keep the two
// in sync by construction (both go through groupBoundaryComponents).
export function snapStartToGroupBoundary(arr: UiEvent[], start: number, end: number): number {
  end = Math.max(0, Math.min(end, arr.length));
  start = Math.max(0, Math.min(start, end));
  return resolveGroupBoundary(groupBoundaryComponents(arr, end), start);
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
// SECOND CONSUMER: Instance feeds one QuiescenceScan live from _emitUi and
// fires an armed deferred (⏸) interrupt the moment it reads empty — the same
// "nothing half-streamed, no tool unreturned" invariant, applied to a cut in
// time rather than in the array.
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
// quiescence scan — it comes from the group-boundary resolver, which moves
// the cut in EITHER direction. A child whose head is available pulls the
// start back to that head, so the chunk holds the head plus every group event
// up to its end and the next-older page ends strictly before the head. A
// child with NO head at or before it in [0, end) — head evicted from the
// ring, below the loaded archive, or simply not yet streamed — cannot be
// rendered, so the cut is pushed PAST that child instead; those events are
// unreachable by design rather than served orphaned. Either way one group's
// events — hence every nested block — are never split across chunks. Do
// NOT extend this state machine to nested blocks: it would destroy quiescent
// density across every background-task region while adding nothing the group
// snap already guarantees.

// The `${msgId}:${blockIdx}` half of a block key — the identity the client's
// renderer also keys blocks by, and what the progression retire below compares.
function blockOwner(ev: UiEvent): string { return `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}`; }
function blockKey(ev: UiEvent, type: string): string { return `${blockOwner(ev)}:${type}`; }

// An outer turn_end also force-resets (see header comment above).
function isOuterTurnEnd(ev: UiEvent): boolean {
  return ev?.kind === 'turn_end' && !ev.parentToolUseId;
}

// Null unless the event carries BOTH a msgId and a numeric blockIdx — see the
// guard note in the class comment below.
function namedBlock(ev: UiEvent): string | null {
  if (typeof ev.blockIdx !== 'number' || ev.msgId == null || ev.msgId === '') return null;
  return blockOwner(ev);
}

// TWO DISCHARGE PATHS, and the second one is why this class is not just a
// close-event bookkeeper:
//
//   1. a block's own close event (text_end / thinking_end / tool_use), plus the
//      outer user_echo / turn_end force-reset;
//   2. PROGRESSION — the appearance of a DIFFERENT `${msgId}:${blockIdx}` key
//      retires every open block that is not that key.
//
// Path 2 exists because path 1 is withholdable. A substitution backend's
// gateway can frame a stream so a close never arrives at all — a
// `content_block_start` with no `content_block.type` (the block then opens on
// its first text_delta), or a `type` of `"output_text"`: either way
// content_block_stop falls through every branch above and emits nothing, so
// the block stays open for the rest of the turn. With only path 1 that latches
// the live consumer's armed interrupt forever and the turn runs to completion
// silently. Path 2 retires such a block one block late, which is the renderer's
// own keying — a new key means the previous block is no longer streaming.
//
// PATH 2 MARKS, IT DOES NOT DELETE — and that is a statement about what a
// never-closed block IS, not a compatibility shim. Such a block is UNFINISHED,
// permanently: no close is coming, so it can never be rendered whole. A
// consumer that must show whole blocks (paging) is therefore right to keep
// counting it — a cut placed after it would end the preceding page ON a
// dangling block, which is the exact thing the snap exists to prevent. So a
// retired block stays in `openBlocks`, `empty` keeps its original meaning, and
// paging's quiescent cut indices are identical BY CONSTRUCTION on every stream.
// (Deleting instead is not a free simplification: it hands paging extra cuts
// wherever a stale block is followed by one that closes normally — measured,
// old [0,1,2] vs [0,1,2,6] on such an array. Do not "clean this up".)
// What path 2 actually publishes is `boundarySeq`, which is all the abort needs.
//
// THE GUARD IS LOAD-BEARING: the retire reads ONLY events that carry BOTH a
// msgId and a numeric blockIdx. An event that names no block — `system`,
// `tool_result`, a bare `assistant_message` — must retire nothing. A candidate
// that read progression from any event fired at index 35 of
// tests/fixtures/trace-quiescent-boundary.jsonl while Bash `3iXWNctP` ran until
// index 47. Removing the guard is how this regresses.
//
// TOOL SPANS ARE STRICT AND STAY STRICT: `pendingTools` is discharged only by a
// matching `tool_result` or a turn boundary — never by progression. Measured on
// 68,431 real outer tool spans across the identity backend and six substitution
// backends: a msgId change with a span open occurs 85 times, and all 85 spans
// are dangling (0 late-resolving), so progression would buy nothing while
// risking the one failure that discards live work. The renamed-tool-id class it
// would have covered is unattested — 0 orphan `tool_result` ids in that corpus —
// and routes to the caller-side deadline backstop instead. If it is ever seen in
// the wild, re-run the orphan-`tool_result` scan rather than re-deriving this.
//
// THE TWO CONSUMERS ASK DIFFERENT QUESTIONS, which is why only one of them
// needs `boundarySeq`. Paging asks "is state empty AT index i", evaluated
// BEFORE applying event i — and the retiring event is the same event that opens
// the next block, so no new empty index appears and quiescent cut indices are
// bit-identical with and without path 2 (measured on both a well-formed and a
// never-closed-block array). The live abort asks "has a boundary been crossed
// SINCE I ARMED", which no empty-state reading can answer — hence the counter.
// One open block: which `${msgId}:${blockIdx}` owns it, and whether it has
// already been counted as retired by path 2 (`stale`) — a stale block is still
// unfinished for `empty`'s purposes, but must not be counted a second time.
interface OpenBlock { owner: string; stale: boolean }

export class QuiescenceScan {
  openBlocks = new Map<string, OpenBlock>(); // `${msgId}:${blockIdx}:${type}` mid-stream
  pendingTools = new Set<string>();          // toolUseId awaiting its tool_result
  // Monotonic count of block retirements — its own close, a progression mark, or
  // a turn-boundary clear over blocks not already marked. THE ONLY THING PATH 2
  // PUBLISHES: read against an arm-time snapshot by
  // Instance._maybeFireArmedInterrupt, and never reset except with the whole scan.
  boundarySeq = 0;
  get empty(): boolean { return this.openBlocks.size === 0 && this.pendingTools.size === 0; }
  _open(key: string, ev: UiEvent): void {
    this.openBlocks.set(key, { owner: blockOwner(ev), stale: false });
  }
  // Path 1: a block's own close. Counts once — a block already marked stale by
  // path 2 was counted there.
  _close(key: string): void {
    const open = this.openBlocks.get(key);
    if (!open) return;
    this.openBlocks.delete(key);
    if (!open.stale) this.boundarySeq += 1;
  }
  apply(ev: UiEvent): void {
    if (!ev || ev.parentToolUseId) return; // nested — group integrity covers these
    // Path 2. Before the switch, so an event that opens a block first marks
    // whatever block it displaced and then adds its own.
    const named = namedBlock(ev);
    if (named !== null) {
      for (const open of this.openBlocks.values()) {
        if (open.stale || open.owner === named) continue;
        open.stale = true;
        this.boundarySeq += 1;
      }
    }
    switch (ev.kind) {
      case 'user_echo':
      case 'turn_end':
        for (const open of this.openBlocks.values()) if (!open.stale) this.boundarySeq += 1;
        this.openBlocks.clear(); this.pendingTools.clear(); break;
      case 'text_delta':     this._open(blockKey(ev, 'text'), ev); break;
      case 'text_end':       this._close(blockKey(ev, 'text')); break;
      case 'thinking_start':
      case 'thinking_delta': this._open(blockKey(ev, 'thinking'), ev); break;
      case 'thinking_end':   this._close(blockKey(ev, 'thinking')); break;
      case 'tool_use_start':
      case 'tool_use_input_delta':
        this._open(blockKey(ev, 'tool'), ev);
        if (typeof ev.toolUseId === 'string') this.pendingTools.add(ev.toolUseId);
        break;
      case 'tool_use': // block finalized; the SPAN stays open until tool_result
        this._close(blockKey(ev, 'tool'));
        if (typeof ev.toolUseId === 'string') this.pendingTools.add(ev.toolUseId);
        break;
      case 'tool_result':
        if (typeof ev.toolUseId === 'string') this.pendingTools.delete(ev.toolUseId);
        break;
      default: break; // message_start / system / assistant_message / … are state-neutral
    }
  }
}

// Nearest index <= i where the scan state is known: index 0 (array start),
// `resetIdx` (an externally-declared discontinuity, e.g. the archive→ring
// seam — state must never be scanned across it), or an outer
// user_echo/turn_end (both force-reset).
function nearestResetOrigin(arr: UiEvent[], i: number, resetIdx: number): number {
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
function quiesceStart(arr: UiEvent[], start: number, end: number, resetIdx: number, allowForward: boolean): number {
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

function collectQuiescentCuts(arr: UiEvent[], end: number, resetIdx: number): number[] {
  const cuts: number[] = [];
  let scan = new QuiescenceScan();
  for (let i = 0; i < end; i++) {
    if (i === resetIdx) scan = new QuiescenceScan();
    const fiat = i === resetIdx || isOuterUserEcho(arr[i]);
    if (fiat || scan.empty) cuts.push(i);
    scan.apply(arr[i]);
  }
  cuts.push(end); // the empty suffix is always a safe final fallback
  return cuts;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstCombinedBoundary(cuts: number[], components: BoundaryInterval[], from: number): number {
  let i = lowerBound(cuts, from);
  while (i < cuts.length) {
    const cut = cuts[i];
    const component = forbiddenComponentAt(components, cut);
    if (!component) return cut;
    i = lowerBound(cuts, component.right + 1);
  }
  return cuts[cuts.length - 1];
}

function lastCombinedBoundary(cuts: number[], components: BoundaryInterval[], through: number): number {
  let i = lowerBound(cuts, through + 1) - 1;
  while (i >= 0) {
    const cut = cuts[i];
    const component = forbiddenComponentAt(components, cut);
    if (!component) return cut;
    if (component.headless) return -1; // its interval starts at index 0
    i = lowerBound(cuts, component.left) - 1;
  }
  return -1;
}

// Smallest quiescent index in [from, bound), or -1. Used by EventLog._trim
// to keep the post-eviction ring head on whole blocks when no turn boundary
// is in reach. Assumes arr[0] opens on a boundary (true by induction over
// trims, except after a plain-cut last resort — a documented degradation).
export function firstQuiescentAtOrAfter(arr: UiEvent[], from: number, bound: number): number {
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

// Largest quiescent index at or below `at` (bounded, like every backward
// quiescent search here, by `at`'s own reset origin), or `at` itself when its
// turn holds none — the same "raw start stands" degradation quiesceStart
// documents. eventArchive.ts's pageCombined uses this as the backstop when
// snapStartToQuiescent rejects a whole backward window (its only content was
// headless sub-agent children): the pre-snap window start is under no
// obligation to be quiescent, so back off to the last quiescent cut instead
// of serving nothing. Instance.snapshotTail uses it the same way for a
// would-be-empty tail.
export function lastQuiescentAtOrBefore(
  arr: UiEvent[], at: number, { resetIdx = -1 }: { resetIdx?: number } = {},
): number {
  const start = Math.max(0, Math.min(at, arr.length - 1));
  if (start <= 0) return 0;
  return quiesceStart(arr, start, start + 1, resetIdx, false);
}

// Snap a window-start index to a cut that is both quiescent and preserves
// sub-agent group integrity. `resetIdx` marks the archive→ring seam inside a
// combined array (see eventArchive.ts): it resets only quiescence state, while
// group heads remain visible across the seam.
//
// Group constraints are merged before resolution. A surviving-only forbidden
// component prefers the nearest combined-valid cut on its left (keep the
// complete group); a component connected to a headless group searches right
// (exclude every unavailable group). Both searches move monotonically across
// finite quiescent cuts/components, so they cannot oscillate.
export function snapStartToQuiescent(arr: UiEvent[], start: number, end: number, { resetIdx = -1 }: { resetIdx?: number } = {}): number {
  end = Math.max(0, Math.min(end, arr.length));
  start = Math.max(0, Math.min(start, end));
  if (start === end) return end;

  const components = groupBoundaryComponents(arr, end);
  start = quiesceStart(arr, start, end, resetIdx, true);
  const component = forbiddenComponentAt(components, start);
  if (!component) return start;

  const cuts = collectQuiescentCuts(arr, end, resetIdx);
  if (component.headless) {
    return firstCombinedBoundary(cuts, components, component.right + 1);
  }

  const backward = lastCombinedBoundary(cuts, components, component.left - 1);
  if (backward >= 0) return backward;
  return firstCombinedBoundary(cuts, components, component.right + 1);
}

export default Parser;
