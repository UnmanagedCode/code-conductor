// The gate's row tag, and what it must not disturb (card 2026-0344).
//
// `gate:systems` now runs its two rows CONCURRENTLY, so their live output
// interleaves. Each row's chunks go through createRowPrefix, which tags whole
// lines — the alternative, buffering each row and flushing at the end, would give
// ~108s of total silence and, on a wedged row, no live output at all until the run
// cap, trading this gate's diagnosability for tidiness.
//
// Two properties, and the second is the one that would fail SILENTLY: the tag is
// presentation only. tests/gateSummary.mjs's scanner is fed the RAW chunk, before
// the transform, so the failing test names and the hang-guard verdict in the
// closing block are byte-identical to what a sequential gate produced. Prefixed
// text matches neither pattern — pinned below — so feeding the scanner the tagged
// stream instead would lose every diagnosis while every row still reported PASS.
//
// Pure and in-memory: no child processes, no gate run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowPrefix } from './rowPrefix.mjs';
import { scanRowOutput, createRowScanner } from './gateSummary.mjs';

const TAG = '[1] ';
const ROW = [
  '▶ a nested failing case',
  '  ✖ inner one (1.001128ms)',
  '✖ top level failing case (0.171447ms)',
  'ℹ fail 2',
  'hang-guard: 359/359 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached',
  'guardrail: peak concurrent fake-claude subprocesses = 7 (budget 12)',
].join('\n') + '\n';

// Drive the transform with an explicit chunk list and collect what it emits.
async function through(chunks, tag = TAG) {
  const t = createRowPrefix(tag);
  const out = [];
  t.on('data', c => out.push(String(c)));
  const done = new Promise(r => t.on('end', r));
  for (const c of chunks) t.write(c);
  t.end();
  await done;
  return out;
}

test('every emitted line carries the tag at column 0, whatever the chunk boundaries', async () => {
  // The property the live tee needs and a whole-string test cannot see: the child's
  // stdout splits at arbitrary bytes, and a tag placed mid-line would corrupt the
  // very output the operator reads. Sliced one character at a time — the worst
  // case — the result must equal the whole-string result. Same property
  // tests/systems-gate-summary.test.mjs pins for the scanner.
  const whole = (await through([ROW])).join('');
  const byChar = (await through([...ROW])).join('');
  assert.equal(byChar, whole);
  assert.equal(whole, ROW.split('\n').slice(0, -1).map(l => `${TAG}${l}\n`).join(''));

  // And no emitted chunk is ever a fragment: a reader that flushes per chunk — a
  // terminal — must never see half a line without its tag.
  for (const chunk of await through([...ROW])) {
    assert.ok(chunk.endsWith('\n'), `emitted a fragment: ${JSON.stringify(chunk)}`);
    for (const line of chunk.split('\n').slice(0, -1)) {
      assert.ok(line.startsWith(TAG), `untagged line: ${JSON.stringify(line)}`);
    }
  }
});

test('a trailing fragment with no newline is flushed, with its tag, at stream end', async () => {
  // A runner killed mid-write must not lose its last line — which can be the
  // verdict. Without the flush the fragment is simply dropped.
  const out = (await through(['done: 3 of 4', ' files'])).join('');
  assert.equal(out, `${TAG}done: 3 of 4 files`);
});

test('a lone newline and an empty write are not swallowed', async () => {
  assert.equal((await through(['a\n', '\n', 'b\n'])).join(''), `${TAG}a\n${TAG}\n${TAG}b\n`);
  assert.equal((await through(['', 'a\n'])).join(''), `${TAG}a\n`);
});

test('the tag is presentation only: the scanner must be fed the RAW chunk', async () => {
  // The gate scans before it prefixes. This pins BOTH halves of why:
  //   * a scanner fed the raw chunks says exactly what a whole-string scan of the
  //     untagged row says — so the closing block is unchanged by concurrency;
  //   * a scanner fed the TAGGED stream finds nothing at all, because every pattern
  //     in tests/gateSummary.mjs anchors at the start of the line. Feeding it the
  //     transform's output would lose every failing test name and the hang-guard
  //     verdict while the row still reported its exit code.
  const live = createRowScanner();
  for (const ch of ROW) live.push(ch);
  assert.deepEqual(live.result(), scanRowOutput(ROW));
  assert.ok(scanRowOutput(ROW).failingTests.length > 0, 'sanity: the row names failures');

  const tagged = (await through([...ROW])).join('');
  assert.deepEqual(scanRowOutput(tagged), { failingTests: [], hangGuard: null },
    'a tagged stream is unscannable — which is why the raw chunk is what is scanned');
});
