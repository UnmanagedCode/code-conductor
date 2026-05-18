// Conversation view. Receives parser-style UI events (kind: text_delta, etc.)
// and renders them into the DOM. Idempotent by event _seq so that snapshot
// replays don't duplicate prior content.

import { TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, SystemBlock, TurnEndBlock,
  UserQuestionBlock, PlanRequestBlock, PermissionRequestBlock, ImageBlock,
  shouldRenderSystem, el } from './blocks.js';

export class Conversation {
  constructor(rootEl, {
    isSub = false,
    onUserQuestionSubmit = null,
    onPlanDecision = null,
    onPermissionDecision = null,
    describeToolCtx = {},
  } = {}) {
    this.root = rootEl;
    this.isSub = isSub;
    this.onUserQuestionSubmit = onUserQuestionSubmit;
    this.onPlanDecision = onPlanDecision;
    this.onPermissionDecision = onPermissionDecision;
    // Resolver-style context passed to describeToolInput so a
    // TaskUpdate tool block (whose input only carries taskId) can
    // surface the task's actual subject + description.
    this.describeToolCtx = describeToolCtx;
    this.userQuestionBlocks = new Map(); // toolUseId -> UserQuestionBlock
    this.planBlocks = new Map(); // toolUseId -> PlanRequestBlock
    this.permissionBlocks = new Map(); // toolUseId -> PermissionRequestBlock
    this.blocksByKey = new Map();   // `${msgId}:${blockIdx}` -> block instance
    this.toolBlocks = new Map();    // toolUseId -> ToolUseBlock
    this.seenSeq = new Set();
    this.messageWraps = new Map();  // msgId -> { node, body }
    // Per-parent-tool-use-id sub-conversations for routing sub-agent events.
    this.subConvs = new Map();
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
    this.subConvs.clear();
    this.userQuestionBlocks.clear();
    this.planBlocks.clear();
    this.permissionBlocks.clear();
    this._setEmpty();
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
    // the matching outer tool_use block (typically a Task call).
    if (ev.parentToolUseId) {
      const parent = this.toolBlocks.get(ev.parentToolUseId);
      if (parent) {
        let sub = this.subConvs.get(ev.parentToolUseId);
        if (!sub) {
          sub = new Conversation(parent.subRoot, {
            isSub: true,
            onUserQuestionSubmit: this.onUserQuestionSubmit,
            onPlanDecision: this.onPlanDecision,
            onPermissionDecision: this.onPermissionDecision,
            describeToolCtx: this.describeToolCtx,
          });
          this.subConvs.set(ev.parentToolUseId, sub);
        }
        parent.revealSubRoot();
        sub.apply(ev);
        return;
      }
    }
    if (ev.kind === 'user_question') { this._renderUserQuestion(ev); return; }
    if (ev.kind === 'plan_request') { this._renderPlanRequest(ev); return; }
    if (ev.kind === 'permission_request') { this._renderPermissionRequest(ev); return; }
    if (ev.kind === 'permission_resolved') { this._resolvePermissionRequest(ev); return; }
    this._ensureNotEmpty();
    switch (ev.kind) {
      case 'user_echo':      this._renderUserEcho(ev); break;
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
      case 'system':
        if (ev.subtype === 'history_replayed') { this._renderHistoryDivider(ev); break; }
        if (!shouldRenderSystem(ev)) break; // drop status/rate_limit/etc. noise
        this._renderSystem(ev); break;
      case 'hook':           /* dimmed hook lines dropped from the conversation */ break;
      case 'turn_end':       this._renderTurnEnd(ev); break;
      case 'assistant_message': break; // reconciled via deltas already
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
    const body = el('div', { class: 'blocks' });
    const node = el('div', { class: `msg ${role}` },
      el('div', { class: 'role' }, role),
      body,
    );
    this.root.appendChild(node);
    w = { node, body };
    this.messageWraps.set(msgId, w);
    return w;
  }

  _renderThinkingStart(ev) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:thinking`;
    if (this.blocksByKey.has(key)) return;
    const block = new ThinkingBlock();
    this.blocksByKey.set(key, block);
    const wrap = this._ensureMessageWrap(ev.msgId, 'assistant');
    wrap.body.appendChild(block.node);
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
    block.body.textContent = '(thinking content is internal to this model — only the signature is streamed)';
    const summary = block.node.querySelector('summary');
    if (summary) summary.textContent = 'thinking (redacted by model)';
  }

  _renderUserEcho(ev) {
    const blocks = el('div', { class: 'blocks' });
    const text = ev.text ?? '';
    if (text.length) blocks.appendChild(el('div', { class: 'block text' }, text));
    for (const a of (ev.attachments ?? [])) {
      if (a?.kind === 'image' && typeof a.dataBase64 === 'string') {
        blocks.appendChild(new ImageBlock(a).node);
      } else if (a?.kind === 'file' && typeof a.path === 'string') {
        blocks.appendChild(el('div', { class: 'block file-attachment' },
          el('span', { class: 'fa-icon' }, '📎'),
          el('span', { class: 'fa-name' }, a.name ?? a.path),
          el('span', { class: 'fa-path' }, ` (${a.path})`),
        ));
      }
    }
    if (!blocks.childNodes.length) {
      // Defensive — never produce an empty user bubble.
      blocks.appendChild(el('div', { class: 'block text' }, ''));
    }
    const wrap = el('div', { class: 'msg user' },
      el('div', { class: 'role' }, 'user'),
      blocks,
    );
    this.root.appendChild(wrap);
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
  }

  _renderToolStart(ev) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:tool`;
    let block = this.blocksByKey.get(key);
    if (block) return;
    block = new ToolUseBlock({
      name: ev.name, toolUseId: ev.toolUseId,
      describeCtx: this.describeToolCtx,
    });
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
      block.finalizeInput(ev.input);
    }
  }

  _renderToolResult(ev) {
    const block = this.toolBlocks.get(ev.toolUseId);
    const result = new ToolResultBlock(ev);
    if (block) block.attachResult(result);
    else {
      const wrap = this._ensureMessageWrap(null, 'assistant');
      wrap.body.appendChild(result.node);
    }
  }

  _renderPlanRequest(ev) {
    this._ensureNotEmpty();
    if (this.planBlocks.has(ev.toolUseId)) return;
    const block = new PlanRequestBlock(ev, (decision) => {
      if (this.onPlanDecision) this.onPlanDecision(decision);
    });
    this.planBlocks.set(ev.toolUseId, block);
    this.root.appendChild(block.node);
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
    this._maybeScroll();
  }

  _resolvePermissionRequest(ev) {
    const block = this.permissionBlocks.get(ev.toolUseId);
    if (block) block.markResolved(!!ev.allow);
  }

  _renderHistoryDivider(ev) {
    const count = ev.data?.count ?? 0;
    const node = el('div', { class: 'history-divider' },
      el('span', {}, `── ${count} prior message${count === 1 ? '' : 's'} replayed — new turn below ──`));
    this.root.appendChild(node);
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
