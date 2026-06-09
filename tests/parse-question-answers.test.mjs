// Tests for parseUserQuestionAnswers — the replay-time reverse of
// formatUserQuestionAnswers. Pure logic, no real DOM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Minimal browser stubs so blocks.js (and tts.js which it imports) can load
// in Node without crashing. None of the DOM methods are actually called by the
// pure parseUserQuestionAnswers function — only the module-level listeners in
// tts.js need to exist.
const fakeEl = () => ({
  appendChild() {}, removeChild() {}, replaceChildren() {},
  addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, children: [], hidden: false, textContent: '', value: '',
  disabled: false, dataset: {},
});
globalThis.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBufferSource() { return { connect() {}, start() {}, onended: null, buffer: null }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.1 }); }
};
globalThis.fetch = async () => ({
  ok: true,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
});
globalThis.document = {
  createElement: () => fakeEl(),
  addEventListener() {},
  getElementById() { return null; },
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { parseUserQuestionAnswers, formatUserQuestionAnswers } =
  await import(pathToFileURL(path.join(PUB, 'blocks.js')).href + '?pqa=1');

// Helper: round-trip through format then parse and verify the answers round-trip.
function roundTrip(questions, answers) {
  const text = formatUserQuestionAnswers(questions, answers);
  return parseUserQuestionAnswers(questions, text);
}

// ── Single-question, option answer ──────────────────────────────────────────

test('single question: option answer round-trips correctly', () => {
  const qs = [{ question: 'Pick a fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] }];
  const answers = [{ kind: 'option', label: 'Apple' }];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

test('single question: option answer with note round-trips correctly', () => {
  const qs = [{ question: 'Pick a fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] }];
  const answers = [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

test('single question: custom (typed) answer round-trips as { kind: custom }', () => {
  const qs = [{ question: 'Any preference?', options: [{ label: 'Yes' }, { label: 'No' }] }];
  const answers = [{ kind: 'custom', text: 'Maybe later' }];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

// ── Multi-select ─────────────────────────────────────────────────────────────

test('single question multi-select: two labels round-trip', () => {
  const qs = [{ question: 'Pick fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] }];
  const answers = [{ kind: 'multi', labels: ['Apple', 'Cherry'] }];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

test('single question multi-select: labels with note round-trip', () => {
  const qs = [{ question: 'Pick fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }] }];
  const answers = [{ kind: 'multi', labels: ['Apple', 'Banana'], note: 'organic please' }];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

// ── Multi-question ───────────────────────────────────────────────────────────

test('two questions: both answers round-trip', () => {
  const qs = [
    { question: 'First question', options: [{ label: 'Option A' }, { label: 'Option B' }] },
    { question: 'Second question', options: [{ label: 'Yes' }, { label: 'No' }] },
  ];
  const answers = [
    { kind: 'option', label: 'Option B' },
    { kind: 'option', label: 'Yes' },
  ];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
});

test('two questions: mixed option and custom round-trip', () => {
  const qs = [
    { question: 'Q1', options: [{ label: 'A' }] },
    { question: 'Q2', options: [{ label: 'X' }] },
  ];
  const answers = [
    { kind: 'option', label: 'A' },
    { kind: 'custom', text: 'typed answer' },
  ];
  const got = roundTrip(qs, answers);
  assert.deepEqual(got, answers);
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

test('graceful: unrecognised text returns custom answer (no throw)', () => {
  const qs = [{ question: 'Q', options: [{ label: 'A' }] }];
  // Text doesn't start with the expected prefix — should not throw, just degrade.
  const got = parseUserQuestionAnswers(qs, 'some random text');
  // Falls through to custom since no option matches.
  assert.ok(Array.isArray(got));
  assert.equal(got.length, 1);
  assert.equal(typeof got[0].kind, 'string');
});

test('graceful: multi-question with unrecognised prefix returns nones', () => {
  const qs = [{ question: 'Q1', options: [] }, { question: 'Q2', options: [] }];
  const got = parseUserQuestionAnswers(qs, 'gibberish');
  assert.deepEqual(got, [{ kind: 'none' }, { kind: 'none' }]);
});
