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
    this.buffer = '';
  }
  appendDelta(text) {
    this.buffer += text;
    this.body.appendChild(document.createTextNode(text));
  }
  finalize() {
    if (!this.buffer.trim()) return;
    this.body.classList.add('md');
    renderMarkdownInto(this.body, this.buffer);
  }
}

// Renders an image attachment, sourced from either inline base64 (live
// echo for an attachment just sent) or an HTTP URL pointing at the
// /api/instances/:id/attachments/<file> endpoint (replay / refresh).
// The thumbnail is clickable so the user can open the original.
export class ImageBlock {
  constructor({ mediaType, dataBase64, src, name } = {}) {
    const url = src || `data:${mediaType || 'image/png'};base64,${dataBase64 || ''}`;
    const img = el('img', { class: 'block-image-img', src: url, alt: name || 'attached image' });
    const link = el('a', { href: url, target: '_blank', rel: 'noopener' }, img);
    this.node = el('div', { class: 'block image' }, link);
  }
  appendDelta() {}
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
    this.redacted = false;
  }
  appendDelta(text) { this.body.appendChild(document.createTextNode(text)); }
  markRedacted() {
    const flat = el('div', { class: 'block thinking redacted' }, 'thinking (redacted)');
    this.node.replaceWith(flat);
    this.node = flat;
    this.body = flat;
    this.redacted = true;
  }
  finalize() {
    if (this.redacted) return;
    const len = this.body.textContent.length;
    const summary = this.node.querySelector('summary');
    summary.textContent = `thinking (${len} chars)`;
  }
}

import { lineDiff, diffStats } from './diff.js';
import { renderMarkdownInto } from './markdown.js';

// Per-tool one-line description for the collapsed summary.
// Returns a short string with the most-useful argument for the tool.
export function describeToolInput(name, input, ctx = {}) {
  if (!input || typeof input !== 'object') return '';
  const trunc = (s, n = 120) => {
    if (typeof s !== 'string') return '';
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
  };
  // Join subject + description on a separator, truncating each piece
  // individually so the description never crowds the subject out.
  const join = (subject, description, statusSuffix) => {
    const subj = trunc(subject, 80);
    const desc = trunc(description, 100);
    let out = subj;
    if (desc && desc !== subj) out = subj ? `${subj} — ${desc}` : desc;
    if (statusSuffix) out = out ? `${out} · ${statusSuffix}` : statusSuffix;
    return trunc(out, 160);
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
      return join(input.subject, input.description);
    case 'TaskUpdate': {
      // The model usually only sends taskId + status here. Resolve the
      // task's subject + description from the tracker so the user sees
      // WHICH task is being updated, not just its numeric id.
      const id = input.taskId != null ? String(input.taskId) : null;
      const subject = (typeof input.subject === 'string' && input.subject) ||
        ctx.resolveTaskSubject?.(id) || null;
      const description = (typeof input.description === 'string' && input.description) ||
        ctx.resolveTaskDescription?.(id) || null;
      const status = typeof input.status === 'string' ? input.status : null;
      const statusSuffix = status ? `→ ${status}` : null;
      const idPrefix = id ? `#${id}` : null;
      const head = idPrefix && subject ? `${idPrefix} ${subject}`
        : subject ? subject
        : idPrefix ? idPrefix
        : '';
      return join(head, description, statusSuffix);
    }
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
  constructor({ name, toolUseId, describeCtx = {} }) {
    this.name = name; this.toolUseId = toolUseId;
    this.describeCtx = describeCtx;
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
    const desc = this.input ? describeToolInput(this.name, this.input, this.describeCtx) : '';
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
      if (this.partialJson) this.body.appendChild(wrapToolInputPre(el('pre', {}, this.partialJson)));
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
    let pre;
    try { pre = el('pre', {}, JSON.stringify(input, null, 2)); }
    catch { pre = el('pre', {}, this.partialJson); }
    this.body.appendChild(wrapToolInputPre(pre));
  }
}

function wrapToolInputPre(pre) {
  return el('details', { class: 'block tool-input' },
    el('summary', {}, '↪ tool_input'),
    pre,
  );
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
//   { kind: 'option', label, note? }   (single-select pick + optional note)
//   { kind: 'multi', labels, note? }   (multi-select picks + optional note)
//   { kind: 'custom', text }           (user typed answer in the "Other" field, no pick)
//
// The text input plays two roles: before any option is picked it is the
// "Other" free-form answer; once an option is picked it becomes the
// "Add a note (optional)" field attached to that pick. Typed text persists
// in `this.drafts[idx]` across that role flip.
export class UserQuestionBlock {
  constructor(ev, onSubmit) {
    this.toolUseId = ev.toolUseId;
    this.onSubmit = onSubmit;
    this.questions = Array.isArray(ev.questions) ? ev.questions : [];
    this.answers = this.questions.map(() => ({ kind: 'none' }));
    // Per-question text typed into the input. Persists across role flips
    // between "Other answer" (no pick) and "note on a pick" so the user
    // never loses what they wrote when they tap an option.
    this.drafts = this.questions.map(() => '');
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
    const draft = this.drafts[idx];

    let labels;
    if (q.multiSelect) {
      labels = current.kind === 'multi' ? [...current.labels] : [];
      const at = labels.indexOf(label);
      if (at >= 0) labels.splice(at, 1);
      else labels.push(label);
    } else {
      const same = current.kind === 'option' && current.label === label;
      labels = same ? [] : [label];
    }

    if (labels.length === 0) {
      // No picks left — fall back to the draft text as a free-form
      // "Other" answer, or to `none` when there's nothing typed.
      this.answers[idx] = draft.length > 0
        ? { kind: 'custom', text: draft }
        : { kind: 'none' };
    } else if (q.multiSelect) {
      this.answers[idx] = draft.length > 0
        ? { kind: 'multi', labels, note: draft }
        : { kind: 'multi', labels };
    } else {
      this.answers[idx] = draft.length > 0
        ? { kind: 'option', label: labels[0], note: draft }
        : { kind: 'option', label: labels[0] };
    }
    this._render();
  }

  _setCustom(idx, text) {
    if (this.submitted) return;
    // Preserve the text exactly as typed — including spaces. Previously
    // we trimmed here, then _render wrote the trimmed value back into
    // input.value, which silently swallowed every space the user typed.
    this.drafts[idx] = text;
    const current = this.answers[idx];
    const hasPick = current.kind === 'option' || current.kind === 'multi';
    if (hasPick) {
      const next = { ...current };
      if (text.length > 0) next.note = text; else delete next.note;
      this.answers[idx] = next;
    } else {
      this.answers[idx] = text.length === 0
        ? { kind: 'none' }
        : { kind: 'custom', text };
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
      const labelSpan = activePane.querySelector('.uq-custom-label');
      if (input) {
        const isNoteMode = answer.kind === 'option' || answer.kind === 'multi';
        if (labelSpan) labelSpan.textContent = isNoteMode ? 'Add a note (optional)' : 'Other:';
        input.placeholder = isNoteMode ? 'Add a note (optional)…' : 'Or type your own answer…';
        const want = this.drafts[this.activeIdx] || '';
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
  const renderAnswer = (a) => {
    if (a?.kind === 'option') {
      const note = a.note?.trim();
      return note ? `${a.label} — ${note}` : a.label;
    }
    if (a?.kind === 'multi') {
      const joined = a.labels.join(', ');
      const note = a.note?.trim();
      return note ? `${joined} — ${note}` : joined;
    }
    if (a?.kind === 'custom') return a.text.trim();
    return '(no answer)';
  };
  const lines = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qText = (q?.question ?? `Question ${i + 1}`).replace(/\s+/g, ' ').trim();
    lines.push(`- ${qText}: ${renderAnswer(answers[i])}`);
  }
  if (lines.length === 1) {
    // single-question short form
    const q = questions[0];
    const qText = (q?.question ?? 'Question').replace(/\s+/g, ' ').trim();
    return `Answer to "${qText}": ${renderAnswer(answers[0])}`;
  }
  return `My answers:\n${lines.join('\n')}`;
}

// Renders the plan the model produced in plan mode + Approve/Reject
// controls. Approve switches the instance out of plan mode and tells the
// model to implement. Reject keeps plan mode active and forwards user
// feedback so the model can refine.
export class PlanRequestBlock {
  constructor(ev, onDecision, { autoApproved = false } = {}) {
    this.toolUseId = ev.toolUseId;
    this.onDecision = onDecision;
    this.submitted = false;

    const initialStatus = autoApproved ? 'auto-approved' : 'awaiting your decision';
    this.statusNode = el('span', { class: 'pr-status' }, initialStatus);

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

    const children = [
      el('div', { class: 'pr-head' },
        el('span', { class: 'pr-title' }, '📋 Plan ready for approval'),
        this.statusNode,
      ),
      pathLine,
      this.planBody,
    ];

    if (!autoApproved) {
      this.feedbackInput = el('textarea', {
        class: 'pr-feedback', rows: '2',
        placeholder: 'Optional feedback / refinement notes (used when rejecting)',
      });
      this.approveBtn = el('button', { class: 'pr-approve', type: 'button' }, 'Approve & Implement');
      this.rejectBtn = el('button', { class: 'pr-reject', type: 'button' }, 'Reject & Refine');
      this.approveBtn.addEventListener('click', () => this._click('approve'));
      this.rejectBtn.addEventListener('click', () => this._click('reject'));

      children.push(
        el('div', { class: 'pr-feedback-wrap' }, this.feedbackInput),
        el('div', { class: 'pr-actions' }, this.approveBtn, this.rejectBtn),
      );
    }

    this.node = el('div', { class: 'block plan-request' }, ...children);
    if (autoApproved) this.node.classList.add('approved');
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


// Interactive PreToolUse hook card. Rendered when the orchestrator
// receives a hook callback for a destructive tool while in ask mode. The
// user picks Allow or Deny; the choice is forwarded over WS as a
// hook_decision message, which resolves the held-open hook HTTP response
// and lets the CLI either proceed or auto-deny the tool.
export class PermissionRequestBlock {
  constructor(ev, onDecision) {
    this.toolUseId = ev.toolUseId;
    this.toolName = ev.toolName;
    this.onDecision = onDecision;
    this.submitted = false;

    const argLine = describeToolInput(ev.toolName, ev.toolInput);

    this.statusNode = el('span', { class: 'perm-status' }, 'awaiting decision');
    this.allowBtn = el('button', { class: 'perm-allow', type: 'button' }, 'Allow');
    this.denyBtn = el('button', { class: 'perm-deny', type: 'button' }, 'Deny');
    this.allowBtn.addEventListener('click', () => this._click(true));
    this.denyBtn.addEventListener('click', () => this._click(false));

    let argsNode;
    const input = ev.toolInput ?? {};
    if (ev.toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      argsNode = renderEditDiff(input);
    } else if (ev.toolName === 'Write' && typeof input.content === 'string') {
      argsNode = renderWritePreview(input);
    } else if (ev.toolName === 'NotebookEdit' && typeof input.new_source === 'string') {
      argsNode = renderNotebookEdit(input);
    } else {
      let json = '';
      try { json = JSON.stringify(input, null, 2); } catch { json = String(input); }
      argsNode = el('pre', {}, json);
    }

    this.node = el('div', { class: 'block permission' },
      el('div', { class: 'perm-head' },
        el('span', { class: 'perm-title' }, `🔐 Allow ${ev.toolName ?? 'tool'}?`),
        this.statusNode,
      ),
      argLine ? el('div', { class: 'perm-arg' }, argLine) : null,
      argsNode,
      el('div', { class: 'perm-actions' }, this.allowBtn, this.denyBtn),
    );
  }

  _click(allow) {
    if (this.submitted) return;
    this.submitted = true;
    this.allowBtn.disabled = true;
    this.denyBtn.disabled = true;
    this.statusNode.textContent = allow ? 'allowing…' : 'denying…';
    this.node.classList.add(allow ? 'allow-pending' : 'deny-pending');
    if (this.onDecision) this.onDecision({ toolUseId: this.toolUseId, allow });
  }

  // Called by Conversation when a permission_resolved event arrives. Lets
  // a second tab subscribed to the same instance reflect a decision made
  // elsewhere, and updates the status when our own click round-trips back.
  markResolved(allow) {
    this.allowBtn.disabled = true;
    this.denyBtn.disabled = true;
    this.node.classList.remove('allow-pending', 'deny-pending');
    this.node.classList.add(allow ? 'allowed' : 'denied');
    this.statusNode.textContent = allow ? '✓ allowed' : '✗ denied';
  }
}


export class ToolResultBlock {
  constructor({ content, isError, toolUseId }) {
    this.toolUseId = toolUseId; this.isError = isError;
    // Separate text and image content. The Read tool returns images as
    // {type:'image', source:{type:'base64'|'url', ...}} content blocks
    // that the old text-only path silently dropped.
    const textParts = [];
    const images = [];
    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'image' && b.source && typeof b.source === 'object') {
          const src = imageSrcFromSource(b.source);
          if (src) images.push(src);
        } else if (typeof b.text === 'string' && b.text) {
          textParts.push(b.text);
        }
      }
    } else {
      textParts.push(JSON.stringify(content));
    }
    const text = textParts.join('\n');
    const TRUNC = 4000;
    const truncated = text.length > TRUNC;
    const pre = el('pre', {}, truncated ? text.slice(0, TRUNC) + '\n…(truncated)' : text);
    const label = images.length
      ? (isError ? '↪ tool_result (error)' : `↪ tool_result · ${images.length} image${images.length === 1 ? '' : 's'}`)
      : (isError ? '↪ tool_result (error)' : '↪ tool_result');
    const summary = el('summary', {}, label);
    // Auto-open when small, when it carries an image, or always for non-errors
    // with images so the user actually sees the picture.
    const det = el('details', { class: 'block tool-result' + (isError ? ' error' : ''), open: !isError && (images.length > 0 || text.length < 600) },
      summary, pre,
    );
    if (truncated) {
      const showFull = el('button', { type: 'button', onclick: () => { pre.textContent = text; showFull.remove(); } }, 'show full');
      det.appendChild(showFull);
    }
    for (const src of images) {
      const img = document.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', 'tool-result image');
      img.setAttribute('loading', 'lazy');
      img.className = 'tool-result-img';
      const link = el('a', { href: src, target: '_blank', rel: 'noopener' }, img);
      det.appendChild(link);
    }
    this.node = det;
  }
}

// Build a safe <img src> from a Messages-API image content block source.
// base64 → data: URL with media_type sniffing.
// url    → only http(s)/file:// passed through.
function imageSrcFromSource(source) {
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' && /^image\/[\w.+-]+$/i.test(source.media_type)
      ? source.media_type
      : 'image/png';
    // svg+xml can carry inline scripts — refuse it to match the markdown image policy.
    if (/svg/i.test(media)) return null;
    return `data:${media};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    if (/^(https?:|file:)\/\//i.test(source.url)) return source.url;
  }
  return null;
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
