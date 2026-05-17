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
    this.pre = el('pre', {}, '');
    // Collapsed by default so the conversation stays scannable; the summary
    // line always carries the tool name + key argument so the user knows
    // what's running without expanding.
    this.node = el('details', { class: 'block tool' }, this.summary, this.pre);
    this._renderSummary();
  }

  setName(name) {
    if (name) this.name = name;
    this._renderSummary();
  }

  appendInputDelta(partial) {
    this.partialJson += partial;
    this.pre.textContent = this.partialJson;
    // Best-effort parse of the partial JSON so the summary preview can
    // start showing useful content before the block finalizes.
    let parsed = null;
    try { parsed = JSON.parse(this.partialJson); } catch { /* not yet complete */ }
    if (parsed && typeof parsed === 'object') {
      this.input = parsed;
      this._renderSummary();
    }
  }

  finalizeInput(input) {
    this.input = input;
    try { this.pre.textContent = JSON.stringify(input, null, 2); }
    catch { this.pre.textContent = this.partialJson; }
    this.status = 'ready';
    this._renderSummary();
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
