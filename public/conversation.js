// Conversation view. Receives parser-style UI events (kind: text_delta, etc.)
// and renders them into the DOM. Idempotent by event _seq so that snapshot
// replays don't duplicate prior content.

import { TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, SystemBlock, TurnEndBlock,
  TaskCompletionBlock, QueuedMessageBlock, UserQuestionBlock, PlanRequestBlock, PermissionRequestBlock, ImageBlock,
  shouldRenderSystem, el, parseUserQuestionAnswers, isUserQuestionAnswerText } from './blocks.js';
import { parseWakeCallback } from './wakeCallback.js';

function renderFileChip(a) {
  return el('div', { class: 'block file-attachment' },
    el('span', { class: 'fa-icon' }, '📎'),
    el('span', { class: 'fa-name' }, a.name ?? a.path ?? 'file'),
    a.path ? el('span', { class: 'fa-path' }, ` (${a.path})`) : null,
  );
}

export class Conversation {
  constructor(rootEl, {
    isSub = false,
    onUserQuestionSubmit = null,
    onPlanDecision = null,
    onPermissionDecision = null,
    describeToolCtx = {},
    // (filename) -> URL string used to source attachment thumbnails on
    // transcript replay (when the live user_echo's dataBase64 is gone).
    // Returns null when no instance is active.
    resolveAttachmentUrl = null,
    // (userMessageIndex) -> called when the user clicks the ↶ button on
    // a user bubble. Truncates the session at that point.
    onRewind = null,
    // (userMessageIndex) -> called when the user clicks the ⑂ button on
    // a user bubble. Forks a new session from the prefix up to that point.
    onFork = null,
    // (text) -> called when an outer assistant text block finalizes (text_end).
    // Wired to TTS auto-speak in app.js. Sub-conversations don't fire it.
    onAssistantText = null,
  } = {}) {
    this.root = rootEl;
    this.isSub = isSub;
    this.onUserQuestionSubmit = onUserQuestionSubmit;
    this.onPlanDecision = onPlanDecision;
    this.onPermissionDecision = onPermissionDecision;
    this.resolveAttachmentUrl = resolveAttachmentUrl;
    this.onRewind = onRewind;
    this.onFork = onFork;
    this.onAssistantText = onAssistantText;
    // Rewind/fork anchoring: each outer user_echo arrives with a
    // server-stamped absolute `userIndex` (the Nth pure user-prompt line
    // in the jsonl). The bubble exposes it via `data-user-index`. We do
    // NOT count rendered bubbles client-side — with a capped ring /
    // tail-only snapshot the view can start mid-history, so a local
    // counter would anchor rewinds against the wrong jsonl line.
    // Sub-conversations (Agent sub-agents) don't get rewind/fork buttons —
    // those operations only make sense at the outer session level.
    this._userActionsEnabled = !this.isSub;
    // Resolver-style context passed to describeToolInput so a
    // TaskUpdate tool block (whose input only carries taskId) can
    // surface the task's actual subject + description.
    this.describeToolCtx = describeToolCtx;
    this.userQuestionBlocks = new Map(); // toolUseId -> UserQuestionBlock
    this.planBlocks = new Map(); // toolUseId -> PlanRequestBlock
    this.permissionBlocks = new Map(); // toolUseId -> PermissionRequestBlock
    // Set during replay when a tool_result for AskUserQuestion is processed;
    // cleared when the following user_echo arrives carrying the answer text.
    this._pendingAnswerUQId = null;
    // True while a snapshot batch is being replayed. Used to gate markAnswered()
    // so that unrelated live echoes (e.g. idle callbacks) cannot lock an
    // unanswered question card.
    this._replayMode = false;
    this.blocksByKey = new Map();   // `${msgId}:${blockIdx}` -> block instance
    this.toolBlocks = new Map();    // toolUseId -> ToolUseBlock
    this.seenSeq = new Set();
    this.messageWraps = new Map();  // msgId -> { node, body }
    // Per-msgId reconcile cursor. The CLI splits a single logical assistant
    // message into one `assistant` envelope per content block when the
    // message contains parallel tool_uses — all those envelopes share the
    // same msgId but each puts its lone block at array iteration index 0.
    // We bump this cursor per envelope so reconciled blocks get unique
    // (msgId, idx) keys instead of all colliding at 0.
    this.reconcileCounts = new Map(); // msgId -> next idx
    // Per-parent-tool-use-id sub-conversations for routing sub-agent events.
    this.subConvs = new Map();
    // The currently-open `.msg.assistant` wrap. New assistant msgIds register
    // against this wrap until a user action (echo / question / plan /
    // permission / history divider) closes the segment, so a streak of
    // sequential tool calls renders as one bordered envelope with one label
    // instead of a new box per action.
    this._activeAssistantWrap = null;
    this._activeThinkingKey = null;
    // Merge anchors for the lazy-history bubble merge (lazyHistory.js): the
    // first assistant wrap created before ANY segment-closer rendered is
    // this chunk's leading bubble. When the chunk rendered above ends with
    // an open assistant segment, pages being contiguous means both halves
    // belong to one turn — the upper chunk's trailing blocks merge into this
    // wrap instead of leaving two adjacent assistant bubbles.
    this.leadingAssistantWrap = null;
    this._sawSegmentCloser = false;
    // Live sub-agent events whose parent Agent head sits below the rendered
    // tail (a backgrounded Agent call from an evicted/unloaded turn): parked here
    // per parent toolUseId instead of leaking to the outer level (a child
    // user_echo would render as a fake outer user bubble). Replayed in
    // arrival order by adoptToolBlock() when a lazy page brings the parent
    // block in — order preservation is what lets a multi-part nested block
    // (sub-agents interleave block parts with the outer stream) reconstruct
    // whole via the sub-conversation's normal reconcile path.
    this.orphanChildEvents = new Map();
    this.stickyBottom = true;
    if (!this.isSub) {
      this.root.addEventListener('scroll', () => {
        const nearBottom = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 50;
        this.stickyBottom = nearBottom;
      });
    }
    this._setEmpty();
  }

  _setEmpty() {
    this.root.innerHTML = '';
    if (this.isSub) { this.emptyNode = null; return; }
    const empty = el('div', { class: 'empty' }, 'no messages yet — send a prompt to start.');
    this.root.appendChild(empty);
    this.emptyNode = empty;
  }

  _ensureNotEmpty() {
    if (this.emptyNode) { this.emptyNode.remove(); this.emptyNode = null; }
  }

  clear() {
    this.blocksByKey.clear();
    this.toolBlocks.clear();
    this.seenSeq.clear();
    this.messageWraps.clear();
    this.reconcileCounts.clear();
    this.subConvs.clear();
    this.userQuestionBlocks.clear();
    this.planBlocks.clear();
    this.permissionBlocks.clear();
    this._activeAssistantWrap = null;
    this._activeThinkingKey = null;
    this.leadingAssistantWrap = null;
    this._sawSegmentCloser = false;
    this.orphanChildEvents.clear();
    this._pendingAnswerUQId = null;
    this.stickyBottom = true;
    this._setEmpty();
  }

  // Alias for clear() — invoked from app.js when a `reset_snapshot` WS
  // frame arrives (the active session was just rewound server-side).
  reset() { this.clear(); }

  // Enables/disables the rewind/fork buttons on every existing user bubble.
  // Called from app.js when the active instance flips status — during a
  // running turn the buttons should be inert (a rewind would 409 anyway).
  setUserActionsEnabled(enabled) {
    this._userActionsEnabled = !!enabled && !this.isSub;
    for (const btn of this.root.querySelectorAll('.user-msg-action')) {
      btn.disabled = !this._userActionsEnabled;
    }
  }

  _closeAssistantSegment() {
    this._activeAssistantWrap = null;
    this._sawSegmentCloser = true;
  }

  // Finalize every block that is still visually streaming. For STATIC batches
  // (lazy-history pages) only. Server pages are quiescent-aligned (whole
  // blocks, resolved tools), so this is NOT a seam patch — it covers content
  // that is genuinely dangling inside one chunk: a hard-interrupted turn
  // whose tool_result never arrived (renders `· incomplete`), and the
  // trim's plain-cut last resort (a giant non-quiescent span evicted
  // mid-block). finalize() is idempotent; markIncomplete() only touches
  // tools still awaiting input or a result.
  finalizeDanglingBlocks() {
    for (const block of this.blocksByKey.values()) block.finalize?.();
    for (const block of this.toolBlocks.values()) block.markIncomplete?.();
    for (const sub of this.subConvs.values()) sub.finalizeDanglingBlocks();
  }

  // Deliver a sub-agent event into the nested sub-conversation of its parent
  // tool block. Returns false when the parent isn't rendered here, OR when it
  // is rendered but isn't a genuine sub-agent host (name !== 'Agent' — the
  // real CLI tool name for a sub-agent invocation) — a stray/mistagged
  // parentToolUseId (e.g. a backgrounded Bash's own tool_result referencing
  // its own or another plain tool's id) must never turn that tool's bubble
  // into a "sub-agent" host. Does NOT consult seenSeq — adoptToolBlock
  // replays parked events through this path after their seqs were already
  // recorded by apply().
  _routeChildEvent(ev) {
    const parent = this.toolBlocks.get(ev.parentToolUseId);
    if (!parent || parent.name !== 'Agent') return false;
    let sub = this.subConvs.get(ev.parentToolUseId);
    if (!sub) {
      sub = new Conversation(parent.subRoot, {
        isSub: true,
        onUserQuestionSubmit: this.onUserQuestionSubmit,
        onPlanDecision: this.onPlanDecision,
        onPermissionDecision: this.onPermissionDecision,
        describeToolCtx: this.describeToolCtx,
        resolveAttachmentUrl: this.resolveAttachmentUrl,
      });
      this.subConvs.set(ev.parentToolUseId, sub);
    }
    parent.revealSubRoot();
    sub.apply(ev);
    return true;
  }

  _parkChildEvent(ev) {
    let parked = this.orphanChildEvents.get(ev.parentToolUseId);
    if (!parked) { parked = []; this.orphanChildEvents.set(ev.parentToolUseId, parked); }
    parked.push(ev);
    if (parked.length > 500) parked.shift(); // runaway-task cap, drop-oldest
  }

  // Adopt a parent tool block rendered by a lazy-history batch: register it
  // so future live children route natively, then replay this parent's parked
  // events IN ARRIVAL ORDER through the normal sub-conversation path. Order
  // is what reconstructs a multi-part nested block whole — sub-agent
  // envelopes carry one content block each and share a msgId, and the
  // sub-conversation's reconcile cursor (reconcileCounts) assigns their
  // block indices sequentially, so replaying out of order (or splitting the
  // parked run) would fragment the nested blocks.
  adoptToolBlock(toolUseId, block) {
    if (!toolUseId || !block || this.toolBlocks.has(toolUseId)) return;
    this.toolBlocks.set(toolUseId, block);
    const parked = this.orphanChildEvents.get(toolUseId);
    this.orphanChildEvents.delete(toolUseId);
    if (!parked) return;
    // The adopted block may turn out not to be a genuine sub-agent host (its
    // real name isn't 'Agent') — render those parked events as ordinary
    // top-level content instead of silently dropping them.
    for (const ev of parked) {
      if (!this._routeChildEvent(ev)) this._renderEvent(ev);
    }
  }

  applyEvents(events) {
    for (const ev of events) this.apply(ev);
  }

  apply(ev) {
    if (ev._seq != null) {
      if (this.seenSeq.has(ev._seq)) return;
      this.seenSeq.add(ev._seq);
    }
    // Route sub-agent events into a nested mini-conversation hosted inside
    // the matching outer Agent tool_use block. Inside a sub-conversation, an
    // unmatched parentToolUseId is the sub-agent's OWN Agent id — the event
    // renders locally (fall through). At the outer level, a parent id with
    // no block registered yet means the Agent head sits below the rendered
    // tail (backgrounded Agent call): PARK the event instead of leaking it to
    // the outer level; adoptToolBlock() replays it when a lazy page brings the
    // head's block in. A parent id that DOES resolve to a block, but one
    // that isn't a genuine sub-agent host (_routeChildEvent's name check
    // failed — e.g. a mistagged Bash tool_result), is neither nested nor
    // parked: it renders immediately as ordinary top-level content, same as
    // an event with no parentToolUseId at all.
    if (ev.parentToolUseId) {
      if (this._routeChildEvent(ev)) return;
      if (!this.isSub && !this.toolBlocks.has(ev.parentToolUseId)) {
        this._parkChildEvent(ev);
        return;
      }
    }
    this._renderEvent(ev);
  }

  _renderEvent(ev) {
    if (ev.kind === 'user_question') { this._renderUserQuestion(ev); return; }
    if (ev.kind === 'plan_request') { this._renderPlanRequest(ev); return; }
    if (ev.kind === 'permission_request') { this._renderPermissionRequest(ev); return; }
    if (ev.kind === 'permission_resolved') { this._resolvePermissionRequest(ev); return; }
    this._ensureNotEmpty();
    switch (ev.kind) {
      case 'user_echo': {
        // On session replay the user_echo that immediately follows an
        // AskUserQuestion tool_result carries the formatted answer text.
        // Reconstruct the selection and mark the card as answered so it
        // renders consistently with a live submission.
        // Guard: only call markAnswered() during replay (_replayMode=true) or
        // when the card was already submitted by the user (live path, no-op).
        // Without this guard an unrelated live echo — such as an idle-callback
        // prompt injected by subscribe_to_idle — would incorrectly lock an
        // unanswered card.
        // Second guard: the echo must actually be in the answer format
        // formatUserQuestionAnswers() emits. During replay an unrelated echo
        // (e.g. a wake-callback stub) can be interleaved between the tool_result
        // and the real answer echo; consuming it positionally would lock the
        // card on garbage AND drop the real answer. Only a format match marks
        // the card and consumes the slot; a non-match leaves the slot armed so
        // the later matching echo still applies.
        if (this._pendingAnswerUQId) {
          const qBlock = this.userQuestionBlocks.get(this._pendingAnswerUQId);
          if (qBlock && (this._replayMode || qBlock.submitted)
              && isUserQuestionAnswerText(qBlock.questions, ev.text)) {
            qBlock.markAnswered(parseUserQuestionAnswers(qBlock.questions, ev.text));
            this._pendingAnswerUQId = null;
          }
        }
        this._renderUserEcho(ev);
        break;
      }
      case 'text_delta':     this._appendStreamingBlock(ev, 'text', TextBlock, ev.text); break;
      case 'text_end':       this._finalizeBlock(ev); break;
      case 'thinking_start': this._renderThinkingStart(ev); break;
      case 'thinking_delta': this._appendStreamingBlock(ev, 'thinking', ThinkingBlock, ev.text); break;
      case 'thinking_end':   this._finalizeBlock(ev); break;
      case 'thinking_redacted': this._renderThinkingRedacted(ev); break;
      case 'tool_use_start': this._renderToolStart(ev); break;
      case 'tool_use_input_delta': this._renderToolInputDelta(ev); break;
      case 'tool_use':       this._renderToolFinal(ev); break;
      case 'tool_result':    this._renderToolResult(ev); break;
      case 'task_completion':
        this.root.appendChild(new TaskCompletionBlock(ev).node);
        this._maybeScroll();
        break;
      case 'history_gap':    this._renderHistoryGap(); break;
      case 'overage_message_queued':
        this.root.appendChild(new QueuedMessageBlock(ev).node);
        this._maybeScroll();
        break;
      case 'system':
        if (ev.subtype === 'thinking_tokens') {
          const n = ev.data?.estimated_tokens ?? 0;
          const block = this._activeThinkingKey
            ? this.blocksByKey.get(this._activeThinkingKey) : null;
          if (block?.updateThinkingTokens) block.updateThinkingTokens(n);
          break;
        }
        if (ev.subtype === 'history_replayed') { this._renderHistoryDivider(ev); break; }
        // Resume fired: collapse the ghost queued bubbles — they're folding into
        // the single delivered turn that follows.
        if (ev.subtype === 'auto_resume') {
          for (const n of this.root.querySelectorAll('.block.queued:not(.delivered)')) {
            n.classList.add('delivered');
          }
        }
        if (!shouldRenderSystem(ev)) break; // drop status/rate_limit/etc. noise
        this._renderSystem(ev); break;
      case 'hook':           /* dimmed hook lines dropped from the conversation */ break;
      case 'turn_end':       this._renderTurnEnd(ev); break;
      case 'assistant_message':
        // Outer turns are driven entirely by stream_event deltas; the
        // trailing assistant envelope adds nothing the UI didn't already
        // have, and running reconcile here regressed into double-rendered
        // blocks when the (msgId, blockIdx) dedup key failed to match the
        // streamed entry. Sub-agent assistant turns have no deltas, so
        // they still need the reconciliation pass — and the
        // parentToolUseId routing above has already forwarded them into
        // a sub-Conversation by the time we get here.
        if (this.isSub) this._reconcileAssistantMessage(ev);
        break;
      case 'control_response': break; // hidden from UI
      case 'raw':            this._renderSystem({ subtype: 'raw', data: { line: ev.line } }); break;
      default: break;
    }
    this._maybeScroll();
  }

  _ensureMessageWrap(msgId, role = 'assistant') {
    if (!msgId) msgId = '__floating__';
    let w = this.messageWraps.get(msgId);
    if (w) return w;
    if (role === 'assistant' && this._activeAssistantWrap) {
      this.messageWraps.set(msgId, this._activeAssistantWrap);
      return this._activeAssistantWrap;
    }
    const body = el('div', { class: 'blocks' });
    const node = el('div', { class: `msg ${role}` },
      el('div', { class: 'role' }, role),
      body,
    );
    this.root.appendChild(node);
    w = { node, body };
    this.messageWraps.set(msgId, w);
    if (role === 'assistant') {
      this._activeAssistantWrap = w;
      // First assistant wrap before any segment-closer = this chunk begins
      // mid-turn; it is the merge target for the chunk rendered above.
      if (!this._sawSegmentCloser && !this.leadingAssistantWrap) {
        this.leadingAssistantWrap = w;
      }
    }
    return w;
  }

  _renderThinkingStart(ev) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:thinking`;
    if (this.blocksByKey.has(key)) return;
    const block = new ThinkingBlock();
    this.blocksByKey.set(key, block);
    const wrap = this._ensureMessageWrap(ev.msgId, 'assistant');
    wrap.body.appendChild(block.node);
    this._activeThinkingKey = key;
  }

  _renderThinkingRedacted(ev) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:thinking`;
    let block = this.blocksByKey.get(key);
    if (!block) {
      block = new ThinkingBlock();
      this.blocksByKey.set(key, block);
      const wrap = this._ensureMessageWrap(ev.msgId, 'assistant');
      wrap.body.appendChild(block.node);
    }
    block.markRedacted();
  }

  _renderUserEcho(ev) {
    const blocks = el('div', { class: 'blocks' });
    let text = ev.text ?? '';

    // Skill-content injection: the CLI dumps the invoked skill's SKILL.md
    // back as a plain user message. The parser only sets `skillLoad` when it
    // has correlated this message with a preceding Skill tool_use (see
    // attachSkillLoad in src/parser.js) — isSynthetic alone isn't reliable,
    // since the CLI reuses it for compaction-continuation and Stop-hook
    // feedback text too. Render a collapsed bubble named after the actual
    // invoked skill; the raw content goes in an expandable body.
    const skill = ev.skillLoad;
    if (skill) {
      const details = el('details', { class: 'block skill' },
        el('summary', {}, '📘 ', el('span', { class: 'skill-name' }, `Loading skill: ${skill.skill ?? 'skill'}`)),
        el('pre', { class: 'block text' }, text),
      );
      blocks.appendChild(details);
    }

    // Idle-subscription wake callback: the orchestrator folds the worker's
    // recent output into the injected prompt. Render a collapsed bubble — the
    // summary line stays visible, the folded get_recent_messages payload goes in
    // an expandable body (default collapsed). Marker sentinels never render.
    const wake = skill ? null : parseWakeCallback(text);
    if (wake) {
      // Badge marks this as an orchestrator-injected wake, not a user message
      // (mirrors the transcribed-badge pattern below).
      const badge = el('span', { class: 'wake-badge', title: 'Orchestrator wake' }, '🔔');
      if (wake.body) {
        // Folded stub — collapsible <details> holding the get_recent_messages payload.
        const details = el('details', { class: 'block wake' },
          el('summary', {}, badge, wake.summary),
          el('div', { class: 'block text' }, wake.body),
        );
        blocks.appendChild(details);
      } else {
        // Body-less plain stub (timeout / mid-turn) — just the summary line, no caret.
        blocks.appendChild(el('div', { class: 'block wake plain' }, badge, wake.summary));
      }
    }

    // Strip the <transcribed> marker for display — the agent still receives it
    // in the sent payload so it knows the message came from speech-to-text.
    const TRANSCRIBED_PREFIX = '<transcribed>\n';
    const isTranscribed = !skill && !wake && text.startsWith(TRANSCRIBED_PREFIX);
    if (isTranscribed) text = text.slice(TRANSCRIBED_PREFIX.length);

    if (!skill && !wake && text.length) blocks.appendChild(el('div', { class: 'block text' }, text));
    for (const a of (ev.attachments ?? [])) {
      if (a?.kind === 'image') {
        if (typeof a.dataBase64 === 'string') {
          // Live echo — bytes are in memory, render immediately.
          blocks.appendChild(new ImageBlock(a).node);
        } else if (a.filename && this.resolveAttachmentUrl) {
          // Replay path — fetch from the orchestrator's attachments endpoint.
          const src = this.resolveAttachmentUrl(a.filename);
          if (src) blocks.appendChild(new ImageBlock({ name: a.name, src }).node);
          else blocks.appendChild(renderFileChip(a));
        } else {
          blocks.appendChild(renderFileChip(a));
        }
      } else if (a?.kind === 'file') {
        blocks.appendChild(renderFileChip(a));
      }
    }
    if (!blocks.childNodes.length) {
      // Defensive — never produce an empty user bubble.
      blocks.appendChild(el('div', { class: 'block text' }, ''));
    }
    // Server-stamped absolute ordinal (see constructor comment). An echo
    // without one (e.g. an orphaned sub-agent echo rendered at the outer
    // level) gets no rewind/fork buttons — guessing an index could
    // truncate the session at the wrong line.
    const userIndex = Number.isInteger(ev.userIndex) ? ev.userIndex : null;
    const roleEl = el('div', { class: 'role' }, 'user');
    if (isTranscribed) {
      roleEl.appendChild(el('span', { class: 'transcribed-badge', title: 'Transcribed from voice' }, '🎤'));
    }
    const cls = wake ? 'msg user wake-callback' : 'msg user';
    const wrap = el('div',
      userIndex != null
        ? { class: cls, 'data-user-index': String(userIndex) }
        : { class: cls },
      roleEl,
      blocks,
    );
    // Hover-revealed rewind / fork affordances — only on the outer
    // conversation (sub-agent transcripts never get them). The buttons stay
    // visually hidden until the bubble is hovered; CSS lives in styles.css
    // under `.user-msg-actions` (mirrors the `.session-delete` pattern).
    if (!this.isSub && userIndex != null && (this.onRewind || this.onFork)) {
      const actions = el('div', { class: 'user-msg-actions' });
      if (this.onRewind) {
        const btn = el('button', {
          type: 'button',
          class: 'user-msg-action user-msg-rewind',
          title: 'Rewind to before this message (drops everything after, prefills the composer with this prompt)',
        }, '↶');
        btn.disabled = !this._userActionsEnabled;
        btn.addEventListener('click', () => this.onRewind && this.onRewind(userIndex));
        actions.appendChild(btn);
      }
      if (this.onFork) {
        const btn = el('button', {
          type: 'button',
          class: 'user-msg-action user-msg-fork',
          title: 'Fork a new session at this point (original session is preserved, composer is prefilled with this prompt)',
        }, '⑂');
        btn.disabled = !this._userActionsEnabled;
        btn.addEventListener('click', () => this.onFork && this.onFork(userIndex));
        actions.appendChild(btn);
      }
      wrap.appendChild(actions);
    }
    this.root.appendChild(wrap);
    this._closeAssistantSegment();
  }

  _appendStreamingBlock(ev, type, BlockClass, deltaText) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:${type}`;
    let block = this.blocksByKey.get(key);
    if (!block) {
      block = new BlockClass();
      this.blocksByKey.set(key, block);
      const wrap = this._ensureMessageWrap(ev.msgId, 'assistant');
      wrap.body.appendChild(block.node);
    }
    block.appendDelta(deltaText);
  }

  _finalizeBlock(ev) {
    const t = ev.kind === 'text_end' ? 'text' : 'thinking';
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:${t}`;
    const block = this.blocksByKey.get(key);
    if (block?.finalize) block.finalize();
    if (t === 'thinking') this._activeThinkingKey = null;
    // Auto-speak finalized assistant text (outer conversation only — sub-agent
    // chatter isn't read aloud). Gating on enabled/availability/user-gesture
    // lives in the callback (autoSpeakBlock).
    if (ev.kind === 'text_end' && !this.isSub && block?.buffer) {
      this.onAssistantText?.(block);
    }
  }

  _renderToolStart(ev) {
    // toolUseId is globally unique per session — when present, it's the
    // authoritative dedup key. Sequential tool_use blocks within the same
    // logical assistant msgId (the CLI emits them as separate envelopes each
    // at index 0, both in the live stream_event path and in the persisted-
    // jsonl replay path) all share (msgId, blockIdx) but carry distinct
    // toolUseIds — a (msgId, idx) check would drop every block past the
    // first and orphan their tool_results into a floating wrap.
    if (ev.toolUseId) {
      if (this.toolBlocks.has(ev.toolUseId)) return;
    } else {
      const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:tool`;
      if (this.blocksByKey.has(key)) return;
    }
    const block = new ToolUseBlock({
      name: ev.name, toolUseId: ev.toolUseId,
      describeCtx: this.describeToolCtx,
    });
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:tool`;
    this.blocksByKey.set(key, block);
    if (ev.toolUseId) this.toolBlocks.set(ev.toolUseId, block);
    const wrap = this._ensureMessageWrap(ev.msgId, 'assistant');
    wrap.body.appendChild(block.node);
  }

  _renderToolInputDelta(ev) {
    const block = this.toolBlocks.get(ev.toolUseId);
    if (block) block.appendInputDelta(ev.partialJson ?? '');
  }

  _renderToolFinal(ev) {
    let block = this.toolBlocks.get(ev.toolUseId);
    if (!block) {
      this._renderToolStart(ev);
      block = this.toolBlocks.get(ev.toolUseId);
    }
    if (block) {
      block.setName(ev.name);
      block.finalizeInput(ev.input, ev.startedAt);
    }
  }

  _renderToolResult(ev) {
    const block = this.toolBlocks.get(ev.toolUseId);
    const result = new ToolResultBlock(ev);
    if (block) block.attachResult(result, ev.finishedAt);
    else {
      const wrap = this._ensureMessageWrap(null, 'assistant');
      wrap.body.appendChild(result.node);
    }
    // When the result is for an unanswered AskUserQuestion block, the
    // following user_echo carries the formatted answer text. Record the
    // toolUseId so _renderUserEcho can reconstruct the selection.
    const qBlock = this.userQuestionBlocks.get(ev.toolUseId);
    if (qBlock && !qBlock.submitted) {
      this._pendingAnswerUQId = ev.toolUseId;
    }
  }

  // Sub-agent assistant turns arrive on the same stream as the outer turn but
  // only as a complete `assistant` envelope (tagged with parent_tool_use_id);
  // no per-block `stream_event` deltas are emitted for them. Without this
  // reconciliation pass the sub-agent's tool_use content blocks never reach
  // the DOM and the matching tool_result lands as a floating block.
  //
  // Idempotent: when stream-event deltas DID populate blocksByKey (the outer
  // turn), the per-block existence check skips re-rendering, so a second
  // finalizeInput can't clobber a tool block whose status was already flipped
  // to 'done' by an attached result.
  _reconcileAssistantMessage(ev) {
    const msgId = ev.msgId;
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const base = this.reconcileCounts.get(msgId) ?? 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      const idx = base + i;
      if (b.type === 'tool_use') {
        if (b.id && this.toolBlocks.has(b.id)) continue;
        this._renderToolStart({ msgId, blockIdx: idx, toolUseId: b.id, name: b.name });
        this._renderToolFinal({ msgId, blockIdx: idx, toolUseId: b.id, name: b.name, input: b.input ?? {} });
      } else if (b.type === 'text') {
        const key = `${msgId ?? '?'}:${idx}:text`;
        if (this.blocksByKey.has(key)) continue;
        this._appendStreamingBlock({ msgId, blockIdx: idx }, 'text', TextBlock, b.text ?? '');
        this._finalizeBlock({ kind: 'text_end', msgId, blockIdx: idx });
      } else if (b.type === 'thinking') {
        const key = `${msgId ?? '?'}:${idx}:thinking`;
        if (this.blocksByKey.has(key)) continue;
        const txt = b.thinking ?? b.text ?? '';
        this._renderThinkingStart({ msgId, blockIdx: idx });
        if (txt) this._appendStreamingBlock({ msgId, blockIdx: idx }, 'thinking', ThinkingBlock, txt);
        else this._renderThinkingRedacted({ msgId, blockIdx: idx });
        this._finalizeBlock({ kind: 'thinking_end', msgId, blockIdx: idx });
      }
    }
    this.reconcileCounts.set(msgId, base + blocks.length);
  }

  _renderPlanRequest(ev) {
    this._ensureNotEmpty();
    if (this.planBlocks.has(ev.toolUseId)) return;
    // The server marks `ev.autoApproved=true` when its per-instance
    // auto-approve flag fired — the mode flip + approval prompt have
    // already been sent on the wire, so the card just renders as a
    // display-only "auto-approved" tile here. No client callback needed.
    const autoApproved = !!ev.autoApproved;
    const block = new PlanRequestBlock(ev, (decision) => {
      if (this.onPlanDecision) this.onPlanDecision(decision);
    }, { autoApproved });
    this.planBlocks.set(ev.toolUseId, block);
    this.root.appendChild(block.node);
    this._closeAssistantSegment();
    this._maybeScroll();
  }

  _renderUserQuestion(ev) {
    this._ensureNotEmpty();
    if (this.userQuestionBlocks.has(ev.toolUseId)) return;
    const block = new UserQuestionBlock(ev, (submission) => {
      if (this.onUserQuestionSubmit) this.onUserQuestionSubmit(submission);
    });
    this.userQuestionBlocks.set(ev.toolUseId, block);
    this.root.appendChild(block.node);
    this._closeAssistantSegment();
    this._maybeScroll();
  }

  _renderPermissionRequest(ev) {
    this._ensureNotEmpty();
    if (this.permissionBlocks.has(ev.toolUseId)) return;
    const block = new PermissionRequestBlock(ev, (decision) => {
      if (this.onPermissionDecision) this.onPermissionDecision(decision);
    });
    this.permissionBlocks.set(ev.toolUseId, block);
    this.root.appendChild(block.node);
    this._closeAssistantSegment();
    this._maybeScroll();
  }

  _resolvePermissionRequest(ev) {
    const block = this.permissionBlocks.get(ev.toolUseId);
    if (block) block.markResolved(!!ev.allow);
  }

  // Evicted-content seam (server-injected `history_gap`, eventArchive.js):
  // whole blocks are genuinely missing here — never a half block. Closing
  // the assistant segment also makes this a merge barrier: content across a
  // real gap must not glue into one bubble.
  _renderHistoryGap() {
    const node = el('div', { class: 'history-divider history-gap' },
      el('span', {}, '── ⋯ earlier messages unavailable ──'));
    this.root.appendChild(node);
    this._closeAssistantSegment();
  }

  _renderHistoryDivider(ev) {
    const count = ev.data?.count ?? 0;
    const node = el('div', { class: 'history-divider' },
      el('span', {}, `── ${count} prior message${count === 1 ? '' : 's'} replayed — new turn below ──`));
    this.root.appendChild(node);
    this._closeAssistantSegment();
  }

  _renderSystem(ev) {
    // Render each kept system event INLINE at its chronological position
    // rather than into a shared '__system__' wrap. The old shared-wrap
    // approach caused later turns' system events to silently extend the
    // single SYSTEM box at the top of the conversation, drifting out of
    // sync with where they actually occurred in the stream.
    this.root.appendChild(new SystemBlock(ev).node);
  }

  _renderTurnEnd(ev) {
    const wrap = el('div', {});
    wrap.appendChild(new TurnEndBlock(ev).node);
    this.root.appendChild(wrap);
  }

  _maybeScroll() {
    if (this.stickyBottom) this.root.scrollTop = this.root.scrollHeight;
  }
}
