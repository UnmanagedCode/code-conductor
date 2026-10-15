// The narration rule, as a table: narration iff the block is thinking WITH text
// and the block immediately before it in the same message is thinking with
// EMPTY text (redacted). One subtest per row, so no row hides behind another.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNarration } from '../src/narration.ts';

const redacted = { type: 'thinking', text: '' };
const thought = (text) => ({ type: 'thinking', text });

const ROWS = [
  ['redacted thinking → thinking with text', redacted, thought('Next I will check the parser.'), true],
  ['first block of the message (no predecessor)', null, thought('Next I will check the parser.'), false],
  ['thinking with text → thinking with text (a never-redacted model)', thought('pondering'), thought('more pondering'), false],
  ['redacted → redacted', redacted, redacted, false],
  ['redacted → a text block', redacted, { type: 'text', text: 'the answer' }, false],
  ['tool_use → thinking with text', { type: 'tool_use', text: '' }, thought('Next I will check the parser.'), false],
];

test('isNarration: the owner\'s rule and only that rule', async (t) => {
  for (const [label, prev, cur, expected] of ROWS) {
    await t.test(label, () => assert.equal(isNarration(prev, cur), expected));
  }
});
