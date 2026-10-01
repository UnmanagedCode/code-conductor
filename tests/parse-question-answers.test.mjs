// Tests for parseUserQuestionAnswers — the replay-time reverse of
// formatUserQuestionAnswers. Pure logic, no DOM: the module is DOM-free and
// blocks.js's same-reference re-export is pinned in user-question-format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUserQuestionAnswers, parseUserQuestionAnswers, isUserQuestionAnswerText,
  parseCanonicalUserQuestionAnswers,
} from '../public/userQuestionAnswers.js';

// ── Round-trip: for every canonical answer, parse inverts format exactly ─────

const opts = (...labels) => labels.map(label => ({ label }));
const Q = (question, labels, extra = {}) => ({ question, options: opts(...labels), ...extra });
const FRUIT = Q('Pick a fruit', ['Apple', 'Banana']);
const TOPPINGS = Q('Pick toppings', ['Nuts', 'Cream', 'Syrup'], { multiSelect: true });
const DASH = Q('Pick', ['Fast — risky', 'Slow — safe']);
const PREFIXED = Q('Sure?', ['Yes', 'Yes — sure']);
const COMMA = Q('Pick types', ['Lists, tuples', 'Dicts', 'a", "b'], { multiSelect: true });
const SAME = Q('Same?', ['Yes', 'No']);
const QUOTED = Q('Is "x" ok? \\ really', ['say "hi"', 'back\\slash']);
const LOOKALIKE = Q('Odd labels', ['(no answer)', '(own answer) x']);

const ROUND_TRIP = {
  'option': [[FRUIT], [{ kind: 'option', label: 'Apple' }]],
  'option with note': [[FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }]],
  'multi': [[TOPPINGS], [{ kind: 'multi', labels: ['Nuts', 'Syrup'] }]],
  'multi with note': [[TOPPINGS], [{ kind: 'multi', labels: ['Nuts', 'Cream'], note: 'lots' }]],
  'one-label multi': [[TOPPINGS], [{ kind: 'multi', labels: ['Cream'] }]],
  'custom': [[FRUIT], [{ kind: 'custom', text: 'Maybe later' }]],
  'none, single question': [[FRUIT], [{ kind: 'none' }]],
  'none inside a multi-question answer': [[FRUIT, TOPPINGS], [{ kind: 'none' }, { kind: 'multi', labels: ['Nuts'] }]],
  'case 1: a label holding " — "': [[DASH], [{ kind: 'option', label: 'Slow — safe' }]],
  'case 1: a label holding " — " with a note': [[DASH], [{ kind: 'option', label: 'Slow — safe', note: 'thanks' }]],
  'case 2: the longer label that begins with another': [[PREFIXED], [{ kind: 'option', label: 'Yes — sure' }]],
  'case 2: the shorter label with a note': [[PREFIXED], [{ kind: 'option', label: 'Yes', note: 'sure' }]],
  'case 3: custom text that begins with "<label> — "': [[PREFIXED], [{ kind: 'custom', text: 'Yes — maybe' }]],
  'case 3: custom text equal to a label': [[PREFIXED], [{ kind: 'custom', text: 'Yes' }]],
  'case 4: a multiSelect label holding ", "': [[COMMA], [{ kind: 'multi', labels: ['Lists, tuples', 'Dicts'] }]],
  'case 4: a multiSelect label holding ", " with a note': [[COMMA], [{ kind: 'multi', labels: ['Dicts', 'Lists, tuples'], note: 'n' }]],
  'case 4: a label holding a quoted ", "': [[COMMA], [{ kind: 'multi', labels: ['a", "b'] }]],
  'case 5: two questions with identical text': [[SAME, SAME],
    [{ kind: 'option', label: 'No', note: 'second' }, { kind: 'option', label: 'Yes', note: 'first' }]],
  'case 6: multi-line note and custom text in a two-question card': [[FRUIT, SAME],
    [{ kind: 'option', label: 'Apple', note: 'line one\nline two' }, { kind: 'custom', text: 'extra\nlarge' }]],
  'case 6: a single-question multi-line note': [[FRUIT], [{ kind: 'option', label: 'Apple', note: 'a\n\nb' }]],
  'quotes and backslashes in label, note and question': [[QUOTED],
    [{ kind: 'option', label: 'say "hi"', note: 'C:\\path "q"' }]],
  'quotes and backslashes in custom text': [[QUOTED], [{ kind: 'custom', text: '"\\' }]],
  'quotes and backslashes in a multi-question answer': [[QUOTED, QUOTED],
    [{ kind: 'option', label: 'back\\slash' }, { kind: 'custom', text: 'a "b" \\ c' }]],
  'a label that reads (no answer)': [[LOOKALIKE], [{ kind: 'option', label: '(no answer)' }]],
  'a label that reads (own answer) x': [[LOOKALIKE], [{ kind: 'option', label: '(own answer) x' }]],
  'a note holding ") (note: "': [[FRUIT], [{ kind: 'option', label: 'Apple', note: '") (note: "' }]],
  'question text holding a newline (collapsed)': [[Q('Line one\nline two?', ['A'])], [{ kind: 'option', label: 'A' }]],
  'a missing question field, single': [[{ options: opts('A') }], [{ kind: 'option', label: 'A' }]],
  'a missing question field, multi': [[{ options: opts('A') }, { options: opts('B') }],
    [{ kind: 'option', label: 'A' }, { kind: 'custom', text: 'b' }]],
  'emoji and em dash in a note': [[FRUIT], [{ kind: 'option', label: 'Apple', note: '🍎 — yes' }]],
};

test('round-trip: parse(format(x)) deepEquals x and the correlator recognises the text', async (t) => {
  for (const [name, [questions, answers]] of Object.entries(ROUND_TRIP)) {
    await t.test(name, () => {
      const text = formatUserQuestionAnswers(questions, answers);
      assert.deepEqual(parseUserQuestionAnswers(questions, text), answers, text);
      assert.equal(isUserQuestionAnswerText(questions, text), true, text);
    });
  }
});

// ── Rejection: the parser is strict and degrades to all-none, never throws ───

const TWO = [Q('Q1', ['A', 'B']), Q('Q2', ['X', 'Y'])];
const valid = (qs, as) => formatUserQuestionAnswers(qs, as);

const REJECT = {
  'old single-question format': [[FRUIT], 'Answer to "Pick a fruit": Apple'],
  'old multi-question format': [TWO, 'My answers:\n- Q1: A\n- Q2: X'],
  'a valid answer followed by a coalesced steer': [[FRUIT],
    valid([FRUIT], [{ kind: 'option', label: 'Apple' }]) + '\n\nnext prompt'],
  'a valid multi answer followed by a coalesced steer': [TWO,
    valid(TWO, [{ kind: 'option', label: 'A' }, { kind: 'option', label: 'X' }]) + '\n\nnext prompt'],
  'an unoffered label': [[FRUIT], 'Answer to "Pick a fruit": "Cherry"'],
  'two labels on a single-choice question': [[FRUIT], 'Answer to "Pick a fruit": "Apple", "Banana"'],
  'a missing line': [TWO, 'My answers:\n1. "Q1": "A"'],
  'an extra line': [TWO, 'My answers:\n1. "Q1": "A"\n2. "Q2": "X"\n3. "Q3": "Z"'],
  'lines 2./1. swapped': [TWO, 'My answers:\n2. "Q2": "X"\n1. "Q1": "A"'],
  'an unterminated quote': [[FRUIT], 'Answer to "Pick a fruit": "Apple'],
  'a raw newline inside a quote': [[FRUIT], 'Answer to "Pick a fruit": "Apple" (note: "a\nb")'],
  'a question prefix naming another question': [[FRUIT], 'Answer to "Pick a colour": "Apple"'],
  'an unquoted custom answer': [[FRUIT], 'Answer to "Pick a fruit": (own answer) Mango'],
  'a note with nothing after it closed': [[FRUIT], 'Answer to "Pick a fruit": "Apple" (note: "x"'],
  'unrecognised text': [[FRUIT], 'some random text'],
};

test('rejection: malformed or foreign text parses to all-none without throwing', async (t) => {
  for (const [name, [questions, text]] of Object.entries(REJECT)) {
    await t.test(name, () => {
      assert.deepEqual(parseUserQuestionAnswers(questions, text), questions.map(() => ({ kind: 'none' })));
    });
  }
});

// ── Canonical gate: parsed answers only for the formatter's exact output ─────

test('parseCanonicalUserQuestionAnswers returns the answers for canonical text and null otherwise', async (t) => {
  await t.test('canonical text', () => {
    const answers = [{ kind: 'option', label: 'Banana', note: 'ripe' }];
    assert.deepEqual(parseCanonicalUserQuestionAnswers([FRUIT], formatUserQuestionAnswers([FRUIT], answers)), answers);
  });
  await t.test('canonical text whose answer is a skip', () => {
    assert.deepEqual(parseCanonicalUserQuestionAnswers([FRUIT], 'Answer to "Pick a fruit": (no answer)'), [{ kind: 'none' }]);
  });
  for (const [name, text] of Object.entries({
    'untrimmed custom text': 'Answer to "Pick a fruit": (own answer) " Mango "',
    'a JSON-escape spelling of a label': 'Answer to "Pick a fruit": "\\u0041pple"',
    'an empty note clause': 'Answer to "Pick a fruit": "Apple" (note: "")',
    'old-format text': 'Answer to "Pick a fruit": Apple',
  })) {
    await t.test(name, () => assert.equal(parseCanonicalUserQuestionAnswers([FRUIT], text), null));
  }
  await t.test('no questions', () => assert.equal(parseCanonicalUserQuestionAnswers([], 'anything'), null));
});

test('a non-string question text never makes the parse or the gate throw', async (t) => {
  for (const [name, question] of Object.entries({ number: 5, false: false, object: {}, array: ['a'] })) {
    const qs = [{ question, options: opts('A') }];
    const two = [{ question, options: opts('A') }, { question, options: opts('B') }];
    await t.test(`${name}: foreign text → parse all-none, gate null`, () => {
      assert.deepEqual(parseUserQuestionAnswers(qs, 'x'), [{ kind: 'none' }]);
      assert.equal(parseCanonicalUserQuestionAnswers(qs, 'x'), null);
      assert.equal(parseCanonicalUserQuestionAnswers(two, 'x'), null);
    });
    await t.test(`${name}: the formatter's own text → the gate returns its answers`, () => {
      const answers = [{ kind: 'option', label: 'A', note: 'n' }];
      assert.deepEqual(parseCanonicalUserQuestionAnswers(qs, formatUserQuestionAnswers(qs, answers)), answers);
      const both = [{ kind: 'option', label: 'A' }, { kind: 'custom', text: 'b' }];
      assert.deepEqual(parseCanonicalUserQuestionAnswers(two, formatUserQuestionAnswers(two, both)), both);
    });
  }
});

// ── Graceful degradation ─────────────────────────────────────────────────────

test('graceful: null text returns array of { kind: none }', () => {
  const qs = [{ question: 'Q', options: [{ label: 'A' }] }];
  const got = parseUserQuestionAnswers(qs, null);
  assert.deepEqual(got, [{ kind: 'none' }]);
});

test('graceful: empty questions returns empty array', () => {
  const got = parseUserQuestionAnswers([], 'anything');
  assert.deepEqual(got, []);
});

test('graceful: null questions returns empty array', () => {
  const got = parseUserQuestionAnswers(null, 'anything');
  assert.deepEqual(got, []);
});

test('graceful: multi-question with unrecognised prefix returns nones', () => {
  const qs = [{ question: 'Q1', options: [] }, { question: 'Q2', options: [] }];
  const got = parseUserQuestionAnswers(qs, 'gibberish');
  assert.deepEqual(got, [{ kind: 'none' }, { kind: 'none' }]);
});
