import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { splitRows, lineType } = await import(pathToFileURL(path.resolve(__dirname, '..', 'shared', 'diffSplit.ts')).href);
const { parseUnifiedDiff } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'gitDiff.ts')).href);

const cell = (c) => (c ? `${c.content}${c.num ?? '?'}${c.type === 'ctx' ? '' : ' ' + c.type}` : '∅');
function pretty(rows) {
  return rows.map((r) => `${cell(r.left)} | ${cell(r.right)}`);
}
const ln = (type, content) => ({ type, content });

test('context lines sit on both sides with their own old and new numbers', () => {
  const rows = splitRows({ header: '@@ -3,2 +8,2 @@', lines: [ln('ctx', 'a'), ln('ctx', 'b')] });
  assert.deepEqual(pretty(rows), ['a3 | a8', 'b4 | b9']);
});

test('a deletion run longer than its addition run leaves blank right cells', () => {
  const rows = splitRows({ header: '@@ -10,3 +20,1 @@', lines: [ln('del', 'p'), ln('del', 'q'), ln('del', 'r'), ln('add', 'P')] });
  assert.deepEqual(pretty(rows), ['p10 del | P20 add', 'q11 del | ∅', 'r12 del | ∅']);
});

test('an addition run longer than its deletion run leaves blank left cells', () => {
  const rows = splitRows({ header: '@@ -10,1 +20,3 @@', lines: [ln('del', 'p'), ln('add', 'P'), ln('add', 'Q'), ln('add', 'R')] });
  assert.deepEqual(pretty(rows), ['p10 del | P20 add', '∅ | Q21 add', '∅ | R22 add']);
});

test('two change runs in one hunk pair separately, numbered across the context between them', () => {
  const rows = splitRows({
    header: '@@ -10,6 +20,6 @@',
    lines: [ln('ctx', 'a'), ln('del', 'b'), ln('del', 'c'), ln('del', 'd'), ln('add', 'B'), ln('ctx', 'e'), ln('add', 'F'), ln('add', 'G'), ln('ctx', 'h')],
  });
  assert.deepEqual(pretty(rows), ['a10 | a20', 'b11 del | B21 add', 'c12 del | ∅', 'd13 del | ∅', 'e14 | e22', '∅ | F23 add', '∅ | G24 add', 'h15 | h25']);
});

test('an additions-only hunk has every left cell blank', () => {
  const rows = splitRows({ header: '@@ -0,0 +1,3 @@', lines: [ln('add', 'x'), ln('add', 'y'), ln('add', 'z')] });
  assert.deepEqual(pretty(rows), ['∅ | x1 add', '∅ | y2 add', '∅ | z3 add']);
});

test('a deletions-only hunk has every right cell blank', () => {
  const rows = splitRows({ header: '@@ -1,3 +0,0 @@', lines: [ln('del', 'x'), ln('del', 'y'), ln('del', 'z')] });
  assert.deepEqual(pretty(rows), ['x1 del | ∅', 'y2 del | ∅', 'z3 del | ∅']);
});

test('a header without counts still numbers from its starts', () => {
  const rows = splitRows({ header: '@@ -5 +7 @@', lines: [ln('ctx', 'a'), ln('del', 'b'), ln('add', 'B')] });
  assert.deepEqual(pretty(rows), ['a5 | a7', 'b6 del | B8 add']);
});

test('an unparseable header pairs the lines with every number null', () => {
  const rows = splitRows({ header: '@@ h @@', lines: [ln('ctx', 'a'), ln('del', 'b'), ln('add', 'B'), ln('add', 'C')] });
  assert.deepEqual(pretty(rows), ['a? | a?', 'b? del | B? add', '∅ | C? add']);
});

test('an unknown line type renders as context on both sides', () => {
  assert.equal(lineType('weird'), 'ctx');
  assert.equal(lineType('add'), 'add');
  assert.equal(lineType('del'), 'del');
  const rows = splitRows({ header: '@@ -1,1 +4,1 @@', lines: [ln('weird', 'w')] });
  assert.deepEqual(pretty(rows), ['w1 | w4']);
});

test('"\\ No newline at end of file" from git adds no row and shifts no number', () => {
  const NN = '\\ No newline at end of file';
  const hunkOf = (body) => {
    const raw = `diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n${body.join('\n')}\n`;
    const h = parseUnifiedDiff(raw)[0].hunks[0];
    const real = body.filter((l) => /^[-+ ]/.test(l)).length;
    assert.equal(h.lines.length, real);
    return h;
  };
  // marker after the old side's last line
  let h = hunkOf(['@@ -1,2 +1,2 @@', ' a', '-b', NN, '+b']);
  assert.deepEqual(pretty(splitRows(h)), ['a1 | a1', 'b2 del | b2 add']);
  // marker after the new side's last line
  h = hunkOf(['@@ -1,2 +1,3 @@', ' a', '-b', '+c', '+d', NN]);
  assert.deepEqual(pretty(splitRows(h)), ['a1 | a1', 'b2 del | c2 add', '∅ | d3 add']);
  // marker between the sides inside one run
  h = hunkOf(['@@ -1,2 +1,1 @@', '-x', '-y', NN, '+z']);
  assert.deepEqual(pretty(splitRows(h)), ['x1 del | z1 add', 'y2 del | ∅']);
});
