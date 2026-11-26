// Unit tests of the context chip's wire format (shared/contextChip.ts) and its
// per-session slot (src/contextChip.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIP_MARKER, formatChipBlock, composeChipMessage, parseLeadingChip,
} from '../shared/contextChip.ts';
import { ContextChipSlot, validateChipInput, CHIP_TITLE_MAX, CHIP_DATA_MAX } from '../src/contextChip.ts';

// Invariant: the block is unambiguous — data holding backtick fences of any
// length can neither close the block early nor leak into the typed text.
test('format→parse round-trips data containing backtick fences', () => {
  for (const data of ['plain', 'a\n```js\ncode\n```\nb', '````\nfour\n````', '```', 'x`y``z', '']) {
    const msg = composeChipMessage({ title: 'T', data }, 'typed text');
    assert.deepEqual(parseLeadingChip(msg), { title: 'T', data, rest: 'typed text' }, JSON.stringify(data));
  }
});

// Invariant: a chip-only message parses with an empty rest, and a trailing
// newline in data is normalised to one (the formatter adds it when absent).
test('a chip-only message has an empty rest; one trailing newline in data is normalised', () => {
  assert.deepEqual(parseLeadingChip(composeChipMessage({ title: 'T', data: 'd' }, '')), { title: 'T', data: 'd', rest: '' });
  assert.equal(parseLeadingChip(composeChipMessage({ title: 'T', data: 'd\n' }, '')).data, 'd');
});

// Invariant (decision 1): only cc's marker makes a chip — a typed "Context:"
// line with a fenced block is plain text.
test('a typed Context: line with a fenced block and no marker is not a chip', () => {
  assert.equal(parseLeadingChip('Context: foo\n```\nbar\n```\n\nhello'), null);
  assert.equal(parseLeadingChip(`hi ${CHIP_MARKER} Context: foo\n\`\`\`\nbar\n\`\`\``), null);
});

// Invariant: anything that is not exactly a composed block is not a chip.
test('malformed or unterminated block parses to null', () => {
  const ok = composeChipMessage({ title: 'T', data: 'd' }, 'x');
  assert.notEqual(parseLeadingChip(ok), null);
  assert.equal(parseLeadingChip(`${CHIP_MARKER} Context: T`), null, 'no fence');
  assert.equal(parseLeadingChip(`${CHIP_MARKER} Context: T\n\`\`\`\nd\n`), null, 'unterminated');
  assert.equal(parseLeadingChip(`${CHIP_MARKER} Context: T\n\`\`\`\nd\n\`\`\`glued`), null, 'text glued to the closing fence');
  assert.equal(parseLeadingChip(`${CHIP_MARKER} Context: T\n\`\`\`\nd\n\`\`\`\nno blank line`), null, 'no blank-line separator');
  assert.equal(parseLeadingChip(`${CHIP_MARKER} Context: T\nnot a fence\nd\n`), null);
});

// Invariant: the dictation tag after a chip survives, so the voice badge still works.
test('rest keeps the <transcribed> prefix', () => {
  const msg = composeChipMessage({ title: 'T', data: 'd' }, '<transcribed>\nspoken words');
  assert.equal(parseLeadingChip(msg).rest, '<transcribed>\nspoken words');
});

function slot() {
  const seen = [];
  const s = new ContextChipSlot(c => seen.push(c));
  return { s, seen };
}

// Invariant (1): setting always replaces the current chip, with a fresh rev
// that never repeats, and announces it.
test('set always replaces and bumps rev', () => {
  const { s, seen } = slot();
  const a = s.set('A', 'da');
  const b = s.set('B', 'db');
  assert.equal(s.get().title, 'B');
  assert.ok(b.rev > a.rev);
  assert.deepEqual(seen.map(c => c.title), ['A', 'B']);
  s.clear();
  assert.ok(s.set('C', 'dc').rev > b.rev, 'rev survives a clear');
});

// Invariant (4, race): a × naming a stale rev must not remove a replacement the
// user never saw; clearing without a rev is unconditional.
test('clear with a stale rev is a no-op; without a rev it clears', () => {
  const { s, seen } = slot();
  const a = s.set('A', 'd');
  s.set('B', 'd');
  assert.equal(s.clear(a.rev), false);
  assert.equal(s.get().title, 'B');
  assert.equal(seen.length, 2, 'a refused clear announces nothing');
  assert.equal(s.clear(), true);
  assert.equal(s.get(), null);
  assert.equal(s.clear(), false, 'nothing to clear');
  assert.equal(seen.at(-1), null);
});

// Invariant (exactly once): a chip is delivered by one take; the second returns null.
test('take succeeds once for a rev; a second take returns null', () => {
  const { s, seen } = slot();
  const a = s.set('A', 'd');
  assert.deepEqual(s.take(a.rev), a);
  assert.equal(s.take(a.rev), null);
  assert.equal(s.get(), null);
  assert.equal(seen.at(-1), null, 'a take announces the clear');
});

// Invariant (decision 2): a stale rev takes nothing and leaves the replacement pending.
test('take with a stale rev returns null and leaves the chip', () => {
  const { s } = slot();
  const a = s.set('A', 'd');
  const b = s.set('B', 'd');
  assert.equal(s.take(a.rev), null);
  assert.equal(s.get().rev, b.rev);
});

// Invariant: a failed send puts the chip back, but never over or after a change.
test('restore after take puts the chip back only if nothing changed since', () => {
  const { s } = slot();
  const a = s.set('A', 'd');
  s.take(a.rev);
  s.restore(a);
  assert.equal(s.get().rev, a.rev, 'restored when nothing moved');

  const b = s.take(a.rev);
  s.set('B', 'd');
  s.restore(b);
  assert.equal(s.get().title, 'B', 'a replacement is not overwritten');

  const c = s.take(s.get().rev);
  s.set('C', 'd');
  s.clear();
  s.restore(c);
  assert.equal(s.get(), null, 'a set-then-cleared slot is not resurrected');
});

// Invariant: the REST body is refused with INVALID_ARGUMENT (400) when the title
// is not a non-empty single line within its cap or the data is not a string within its cap.
test('validateChipInput refuses an empty, multi-line or oversized title, and non-string or oversized data, with INVALID_ARGUMENT', () => {
  assert.deepEqual(validateChipInput({ title: '  T  ', data: 'd' }), { title: 'T', data: 'd' });
  assert.deepEqual(validateChipInput({ title: 'T', data: '' }), { title: 'T', data: '' });
  const bad = [
    null, {}, { title: 1, data: 'd' }, { title: '   ', data: 'd' }, { title: 'a\nb', data: 'd' }, { title: 'a\rb', data: 'd' },
    { title: 'x'.repeat(CHIP_TITLE_MAX + 1), data: 'd' }, { title: 'T' }, { title: 'T', data: 5 },
    { title: 'T', data: 'x'.repeat(CHIP_DATA_MAX + 1) },
  ];
  for (const b of bad) {
    assert.throws(() => validateChipInput(b), (e) => e.statusCode === 400 && e.code === 'INVALID_ARGUMENT', JSON.stringify(b)?.slice(0, 40));
  }
  assert.doesNotThrow(() => validateChipInput({ title: 'x'.repeat(CHIP_TITLE_MAX), data: 'x'.repeat(CHIP_DATA_MAX) }));
});
