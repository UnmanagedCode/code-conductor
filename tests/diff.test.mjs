import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { lineDiff, diffStats } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'diff.js')).href);

function pretty(ops) {
  return ops.map(o => `${o.op}${o.text}`).join('\n');
}

test('identical inputs produce only equal-ops', () => {
  const ops = lineDiff('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepEqual(ops.map(o => o.op), ['=', '=', '=']);
});

test('pure addition', () => {
  const ops = lineDiff('a\nb\n', 'a\nb\nc\n');
  assert.deepEqual(ops, [{ op: '=', text: 'a' }, { op: '=', text: 'b' }, { op: '+', text: 'c' }]);
});

test('pure deletion', () => {
  const ops = lineDiff('a\nb\nc\n', 'a\nc\n');
  assert.deepEqual(ops, [{ op: '=', text: 'a' }, { op: '-', text: 'b' }, { op: '=', text: 'c' }]);
});

test('replacement is a del followed by an add', () => {
  const ops = lineDiff('a\nB\nc\n', 'a\nb\nc\n');
  const kinds = ops.map(o => o.op).join('');
  assert.match(kinds, /^=[-+][-+]=$/, `unexpected op sequence: ${kinds}`);
  const dels = ops.filter(o => o.op === '-').map(o => o.text);
  const adds = ops.filter(o => o.op === '+').map(o => o.text);
  assert.deepEqual(dels, ['B']);
  assert.deepEqual(adds, ['b']);
});

test('empty old + non-empty new is all adds', () => {
  const ops = lineDiff('', 'a\nb\n');
  assert.deepEqual(ops.map(o => o.op), ['+', '+']);
});

test('non-empty old + empty new is all dels', () => {
  const ops = lineDiff('a\nb\n', '');
  assert.deepEqual(ops.map(o => o.op), ['-', '-']);
});

test('both empty', () => {
  assert.deepEqual(lineDiff('', ''), []);
});

test('reconstructing each side from the ops gives the original text', () => {
  const cases = [
    ['a', 'a'],
    ['a\nb\nc', 'a\nx\nc'],
    ['a\nb\nc\nd\ne', 'a\nc\nd\nf'],
    ['', 'hello\nworld'],
    ['hello\nworld', ''],
  ];
  for (const [a, b] of cases) {
    const ops = lineDiff(a, b);
    const oldSide = ops.filter(o => o.op !== '+').map(o => o.text).join('\n');
    const newSide = ops.filter(o => o.op !== '-').map(o => o.text).join('\n');
    const aStripped = a.replace(/\n$/, '');
    const bStripped = b.replace(/\n$/, '');
    assert.equal(oldSide, aStripped, `old side round-trip failed:\n${pretty(ops)}`);
    assert.equal(newSide, bStripped, `new side round-trip failed:\n${pretty(ops)}`);
  }
});

test('diffStats counts adds and dels', () => {
  const ops = lineDiff('a\nb\nc\n', 'a\nx\ny\nc\n');
  const { adds, dels } = diffStats(ops);
  assert.equal(adds, 2);
  assert.equal(dels, 1);
});

test('handles trailing newline normalization', () => {
  const a = lineDiff('a\nb\n', 'a\nb');
  // Both sides logically contain ['a', 'b'] after stripping trailing newline.
  assert.deepEqual(a.map(o => o.op), ['=', '=']);
});
