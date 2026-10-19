// The quiet reporter (tests/quietReporter.mjs): what tests/run.mjs prints for a
// passing file, a failing one, and under CC_TEST_VERBOSE=1.
//
// The cases run the REAL runner over the quiet-* fixtures through the hang-guard
// harness (tests/hangGuardCase.mjs), which pins CC_TEST_VERBOSE in the child's
// env, so an exported CC_TEST_VERBOSE=1 cannot flip them. The quiet reporter's
// red-run paths (a killed file, NO REPORT, the run cap, a stream stall, a
// leaked-process sweep) are asserted in the tests/hang-guard-*.test.mjs case for
// each path, against that case's own fixture marker.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { FAST, fixture, runGuard } from './hangGuardCase.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const QUIET_PASS_MARKERS = [/quiet-pass: stdout marker/, /quiet-pass: stderr marker/];
const QUIET_FAIL_MARKERS = [
  /quiet-fail: before stdout/, /quiet-fail: before stderr/,
  /quiet-fail: failing stdout/, /quiet-fail: after stdout/,
];
// spec renders a PASSING todo test with `✔` (only a skip, or a failing todo,
// changes the symbol), and the quiet reporter forwards todo lines on purpose. So
// "no per-test pass line" means no `✔` line other than that one.
const TODO_LINE = /# quiet-pass todo reason$/;
const passLines = out => out.split('\n').filter(l => /^\s*✔/.test(l) && !TODO_LINE.test(l));

test('a passing run prints the summary and nothing per-test', async () => {
  const r = await runGuard('quiet-pass');
  assert.equal(r.code, 0, `the quiet-pass run should be green:\n${r.out}`);
  assert.deepEqual(passLines(r.out), [], 'a passing file printed its per-test lines');
  assert.doesNotMatch(r.out, /^\s*▶/m, 'a passing file printed its describe header');
  for (const marker of QUIET_PASS_MARKERS) {
    assert.doesNotMatch(r.out, marker, `a passing file's output reached the runner's: ${marker}`);
  }
  // The two per-test lines a quiet run keeps.
  assert.match(r.out, /^\s*﹣ quiet-pass: skipped.*# quiet-pass skip reason$/m,
    'the skip line must survive a quiet run');
  assert.match(r.out, /^\s*✔ quiet-pass: todo.*# quiet-pass todo reason$/m,
    'the todo line must survive a quiet run');
  // The summary: node's counts (redacted by runGuard, so their presence is the
  // redaction marker) and the runner's own verdict, slowest-files and hint lines.
  assert.match(r.out, /<inner-count-line redacted/);
  assert.match(r.out, /hang-guard: 1\/1 files reported/);
  assert.match(r.out, /hang-guard: slowest files/);
  assert.match(r.out, /^quiet-reporter: .*CC_TEST_VERBOSE=1/m,
    'a quiet run must name the switch that restores the full report');
});

test('a failing file prints its whole output and its attribution; a passing neighbour stays quiet', async () => {
  const r = await runGuard(['quiet-pass', 'quiet-fail']);
  assert.equal(r.code, 1, `a failing file must fail the run:\n${r.out}`);
  // The WHOLE file, from before the failing test on — not just from the failure.
  for (const marker of QUIET_FAIL_MARKERS) {
    assert.match(r.out, marker, `the failing file's output was held back: ${marker}`);
  }
  assert.match(r.out, /✔ quiet-fail: passes before the failure/,
    'the failing file\'s passing tests before the failure must print');
  assert.match(r.out, /▶ quiet-fail group/,
    'the describe path a parser rebuilds `describe > name` from must print');
  // The `failing tests:` block's attribution.
  assert.match(r.out, /test at .*quiet-fail\.fixture\.mjs:\d+:\d+/);
  assert.match(r.out, /quiet-fail: deliberate failure/);
  // Only the file that failed is flushed.
  for (const marker of QUIET_PASS_MARKERS) {
    assert.doesNotMatch(r.out, marker, `the passing neighbour's output was flushed: ${marker}`);
  }
  assert.deepEqual(passLines(r.out).filter(l => /quiet-pass:/.test(l)), [],
    'the passing neighbour printed its per-test lines');
});

test('CC_TEST_VERBOSE=1 restores the full spec report', async () => {
  const r = await runGuard('quiet-pass', FAST, { verbose: true });
  assert.equal(r.code, 0, `the quiet-pass run should be green:\n${r.out}`);
  assert.match(r.out, /✔ quiet-pass: writes to both streams/);
  for (const marker of QUIET_PASS_MARKERS) assert.match(r.out, marker);
  assert.doesNotMatch(r.out, /quiet-reporter:/, 'a verbose run held nothing back and must not say it did');
});

test('a passing file reached through a symlinked path stays quiet', async (t) => {
  // node names one file two ways when its path runs through a symlink: the
  // enqueue/dequeue/complete/plan/summary events carry the path as given to
  // run(), the start/pass/stdout/stderr events its realpath. The quiet reporter
  // must treat both as ONE file, or the summary never reaches the entry holding
  // the output and the end of the run prints it all. A symlinked workspace root,
  // macOS's /tmp and a Windows junction all produce this shape.
  const tmp = mkdtempSync('cc-quiet-link-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const link = path.join(tmp, 'hang');
  try {
    fs.symlinkSync(path.dirname(fixture('quiet-pass')), link, 'dir');
  } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(e.code)) throw e;
    t.skip(`this host cannot create a directory symlink (${e.code})`);
    return;
  }
  const r = await runGuard(path.join(link, 'quiet-pass.fixture.mjs'));
  assert.equal(r.code, 0, `the quiet-pass run should be green:\n${r.out}`);
  assert.deepEqual(passLines(r.out), [], 'a passing file printed its per-test lines');
  assert.doesNotMatch(r.out, /^\s*▶/m, 'a passing file printed its describe header');
  for (const marker of QUIET_PASS_MARKERS) {
    assert.doesNotMatch(r.out, marker, `a passing file's output reached the runner's: ${marker}`);
  }
  // Printed at the file's summary — which reaches it only if both spellings are
  // one file — and only there.
  assert.equal((r.out.match(/^\s*﹣ quiet-pass: skipped/gm) ?? []).length, 1,
    `the skip line did not print exactly once:\n${r.out}`);
});
