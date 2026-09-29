// Dedicated bubble for an AskUserQuestion answer: one row per question with the
// chosen option chips / custom text / skipped marker and any note. Built purely
// from the server-stamped `questionAnswer` ({ toolUseId, questions }) — never
// from sniffing the text. Returns { body, controls } like buildUserText.

import { el } from './dom.js';
import { formatUserQuestionAnswers, parseUserQuestionAnswers } from './userQuestionAnswers.js';
import { buildUserText } from './userText.js';

function buildAnswerItem(q, a) {
  const answer = el('div', { class: 'qa-a' });
  if (a.kind === 'option') {
    answer.appendChild(el('span', { class: 'qa-choice' }, a.label));
  } else if (a.kind === 'multi') {
    for (const label of a.labels) answer.appendChild(el('span', { class: 'qa-choice' }, label));
  } else if (a.kind === 'custom') {
    answer.appendChild(el('span', { class: 'qa-custom' }, a.text));
  } else {
    answer.appendChild(el('span', { class: 'qa-skipped' }, 'skipped'));
  }
  const question = el('div', { class: 'qa-q' });
  if (q?.header) question.appendChild(el('span', { class: 'qa-q-header' }, q.header));
  question.appendChild(el('span', { class: 'qa-q-text' }, q?.question ?? ''));
  const item = el('div', { class: 'qa-item', 'data-kind': a.kind }, question, answer);
  if (a.note) item.appendChild(el('div', { class: 'qa-note' }, `— ${a.note}`));
  return item;
}

export function buildQuestionAnswer(questionAnswer, text) {
  const questions = Array.isArray(questionAnswer?.questions) ? questionAnswer.questions : [];
  const answers = parseUserQuestionAnswers(questions, text);
  // Round-trip is the "parseable" test: multi-line custom text, labels holding
  // ', ' and coalesced steers all fail it and fall back to the raw text.
  const faithful = questions.length > 0 && formatUserQuestionAnswers(questions, answers) === text;

  const head = el('div', { class: 'qa-head' },
    el('span', { class: 'qa-badge', title: 'AskUserQuestion answer' }, '❓'),
    questions.length > 1 ? `Answered · ${questions.length} questions` : 'Answered');
  const body = el('div', { class: 'block question-answer' }, head);
  if (!faithful) {
    const raw = buildUserText(text);
    body.appendChild(raw.body);
    return { body, controls: raw.controls };
  }
  const list = el('div', { class: 'qa-list' });
  questions.forEach((q, i) => list.appendChild(buildAnswerItem(q, answers[i])));
  body.appendChild(list);
  return { body, controls: null };
}
