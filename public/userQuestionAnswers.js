// Canonical AskUserQuestion answer formatting — the single source of truth
// for the text delivered to a worker when a question is answered.
//
// Lives under public/ because the browser can only import from the statically
// served public/ dir (see server.ts express.static). It is DOM-free on purpose
// so BOTH surfaces call ONE function — no fork:
//   - the UI question card (public/blocks.js re-exports these; app.js formats
//     the submit text, conversation.js reverses it on replay), and
//   - the answer_question MCP tool (src/mcp/handlers.js imports it directly),
//     so an MCP answer is byte-identical to a UI answer.
// Keep this file free of `document`/DOM references so the server import stays
// valid.

// The answer text grammar. Every value is JSON-string-quoted (`q(s)` is
// `JSON.stringify(s)`), so no label, note or custom text can hold an unescaped
// `"` or line break, and each answer kind opens with its own token:
//
//   single := 'Answer to ' q(Q) ': ' BODY
//   multi  := 'My answers:' ( '\n' <i> '. ' q(Q_i) ': ' BODY_i )  i = 1..N
//   BODY   := '(no answer)'                      skipped
//           | '(own answer) ' q(text)            custom / Other
//           | q(label) ( ', ' q(label) )* NOTE?  option or multi
//   NOTE   := ' (note: ' q(note) ')'
//
// Q is the question text with whitespace collapsed. The question's
// `multiSelect` flag decides whether a pick list parses as `option` or
// `multi`. The parse is strict: it consumes the whole text or fails.
const NO_ANSWER = '(no answer)';
const OWN_ANSWER = '(own answer)';
const NOTE_OPEN = ' (note: ';
const NOTE_CLOSE = ')';
const MULTI_HEAD = 'My answers:\n';

const q = (s) => JSON.stringify(s);
const questionText = (question, fallback) => (question?.question ?? fallback).replace(/\s+/g, ' ').trim();
// The single-question prefix, shared by the formatter, the parser and the
// correlator so they cannot drift on question text holding `"` or `\`.
const questionPrefix = (question) => `Answer to ${q(questionText(question, 'Question'))}: `;
const linePrefix = (question, i) => `${i + 1}. ${q(questionText(question, `Question ${i + 1}`))}: `;

function renderAnswer(a) {
  const withNote = (picks, note) => {
    const n = note?.trim();
    return n ? `${picks}${NOTE_OPEN}${q(n)}${NOTE_CLOSE}` : picks;
  };
  if (a?.kind === 'option') return withNote(q(a.label), a.note);
  if (a?.kind === 'multi') return withNote(a.labels.map(l => q(l)).join(', '), a.note);
  if (a?.kind === 'custom') return `${OWN_ANSWER} ${q(a.text.trim())}`;
  return NO_ANSWER;
}

// Format the per-question answer into the text we send to the model.
// Exported so app.js (and tests) can use the same canonical formatting.
export function formatUserQuestionAnswers(questions, answers) {
  if (questions.length === 1) return questionPrefix(questions[0]) + renderAnswer(answers[0]);
  const lines = questions.map((question, i) => linePrefix(question, i) + renderAnswer(answers[i]));
  return MULTI_HEAD + lines.join('\n');
}

// True iff `text` opens with the prefix formatUserQuestionAnswers() emits for
// these questions, so a replayed/echoed user prompt can be recognized as THIS
// card's answer rather than an unrelated interleaved echo (e.g. an
// idle-callback wake stub). Prefix-only on purpose: an answer the strict parse
// rejects (a coalesced steer, an older format) still pairs and locks its card.
export function isUserQuestionAnswerText(questions, text) {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  if (typeof text !== 'string') return false;
  if (questions.length === 1) return text.startsWith(questionPrefix(questions[0]));
  return text.startsWith(MULTI_HEAD);
}

// The questions-free form of isUserQuestionAnswerText: true iff `text` opens
// with either prefix formatUserQuestionAnswers emits (single-question short
// form / multi `My answers:\n1. `), for callers with no card to match against.
export function isQuestionAnswerShape(text) {
  return typeof text === 'string' && (/^Answer to "[^\n]*": /.test(text) || text.startsWith(`${MULTI_HEAD}1. `));
}

// The exact reverse of formatUserQuestionAnswers. Exported so
// conversation.js can call it during session replay. Never throws — returns
// an array of { kind: 'none' } when the text is not in the grammar above
// (an older format, trailing text, an unoffered label) so callers can
// degrade gracefully.
export function parseUserQuestionAnswers(questions, text) {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  const none = () => questions.map(() => ({ kind: 'none' }));
  if (typeof text !== 'string') return none();
  try {
    if (questions.length === 1) {
      const prefix = questionPrefix(questions[0]);
      if (!text.startsWith(prefix)) return none();
      const answer = parseBody(questions[0], text.slice(prefix.length));
      return answer ? [answer] : none();
    }
    if (!text.startsWith(MULTI_HEAD)) return none();
    const lines = text.slice(MULTI_HEAD.length).split('\n');
    if (lines.length !== questions.length) return none();
    const answers = [];
    for (let i = 0; i < questions.length; i++) {
      const prefix = linePrefix(questions[i], i);
      if (!lines[i].startsWith(prefix)) return none();
      const answer = parseBody(questions[i], lines[i].slice(prefix.length));
      if (!answer) return none();
      answers.push(answer);
    }
    return answers;
  } catch {
    return none();
  }
}

// Read the JSON string literal opening at s[i]. Returns { value, end } with
// `end` just past the closing quote, or null when s[i] is not `"`, the
// literal is unterminated, or it holds a raw control character.
function readQuoted(s, i) {
  if (s[i] !== '"') return null;
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c < 0x20) return null;
    if (c === 0x5c) { j++; continue; }
    if (c === 0x22) {
      try { return { value: JSON.parse(s.slice(i, j + 1)), end: j + 1 }; } catch { return null; }
    }
  }
  return null;
}

// One BODY, consumed to its end; null if it is not in the grammar or names a
// label the question does not offer.
function parseBody(question, s) {
  if (s === NO_ANSWER) return { kind: 'none' };
  if (s.startsWith(`${OWN_ANSWER} `)) {
    const r = readQuoted(s, OWN_ANSWER.length + 1);
    return r && r.end === s.length ? { kind: 'custom', text: r.value } : null;
  }
  const labels = [];
  let i = 0;
  for (;;) {
    const r = readQuoted(s, i);
    if (!r) return null;
    labels.push(r.value);
    i = r.end;
    if (!s.startsWith(', ', i)) break;
    i += 2;
  }
  let note;
  if (i < s.length) {
    if (!s.startsWith(NOTE_OPEN, i)) return null;
    const r = readQuoted(s, i + NOTE_OPEN.length);
    if (!r || s.slice(r.end) !== NOTE_CLOSE) return null;
    note = r.value;
  }
  const offered = new Set((question?.options ?? []).map(o => o.label));
  if (!labels.every(l => offered.has(l))) return null;
  const withNote = (a) => (note === undefined ? a : { ...a, note });
  if (question?.multiSelect) return withNote({ kind: 'multi', labels });
  if (labels.length !== 1) return null;
  return withNote({ kind: 'option', label: labels[0] });
}
