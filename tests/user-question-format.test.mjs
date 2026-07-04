// Parity + canonical-output tests for the AskUserQuestion answer formatter.
//
// The whole point of extracting public/userQuestionAnswers.js is that the UI
// question card and the answer_question MCP tool call ONE function — no fork.
// These tests lock the canonical strings AND prove the re-export is the same
// function reference, so a divergence can't creep in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUserQuestionAnswers } from '../public/userQuestionAnswers.js';
import { formatUserQuestionAnswers as fromBlocks } from '../public/blocks.js';

test('blocks.js re-exports the SAME formatter function (no fork)', () => {
  assert.equal(fromBlocks, formatUserQuestionAnswers,
    'public/blocks.js must re-export the canonical formatter, not a copy');
});

const fruit = { question: 'Pick a fruit', header: 'Fruit', multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }] };

test('single option → short form', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple' }]),
    'Answer to "Pick a fruit": Apple');
});

test('single option + note', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple', note: 'crisp' }]),
    'Answer to "Pick a fruit": Apple — crisp');
});

test('multi-select labels', () => {
  const q = { ...fruit, multiSelect: true };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'multi', labels: ['Apple', 'Banana'] }]),
    'Answer to "Pick a fruit": Apple, Banana');
});

test('multi-select + note', () => {
  const q = { ...fruit, multiSelect: true };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'multi', labels: ['Apple', 'Banana'], note: 'both' }]),
    'Answer to "Pick a fruit": Apple, Banana — both');
});

test('custom typed answer is trimmed', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'custom', text: '  Mango  ' }]),
    'Answer to "Pick a fruit": Mango');
});

test('none → (no answer)', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'none' }]),
    'Answer to "Pick a fruit": (no answer)');
});

test('multi-question long form', () => {
  const q2 = { question: 'Pick a colour', header: 'Colour', multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Blue' }] };
  assert.equal(
    formatUserQuestionAnswers([fruit, q2], [
      { kind: 'option', label: 'Apple' },
      { kind: 'option', label: 'Blue', note: 'sky' },
    ]),
    'My answers:\n- Pick a fruit: Apple\n- Pick a colour: Blue — sky');
});
