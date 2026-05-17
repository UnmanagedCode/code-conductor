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
import { renderMarkdownInto } from './markdown.js';

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
    // Collapsed by default — the smart summary already shows the command
    // and the disclosure caret (rendered in CSS since display:flex hides
    // the native triangle on summary) tells the user the body is hidden.
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

// Renders one or more questions as tabbed panes, each with its options +
// an always-present "Other / custom typed answer" input. The user fills in
// every question first, then taps a single Submit button that hands the
// consolidated answers off to the caller — no per-click prompt sending.
//
// Internal answer states per question:
//   { kind: 'none' }
//   { kind: 'option', label }          (single-select pick)
//   { kind: 'multi', labels: [...] }   (multi-select picks)
//   { kind: 'custom', text }           (user typed answer in the "Other" field)
export class UserQuestionBlock {
  constructor(ev, onSubmit) {
    this.toolUseId = ev.toolUseId;
    this.onSubmit = onSubmit;
    this.questions = Array.isArray(ev.questions) ? ev.questions : [];
    this.answers = this.questions.map(() => ({ kind: 'none' }));
    this.activeIdx = 0;
    this.submitted = false;

    this.statusNode = el('span', { class: 'uq-status' }, '');
    this.tabs = el('div', { class: 'uq-tabs' });
    this.panes = el('div', { class: 'uq-panes' });
    this.submitBtn = el('button', { class: 'uq-submit', type: 'button' },
      this.questions.length > 1 ? 'Send all answers' : 'Send answer');
    this.submitBtn.disabled = true;
    this.submitBtn.addEventListener('click', () => this._submit());

    this.node = el('div', { class: 'block user-question' },
      el('div', { class: 'uq-head' },
        el('span', { class: 'uq-title' }, '❓ The model asks…'),
        this.statusNode,
      ),
      this.tabs,
      this.panes,
      this.submitBtn,
    );

    this._build();
    this._render();
  }

  _build() {
    // Tab strip only if there's >1 question.
    if (this.questions.length > 1) {
      for (let i = 0; i < this.questions.length; i++) {
        const q = this.questions[i];
        const tab = el('button', { class: 'uq-tab', type: 'button' },
          el('span', { class: 'uq-tab-num' }, String(i + 1)),
          el('span', { class: 'uq-tab-label' }, q.header || (q.question?.slice(0, 24) ?? `Q${i + 1}`)),
        );
        tab.addEventListener('click', () => { this.activeIdx = i; this._render(); });
        this.tabs.appendChild(tab);
      }
    } else {
      this.tabs.style.display = 'none';
    }
    for (let i = 0; i < this.questions.length; i++) {
      this.panes.appendChild(this._buildPane(i));
    }
  }

  _buildPane(idx) {
    const q = this.questions[idx];
    const pane = el('div', { class: 'uq-pane' });
    pane.dataset.idx = String(idx);
    pane.appendChild(el('div', { class: 'uq-q-text' }, q.question ?? ''));
    if (q.header) pane.appendChild(el('div', { class: 'uq-q-header' }, q.header + (q.multiSelect ? ' · select multiple' : '')));

    const opts = el('div', { class: 'uq-options' });
    for (let oi = 0; oi < (q.options ?? []).length; oi++) {
      const opt = q.options[oi];
      const btn = el('button', { class: 'uq-opt', type: 'button' },
        el('span', { class: 'uq-opt-label' }, opt.label ?? `Option ${oi + 1}`),
        opt.description ? el('span', { class: 'uq-opt-desc' }, opt.description) : null,
      );
      btn.dataset.label = opt.label ?? '';
      btn.addEventListener('click', () => this._pickOption(idx, opt.label ?? ''));
      opts.appendChild(btn);
    }
    pane.appendChild(opts);

    // Always-present "Other" custom input.
    const customInput = el('input', {
      type: 'text', class: 'uq-custom-input',
      placeholder: 'Or type your own answer…',
      autocomplete: 'off',
    });
    customInput.addEventListener('input', () => this._setCustom(idx, customInput.value));
    pane.appendChild(el('div', { class: 'uq-custom' },
      el('span', { class: 'uq-custom-label' }, 'Other:'),
      customInput,
    ));
    return pane;
  }

  _pickOption(idx, label) {
    if (this.submitted) return;
    const q = this.questions[idx];
    const current = this.answers[idx];
    if (q.multiSelect) {
      const labels = current.kind === 'multi' ? [...current.labels] : [];
      const at = labels.indexOf(label);
      if (at >= 0) labels.splice(at, 1);
      else labels.push(label);
      this.answers[idx] = labels.length ? { kind: 'multi', labels } : { kind: 'none' };
    } else {
      if (current.kind === 'option' && current.label === label) {
        this.answers[idx] = { kind: 'none' };
      } else {
        this.answers[idx] = { kind: 'option', label };
      }
    }
    this._render();
  }

  _setCustom(idx, text) {
    if (this.submitted) return;
    // Preserve the text exactly as typed — including spaces. Previously
    // we trimmed here, then _render wrote the trimmed value back into
    // input.value, which silently swallowed every space the user typed.
    if (text.length === 0) {
      this.answers[idx] = { kind: 'none' };
    } else {
      this.answers[idx] = { kind: 'custom', text };
    }
    this._render();
  }

  _render() {
    // Tab states.
    [...this.tabs.children].forEach((t, i) => {
      t.classList.toggle('active', i === this.activeIdx);
      t.classList.toggle('answered', this.answers[i]?.kind !== 'none');
    });
    // Pane visibility.
    [...this.panes.children].forEach((p, i) => {
      p.style.display = i === this.activeIdx ? '' : 'none';
    });
    // Highlight picks in the active pane.
    const activePane = this.panes.children[this.activeIdx];
    if (activePane) {
      const answer = this.answers[this.activeIdx];
      activePane.querySelectorAll('button.uq-opt').forEach((btn) => {
        const label = btn.dataset.label || '';
        const picked =
          (answer.kind === 'option' && answer.label === label) ||
          (answer.kind === 'multi' && answer.labels.includes(label));
        btn.classList.toggle('picked', picked);
      });
      const input = activePane.querySelector('.uq-custom-input');
      if (input) {
        const want = answer.kind === 'custom' ? answer.text : '';
        if (input.value !== want) input.value = want;
        input.classList.toggle('active', answer.kind === 'custom');
      }
    }
    // Submit gating: every question must have a non-`none` answer, and
    // any custom answer must have at least one non-whitespace character.
    const allAnswered = this.answers.length > 0 && this.answers.every(a => {
      if (a.kind === 'none') return false;
      if (a.kind === 'custom') return a.text.trim().length > 0;
      return true;
    });
    this.submitBtn.disabled = !allAnswered;
    // Status line summary.
    if (this.questions.length <= 1) {
      this.statusNode.textContent = allAnswered ? 'ready to send' : 'pick an option or type your own';
    } else {
      const n = this.answers.filter(a => a.kind !== 'none').length;
      this.statusNode.textContent = `${n}/${this.questions.length} answered`;
    }
  }

  _submit() {
    if (this.submitBtn.disabled || this.submitted) return;
    this.submitted = true;
    this.submitBtn.disabled = true;
    this.statusNode.textContent = 'sending…';
    this.node.classList.add('answered');
    // Lock all inputs.
    this.panes.querySelectorAll('button.uq-opt').forEach(b => { b.disabled = true; });
    this.panes.querySelectorAll('.uq-custom-input').forEach(i => { i.disabled = true; });
    if (this.onSubmit) {
      this.onSubmit({
        toolUseId: this.toolUseId,
        questions: this.questions,
        answers: this.answers.slice(),
      });
    }
  }
}

// Format the per-question answer into the text we send to the model.
// Exported so app.js (and tests) can use the same canonical formatting.
export function formatUserQuestionAnswers(questions, answers) {
  const lines = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    const qText = (q?.question ?? `Question ${i + 1}`).replace(/\s+/g, ' ').trim();
    let answerText;
    if (a?.kind === 'option') answerText = a.label;
    else if (a?.kind === 'multi') answerText = a.labels.join(', ');
    else if (a?.kind === 'custom') answerText = a.text.trim();
    else answerText = '(no answer)';
    lines.push(`- ${qText}: ${answerText}`);
  }
  if (lines.length === 1) {
    // single-question short form
    const q = questions[0];
    const a = answers[0];
    const qText = (q?.question ?? 'Question').replace(/\s+/g, ' ').trim();
    let answerText;
    if (a?.kind === 'option') answerText = a.label;
    else if (a?.kind === 'multi') answerText = a.labels.join(', ');
    else if (a?.kind === 'custom') answerText = a.text.trim();
    else answerText = '(no answer)';
    return `Answer to "${qText}": ${answerText}`;
  }
  return `My answers:\n${lines.join('\n')}`;
}

// Renders the plan the model produced in plan mode + Approve/Reject
// controls. Approve switches the instance out of plan mode and tells the
// model to implement. Reject keeps plan mode active and forwards user
// feedback so the model can refine.
export class PlanRequestBlock {
  constructor(ev, onDecision) {
    this.toolUseId = ev.toolUseId;
    this.onDecision = onDecision;
    this.submitted = false;

    this.statusNode = el('span', { class: 'pr-status' }, 'awaiting your decision');

    const hasPlanText = typeof ev.plan === 'string' && ev.plan.trim().length > 0;
    const pathLine = ev.planPath
      ? el('div', { class: 'pr-path' }, `saved to ${ev.planPath}`)
      : null;

    // Plan body rendered as Markdown — headings, lists, code blocks, etc.
    this.planBody = el('div', { class: 'pr-body md' });
    if (hasPlanText) {
      renderMarkdownInto(this.planBody, ev.plan);
    } else {
      this.planBody.appendChild(
        el('p', { class: 'pr-empty' }, '(plan content not provided inline — see the recent assistant output above)'),
      );
    }

    this.feedbackInput = el('textarea', {
      class: 'pr-feedback', rows: '2',
      placeholder: 'Optional feedback / refinement notes (used when rejecting)',
    });

    this.approveBtn = el('button', { class: 'pr-approve', type: 'button' }, 'Approve & implement');
    this.rejectBtn = el('button', { class: 'pr-reject', type: 'button' }, 'Reject & refine');
    this.approveBtn.addEventListener('click', () => this._click('approve'));
    this.rejectBtn.addEventListener('click', () => this._click('reject'));

    this.node = el('div', { class: 'block plan-request' },
      el('div', { class: 'pr-head' },
        el('span', { class: 'pr-title' }, '📋 Plan ready for approval'),
        this.statusNode,
      ),
      pathLine,
      this.planBody,
      el('div', { class: 'pr-feedback-wrap' }, this.feedbackInput),
      el('div', { class: 'pr-actions' }, this.approveBtn, this.rejectBtn),
    );
  }

  _click(decision) {
    if (this.submitted) return;
    this.submitted = true;
    this.approveBtn.disabled = true;
    this.rejectBtn.disabled = true;
    this.feedbackInput.disabled = true;
    this.statusNode.textContent = decision === 'approve' ? 'approving…' : 'sending refinement…';
    this.node.classList.add(decision === 'approve' ? 'approved' : 'rejected');
    if (this.onDecision) {
      this.onDecision({
        toolUseId: this.toolUseId,
        decision,
        feedback: this.feedbackInput.value.trim(),
      });
    }
  }
}

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

// Subtypes the conversation view will render. Everything else (including the
// per-turn `status:"requesting"` and `rate_limit_event:"allowed"` noise that
// previously dumped raw JSON into the chat) is dropped at the dispatcher.
const SHOWN_SYSTEM_SUBTYPES = new Set([
  'init', 'stderr', 'exit', 'spawn_error', 'crashed',
  'permission_denied', 'compacting', 'history_load_error',
]);

export function shouldRenderSystem(ev) {
  const sub = ev.subtype;
  if (sub === 'rate_limit_event') {
    return ev.data?.rate_limit_info?.status && ev.data.rate_limit_info.status !== 'allowed';
  }
  if (sub === 'status') return false; // per-turn `requesting`/`complete` chatter
  if (sub === 'task_progress' || sub === 'task_started' || sub === 'task_updated') return false;
  return SHOWN_SYSTEM_SUBTYPES.has(sub);
}

export class SystemBlock {
  constructor({ subtype, data }) {
    const detail = (() => {
      if (subtype === 'init') return `model=${data?.model ?? '?'} sid=${data?.session_id?.slice(0,8) ?? '?'}`;
      if (subtype === 'stderr') return data?.line ?? '';
      if (subtype === 'exit') return `code=${data?.code} signal=${data?.signal ?? '-'}`;
      if (subtype === 'spawn_error' || subtype === 'crashed') return data?.message ?? '';
      if (subtype === 'history_load_error') return `couldn't replay history: ${data?.message ?? ''}`;
      if (subtype === 'permission_denied') return data?.message ?? data?.reason ?? '';
      if (subtype === 'compacting') return 'auto-compacting context…';
      try { return JSON.stringify(data).slice(0, 200); } catch { return ''; }
    })();
    this.node = el('div', { class: 'block system' },
      el('span', { class: 'subtype' }, subtype),
      detail ? ` ${detail}` : '',
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
