// Renderers for individual content blocks. Each renderer returns an HTMLElement
// and exposes appendDelta(text) / finalize() methods used by the conversation
// merger when streaming deltas arrive.

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export class TextBlock {
  constructor() {
    this.body = el('div', { class: 'block text' });
    this.node = this.body;
  }
  appendDelta(text) { this.body.appendChild(document.createTextNode(text)); }
  finalize() {}
}

export class ThinkingBlock {
  constructor() {
    this.body = el('div', { class: 'body' });
    const det = el('details', { class: 'block thinking' },
      el('summary', {}, 'thinking'),
      this.body,
    );
    this.node = det;
  }
  appendDelta(text) { this.body.appendChild(document.createTextNode(text)); }
  finalize() {
    const len = this.body.textContent.length;
    const summary = this.node.querySelector('summary');
    summary.textContent = `thinking (${len} chars)`;
  }
}

import { lineDiff, diffStats } from './diff.js';

// Per-tool one-line description for the collapsed summary.
// Returns a short string with the most-useful argument for the tool.
export function describeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const trunc = (s, n = 120) => {
    if (typeof s !== 'string') return '';
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
  };
  switch (name) {
    case 'Bash':       return trunc(input.command);
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit': {
      const base = trunc(input.file_path ?? input.notebook_path);
      if (name === 'Read' && input.offset != null) return `${base}  [offset=${input.offset}, limit=${input.limit ?? '?'}]`;
      return base;
    }
    case 'Glob':       return trunc(input.pattern + (input.path ? `   in ${input.path}` : ''));
    case 'Grep':       return trunc(input.pattern + (input.path ? `   in ${input.path}` : ''));
    case 'WebFetch':   return trunc(input.url);
    case 'WebSearch':  return trunc(input.query);
    case 'Task':       return trunc(input.subagent_type ? `[${input.subagent_type}] ${input.description ?? input.prompt ?? ''}` : (input.description ?? input.prompt ?? ''));
    case 'Skill':      return trunc(input.skill ?? input.name);
    case 'TaskCreate':
    case 'TaskUpdate': return trunc(input.subject ?? input.description ?? input.taskId);
    case 'AskUserQuestion': return trunc(input.questions?.[0]?.question);
    case 'TodoWrite':
    case 'Write':      return trunc(input.file_path ?? '');
  }
  // Generic fallback: first string-valued field.
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) return `${k}=${trunc(v, 100)}`;
  }
  return '';
}

export class ToolUseBlock {
  constructor({ name, toolUseId }) {
    this.name = name; this.toolUseId = toolUseId;
    this.partialJson = '';
    this.input = null;
    this.status = 'streaming…';

    this.summary = el('summary', {});
    this.body = el('div', { class: 'tool-body' });
    // Sub-agents (Task tool) stream their own events into here under
    // parent_tool_use_id — rendered as a nested mini-conversation.
    this.subRoot = el('div', { class: 'sub-conversation', hidden: true });
    // Collapsed by default so the conversation stays scannable; the summary
    // line always carries the tool name + key argument so the user knows
    // what's running without expanding.
    this.node = el('details', { class: 'block tool' }, this.summary, this.body, this.subRoot);
    this._renderSummary();
    this._renderBody();
  }
  revealSubRoot() {
    if (this.subRoot.hasAttribute('hidden')) this.subRoot.removeAttribute('hidden');
    if (!this.node.open) this.node.open = true;
  }

  setName(name) {
    if (name) this.name = name;
    this._renderSummary();
    this._renderBody();
  }

  appendInputDelta(partial) {
    this.partialJson += partial;
    let parsed = null;
    try { parsed = JSON.parse(this.partialJson); } catch { /* not yet complete */ }
    if (parsed && typeof parsed === 'object') {
      this.input = parsed;
      this._renderSummary();
    }
    this._renderBody();
  }

  finalizeInput(input) {
    this.input = input;
    this.status = 'ready';
    this._renderSummary();
    this._renderBody();
  }

  attachResult(resultBlock) {
    this.node.appendChild(resultBlock.node);
    this.status = resultBlock.isError ? 'errored' : 'done';
    this._renderSummary();
  }

  _renderSummary() {
    const desc = this.input ? describeToolInput(this.name, this.input) : '';
    this.summary.textContent = '';
    this.summary.append('🔧 ', el('span', { class: 'tool-name' }, this.name ?? 'tool'));
    if (desc) this.summary.append(' · ', el('span', { class: 'tool-arg' }, desc));
    this.summary.append(el('span', { class: 'tool-status' }, ` · ${this.status}`));
  }

  _renderBody() {
    this.body.textContent = '';
    const input = this.input;
    if (!input) {
      // While streaming the JSON, show what we have raw.
      if (this.partialJson) this.body.appendChild(el('pre', {}, this.partialJson));
      return;
    }
    // Specialty renderers per tool. Fall back to pretty-printed JSON.
    if (this.name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      this.body.appendChild(renderEditDiff(input));
      return;
    }
    if (this.name === 'Write' && typeof input.content === 'string') {
      this.body.appendChild(renderWritePreview(input));
      return;
    }
    if (this.name === 'NotebookEdit' && typeof input.new_source === 'string') {
      this.body.appendChild(renderNotebookEdit(input));
      return;
    }
    try { this.body.appendChild(el('pre', {}, JSON.stringify(input, null, 2))); }
    catch { this.body.appendChild(el('pre', {}, this.partialJson)); }
  }
}

function renderEditDiff(input) {
  const ops = lineDiff(input.old_string, input.new_string);
  const { adds, dels } = diffStats(ops);
  const wrap = el('div', { class: 'diff' },
    el('div', { class: 'diff-head' },
      el('span', { class: 'diff-path' }, input.file_path ?? ''),
      el('span', { class: 'diff-stats' }, `+${adds} −${dels}`),
    ));
  const body = el('div', { class: 'diff-body' });
  for (const o of ops) {
    body.appendChild(el('div', { class: `diff-line ${o.op === '+' ? 'add' : o.op === '-' ? 'del' : 'ctx'}` },
      el('span', { class: 'diff-marker' }, o.op === '+' ? '+' : o.op === '-' ? '-' : ' '),
      el('span', { class: 'diff-text' }, o.text),
    ));
  }
  wrap.appendChild(body);
  return wrap;
}

function renderWritePreview(input) {
  const lines = (input.content ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const wrap = el('div', { class: 'diff' },
    el('div', { class: 'diff-head' },
      el('span', { class: 'diff-path' }, input.file_path ?? ''),
      el('span', { class: 'diff-stats' }, `${lines.length} line${lines.length === 1 ? '' : 's'}`),
    ));
  const body = el('div', { class: 'diff-body' });
  for (let i = 0; i < lines.length; i++) {
    body.appendChild(el('div', { class: 'diff-line ctx' },
      el('span', { class: 'diff-marker' }, String(i + 1).padStart(3, ' ')),
      el('span', { class: 'diff-text' }, lines[i]),
    ));
  }
  wrap.appendChild(body);
  return wrap;
}

function renderNotebookEdit(input) {
  const oldSrc = input.old_source ?? '';
  const newSrc = input.new_source ?? '';
  const ops = lineDiff(oldSrc, newSrc);
  const { adds, dels } = diffStats(ops);
  const label = `${input.notebook_path ?? ''}${input.cell_id ? ` · cell ${input.cell_id}` : ''}${input.edit_mode ? ` · ${input.edit_mode}` : ''}`;
  const wrap = el('div', { class: 'diff' },
    el('div', { class: 'diff-head' },
      el('span', { class: 'diff-path' }, label),
      el('span', { class: 'diff-stats' }, `+${adds} −${dels}`),
    ));
  const body = el('div', { class: 'diff-body' });
  for (const o of ops) {
    body.appendChild(el('div', { class: `diff-line ${o.op === '+' ? 'add' : o.op === '-' ? 'del' : 'ctx'}` },
      el('span', { class: 'diff-marker' }, o.op === '+' ? '+' : o.op === '-' ? '-' : ' '),
      el('span', { class: 'diff-text' }, o.text),
    ));
  }
  wrap.appendChild(body);
  return wrap;
}

export const _internalRenderers = { renderEditDiff, renderWritePreview, renderNotebookEdit };

export class PermissionRequestBlock {
  constructor(ev, onDecision) {
    this.requestId = ev.requestId;
    this.onDecision = onDecision;
    const title = ev.title || `Allow tool: ${ev.toolName ?? 'unknown'}?`;
    const desc = ev.displayName || ev.description || '';
    const argLine = describeToolInput(ev.toolName, ev.input);

    this.statusNode = el('span', { class: 'perm-status' }, 'awaiting decision');
    this.allowBtn = el('button', { class: 'perm-allow' }, 'Allow');
    this.denyBtn = el('button', { class: 'perm-deny' }, 'Deny');

    this.allowBtn.addEventListener('click', () => this._click(true));
    this.denyBtn.addEventListener('click', () => this._click(false));

    let argsNode;
    if (ev.toolName === 'Edit' && typeof ev.input?.old_string === 'string' && typeof ev.input?.new_string === 'string') {
      argsNode = renderEditDiff(ev.input);
    } else if (ev.toolName === 'Write' && typeof ev.input?.content === 'string') {
      argsNode = renderWritePreview(ev.input);
    } else if (ev.toolName === 'NotebookEdit' && typeof ev.input?.new_source === 'string') {
      argsNode = renderNotebookEdit(ev.input);
    } else {
      let json = '';
      try { json = JSON.stringify(ev.input ?? {}, null, 2); } catch { json = String(ev.input); }
      argsNode = el('pre', {}, json);
    }

    this.node = el('div', { class: 'block permission' },
      el('div', { class: 'perm-head' },
        el('span', { class: 'perm-title' }, title),
        this.statusNode,
      ),
      desc ? el('div', { class: 'perm-desc' }, desc) : null,
      argLine ? el('div', { class: 'perm-arg' }, argLine) : null,
      argsNode,
      el('div', { class: 'perm-actions' }, this.allowBtn, this.denyBtn),
    );
  }
  _click(allow) {
    this.allowBtn.disabled = true;
    this.denyBtn.disabled = true;
    this.statusNode.textContent = 'sending…';
    if (this.onDecision) this.onDecision({ allow });
  }
  markResolved(allow) {
    this.node.classList.add(allow ? 'allowed' : 'denied');
    this.statusNode.textContent = allow ? '✓ allowed' : '✗ denied';
    this.allowBtn.disabled = true;
    this.denyBtn.disabled = true;
  }
}

export class ToolResultBlock {
  constructor({ content, isError, toolUseId }) {
    this.toolUseId = toolUseId; this.isError = isError;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(b => b?.text ?? '').filter(Boolean).join('\n')
        : JSON.stringify(content);
    const TRUNC = 4000;
    const truncated = text.length > TRUNC;
    const pre = el('pre', {}, truncated ? text.slice(0, TRUNC) + '\n…(truncated)' : text);
    const summary = el('summary', {}, isError ? '↪ tool_result (error)' : '↪ tool_result');
    const det = el('details', { class: 'block tool-result' + (isError ? ' error' : ''), open: !isError && text.length < 600 },
      summary, pre,
    );
    if (truncated) {
      const showFull = el('button', { type: 'button', onclick: () => { pre.textContent = text; showFull.remove(); } }, 'show full');
      det.appendChild(showFull);
    }
    this.node = det;
  }
}

export class SystemBlock {
  constructor({ subtype, data }) {
    const detail = (() => {
      if (subtype === 'init') return `model=${data?.model ?? '?'} sid=${data?.session_id?.slice(0,8) ?? '?'}`;
      if (subtype === 'stderr') return data?.line ?? '';
      if (subtype === 'exit') return `code=${data?.code} signal=${data?.signal ?? '-'}`;
      try { return JSON.stringify(data).slice(0, 200); } catch { return ''; }
    })();
    this.node = el('div', { class: 'block system' },
      el('span', { class: 'subtype' }, subtype),
      ` ${detail}`,
    );
  }
}

export class TurnEndBlock {
  constructor({ subtype, durationMs, cost, usage, isError, stopReason }) {
    const parts = [
      isError ? '❌ turn ended' : '✓ turn ended',
      stopReason ? `(${stopReason})` : '',
      durationMs != null ? `${durationMs}ms` : '',
      cost != null ? `$${cost.toFixed(4)}` : '',
      usage ? `in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'}` : '',
    ].filter(Boolean);
    this.node = el('div', { class: 'block turn-end' }, parts.join(' · '));
  }
}

export { el };
