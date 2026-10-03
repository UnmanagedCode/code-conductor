// firstLine / eolOf / withEol (src/lineEndings.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLine, eolOf, withEol } from '../src/lineEndings.ts';

test('firstLine drops the line ending of line 1 only', () => {
  assert.equal(firstLine('a\nb'), 'a');
  assert.equal(firstLine('a\r\nb\r\n'), 'a');
  assert.equal(firstLine('a'), 'a');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('a\r'), 'a');
});

test('eolOf reads line 1; null, newline-free and LF are LF', () => {
  assert.equal(eolOf('a\r\nb\r\n'), '\r\n');
  assert.equal(eolOf('a\nb\r\n'), '\n');
  assert.equal(eolOf('a\r\nb\n'), '\r\n');
  assert.equal(eolOf('a'), '\n');
  assert.equal(eolOf(''), '\n');
  assert.equal(eolOf(null), '\n');
  assert.equal(eolOf('\nx'), '\n');
});

test('withEol normalizes mixed input to one ending', () => {
  assert.equal(withEol('a\r\nb\nc', '\n'), 'a\nb\nc');
  assert.equal(withEol('a\r\nb\nc', '\r\n'), 'a\r\nb\r\nc');
  assert.equal(withEol('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(withEol('', '\r\n'), '');
});
