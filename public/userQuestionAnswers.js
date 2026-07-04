// Canonical AskUserQuestion answer formatting — the single source of truth
// for the text delivered to a worker when a question is answered.
//
// Lives under public/ because the browser can only import from the statically
// served public/ dir (see server.js express.static). It is DOM-free on purpose
// so BOTH surfaces call ONE function — no fork:
//   - the UI question card (public/blocks.js re-exports these; app.js formats
//     the submit text, conversation.js reverses it on replay), and
//   - the answer_question MCP tool (src/mcp/handlers.js imports it directly),
//     so an MCP answer is byte-identical to a UI answer.
// Keep this file free of `document`/DOM references so the server import stays
// valid.

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

// Best-effort reverse of formatUserQuestionAnswers. Reconstructs the
// per-question answer objects from the text that was sent to the model.
// Exported so conversation.js can call it during session replay.
// Never throws — returns an array of { kind: 'none' } on any parse failure
// so callers can degrade gracefully.
export function parseUserQuestionAnswers(questions, text) {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  if (typeof text !== 'string') return questions.map(() => ({ kind: 'none' }));
  try {
    if (questions.length === 1) {
      const q = questions[0];
      const qText = (q?.question ?? 'Question').replace(/\s+/g, ' ').trim();
      const prefix = `Answer to "${qText}": `;
      const answerText = text.startsWith(prefix) ? text.slice(prefix.length) : text;
      return [_parseOneAnswer(q, answerText)];
    }
    // Multi-question format: "My answers:\n- Q1: A1\n- Q2: A2"
    const MULTI_PREFIX = 'My answers:\n';
    if (!text.startsWith(MULTI_PREFIX)) return questions.map(() => ({ kind: 'none' }));
    const lines = text.slice(MULTI_PREFIX.length).split('\n');
    return questions.map((q, i) => {
      const qText = (q?.question ?? `Question ${i + 1}`).replace(/\s+/g, ' ').trim();
      const linePrefix = `- ${qText}: `;
      const line = lines.find(l => l.startsWith(linePrefix));
      if (!line) return { kind: 'none' };
      return _parseOneAnswer(q, line.slice(linePrefix.length));
    });
  } catch {
    return questions.map(() => ({ kind: 'none' }));
  }
}

function _parseOneAnswer(q, renderText) {
  if (typeof renderText !== 'string' || !renderText) return { kind: 'none' };
  // Split on ' — ' to separate the value from an optional note.
  const dashIdx = renderText.indexOf(' — ');
  let valuePart = dashIdx >= 0 ? renderText.slice(0, dashIdx) : renderText;
  const note = dashIdx >= 0 ? renderText.slice(dashIdx + 3) : undefined;
  valuePart = valuePart.trim();
  if (q?.multiSelect) {
    const labels = valuePart.split(', ').map(s => s.trim()).filter(Boolean);
    const validLabels = labels.filter(l => (q.options ?? []).some(o => o.label === l));
    if (validLabels.length > 0) {
      return note ? { kind: 'multi', labels: validLabels, note } : { kind: 'multi', labels: validLabels };
    }
  } else {
    const opt = (q?.options ?? []).find(o => o.label === valuePart);
    if (opt) {
      return note ? { kind: 'option', label: opt.label, note } : { kind: 'option', label: opt.label };
    }
  }
  // No option matched — treat as a free-form custom answer.
  return { kind: 'custom', text: valuePart };
}
