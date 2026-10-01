// Parity + canonical-output tests for the AskUserQuestion answer formatter.
//
// The whole point of extracting public/userQuestionAnswers.js is that the UI
// question card and the answer_question MCP tool call ONE function — no fork.
// These tests lock the canonical strings (the exact bytes the model reads)
// AND prove the re-export is the same function reference, so a divergence
// can't creep in.

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

test('single option → short form, label quoted', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple' }]),
    'Answer to "Pick a fruit": "Apple"');
});

test('single option + note', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple', note: 'crisp' }]),
    'Answer to "Pick a fruit": "Apple" (note: "crisp")');
});

test('multi-select labels', () => {
  const q = { ...fruit, multiSelect: true };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'multi', labels: ['Apple', 'Banana'] }]),
    'Answer to "Pick a fruit": "Apple", "Banana"');
});

test('multi-select + note', () => {
  const q = { ...fruit, multiSelect: true };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'multi', labels: ['Apple', 'Banana'], note: 'both' }]),
    'Answer to "Pick a fruit": "Apple", "Banana" (note: "both")');
});

test('custom typed answer is marked (own answer), quoted and trimmed', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'custom', text: '  Mango  ' }]),
    'Answer to "Pick a fruit": (own answer) "Mango"');
});

test('a custom answer equal to an offered label is still marked (own answer)', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'custom', text: 'Apple' }]),
    'Answer to "Pick a fruit": (own answer) "Apple"');
});

test('none → (no answer)', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'none' }]),
    'Answer to "Pick a fruit": (no answer)');
});

test('whitespace-only note is omitted', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple', note: '  \n ' }]),
    'Answer to "Pick a fruit": "Apple"');
});

test('a label holding " — " stays literal inside its quotes', () => {
  const q = { question: 'Pick', options: [{ label: 'Fast — risky' }, { label: 'Slow — safe' }] };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'option', label: 'Slow — safe', note: 'thanks' }]),
    'Answer to "Pick": "Slow — safe" (note: "thanks")');
});

test('a note holding a quote, a backslash and a newline is JSON-escaped onto one line', () => {
  assert.equal(
    formatUserQuestionAnswers([fruit], [{ kind: 'option', label: 'Apple', note: 'say "hi"\\\nbye' }]),
    'Answer to "Pick a fruit": "Apple" (note: "say \\"hi\\"\\\\\\nbye")');
});

test('question text holding a quote is JSON-escaped in the prefix', () => {
  const q = { question: 'Is "x" ok?', options: [{ label: 'Yes' }] };
  assert.equal(
    formatUserQuestionAnswers([q], [{ kind: 'none' }]),
    'Answer to "Is \\"x\\" ok?": (no answer)');
});

test('multi-question long form: numbered lines, each question quoted', () => {
  const q2 = { question: 'Pick a colour', header: 'Colour', multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Blue' }] };
  assert.equal(
    formatUserQuestionAnswers([fruit, q2], [
      { kind: 'option', label: 'Apple' },
      { kind: 'option', label: 'Blue', note: 'sky' },
    ]),
    'My answers:\n1. "Pick a fruit": "Apple"\n2. "Pick a colour": "Blue" (note: "sky")');
});

test('multi-question with duplicate question text and a multi-line note', () => {
  const same = { question: 'Same?', options: [{ label: 'Yes' }, { label: 'No' }] };
  assert.equal(
    formatUserQuestionAnswers([same, same], [
      { kind: 'option', label: 'Yes' },
      { kind: 'option', label: 'No', note: 'line one\nline two' },
    ]),
    'My answers:\n1. "Same?": "Yes"\n2. "Same?": "No" (note: "line one\\nline two")');
});
