// Conversation view. Receives parser-style UI events (kind: text_delta, etc.)
// and renders them into the DOM. Idempotent by event _seq so that snapshot
// replays don't duplicate prior content.

import { TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, SystemBlock, TurnEndBlock, el } from './blocks.js';

export class Conversation {
  constructor(rootEl) {
    this.root = rootEl;
    this.blocksByKey = new Map();   // `${msgId}:${blockIdx}` -> block instance
    this.toolBlocks = new Map();    // toolUseId -> ToolUseBlock
    this.seenSeq = new Set();
    this.messageWraps = new Map();  // msgId -> { node, body }
    this.stickyBottom = true;
    this.root.addEventListener('scroll', () => {
      const nearBottom = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 50;
      this.stickyBottom = nearBottom;
    });
    this._setEmpty();
  }

  _setEmpty() {
    this.root.innerHTML = '';
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
        this._renderSystem(ev); break;
      case 'hook':           this._renderSystem({ ...ev, subtype: 'hook:' + ev.event, data: ev.data }); break;
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
    const wrap = el('div', { class: 'msg user' },
      el('div', { class: 'role' }, 'user'),
      el('div', { class: 'blocks' }, el('div', { class: 'block text' }, ev.text ?? '')),
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
    block = new ToolUseBlock({ name: ev.name, toolUseId: ev.toolUseId });
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

  _renderHistoryDivider(ev) {
    const count = ev.data?.count ?? 0;
    const node = el('div', { class: 'history-divider' },
      el('span', {}, `── ${count} prior message${count === 1 ? '' : 's'} replayed — new turn below ──`));
    this.root.appendChild(node);
  }

  _renderSystem(ev) {
    const wrap = this._ensureMessageWrap('__system__', 'system');
    wrap.body.appendChild(new SystemBlock(ev).node);
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
