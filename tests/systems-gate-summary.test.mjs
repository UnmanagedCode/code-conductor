// Unit tests for the gate's own failure report (tests/gateSummary.mjs).
//
// GREEN ON ARRIVAL BY CONSTRUCTION: nothing here reproduces a defect in shipped
// code — the module under test is new, and these fixtures are canned samples of
// output the node:test spec reporter and tests/run.mjs already produce. They
// exist so a red gate's diagnosis is pinned by a test instead of by reddening a
// row on purpose to look at it (card 2026-0290 §5c).
//
// The fixtures are the reporter's REAL shape, taken from
// `run()` + `stream.compose(new spec())` — the exact wiring tests/run.mjs uses —
// not from memory: indented lines for nested tests, the duration suffix, and the
// trailing `✖ failing tests:` section that repeats each name at column 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRowOutput, createRowScanner, renderGateSummary } from './gateSummary.mjs';

const CLEAN_ROW = [
  '✔ readiness via healthPath; child gets $PORT and reaches ready (562.832080ms)',
  'ℹ tests 4160',
  'ℹ pass 4139',
  'ℹ fail 0',
  '',
  'hang-guard: 346/346 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached',
  '',
  'guardrail: peak concurrent fake-claude subprocesses = 7 (budget 12)',
].join('\n');

const FAILING_ROW = [
  '▶ a nested failing case',
  '  ✖ inner one (1.001128ms)',
  '✖ a nested failing case (1.629998ms)',
  '✖ top level failing case (0.171447ms)',
  '✔ passing case (0.084531ms)',
  'ℹ fail 3',
  '',
  '✖ failing tests:',
  '',
  'test at tests/plugins-supervisor.test.mjs:215:1',
  '✖ inner one (1.001128ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '✖ top level failing case (0.171447ms)',
  '',
  'hang-guard: 346/346 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached',
].join('\n');

// card 2026-0268's shape: the row is red, and no test failed.
const WEDGED_ROW = [
  'ℹ tests 4102',
  'ℹ fail 0',
  '',
  'hang-guard: NO REPORT from tests/systems-remote-e2e.test.mjs — the file never emitted a summary.',
  'hang-guard: 344/346 files reported, 1 killed, 3 leaked process(es) swept, STREAM STALLED, run cap not reached',
].join('\n');

// Two lines that BOTH match the verdict pattern. The wedged row above does not
// exercise this: its `NO REPORT` line carries no `N/N files reported`, so only
// one line there is ever a candidate.
const TWO_VERDICT_ROW = [
  'hang-guard: 12/348 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached',
  'ℹ fail 0',
  'hang-guard: 348/348 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached',
].join('\n');

// ── scanRowOutput ──────────────────────────────────────────────────────────

test('scanRowOutput names every failing test once, nested and trailer alike', () => {
  // Pins: indented (nested) failures are found, and the trailing
  // `✖ failing tests:` section's repeats are deduped rather than counted twice.
  // NOT claiming the parent suite line is excluded — a failing parent IS
  // reported, because its name is the path to the leaf.
  const { failingTests } = scanRowOutput(FAILING_ROW);
  assert.deepEqual(failingTests, ['inner one', 'a nested failing case', 'top level failing case']);
});

test('scanRowOutput does not mistake the "failing tests:" header for a test', () => {
  // Pins the one line that looks exactly like a failure and is not: the
  // reporter's section header carries no duration suffix.
  assert.ok(!scanRowOutput(FAILING_ROW).failingTests.includes('failing tests:'));
});

test('scanRowOutput lifts the hang-guard verdict out of a row', () => {
  // Pins: the completeness verdict is captured verbatim, from a row whose output
  // also contains other `hang-guard:` lines that are NOT the verdict.
  assert.match(scanRowOutput(WEDGED_ROW).hangGuard, /^hang-guard: 344\/346 files reported, 1 killed, 3 leaked/);
  assert.equal(scanRowOutput(CLEAN_ROW).hangGuard,
    'hang-guard: 346/346 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached');
});

test('scanRowOutput reports nothing failing for a clean row', () => {
  // Pins non-vacuity in the other direction: a green row must not manufacture a
  // failure out of its `✔` lines.
  assert.deepEqual(scanRowOutput(CLEAN_ROW).failingTests, []);
});

test('scanRowOutput finds no test names in a wedged row', () => {
  // A STRUCTURAL NEGATIVE CONTROL — and it has NO POSSIBLE KILLER, which is not
  // the same as being vacuous. Do not delete it as dead weight: mutation showed
  // the scanner runs to completion over this fixture (so the assertion is
  // reached and meaningful) and that the test reds under crash-class mutations.
  // What it guards against is a future scanner that MANUFACTURES names out of a
  // row where nothing failed — which would turn card 2026-0268's shape back into
  // something indistinguishable from a test failure, the exact confusion the
  // summary exists to end. Nothing in today's code can produce that, so nothing
  // can kill it today.
  assert.deepEqual(scanRowOutput(WEDGED_ROW).failingTests, []);
});

test('the last matching verdict line wins', () => {
  // Pins the tiebreak the scanner states but no other fixture reaches: with two
  // lines both matching the verdict pattern, the LATER one is the settled
  // verdict. Only one is printed per run today, so this pins the rule ahead of a
  // runner that prints a provisional line and then a final one — where taking
  // the first would report a partial run as the outcome. NOT claiming today's
  // runner emits two.
  assert.match(scanRowOutput(TWO_VERDICT_ROW).hangGuard, /^hang-guard: 348\/348 files reported/);
});

test('a ✖ that is not at the start of a line is not a failing test', () => {
  // Pins the `^` anchor. Test output and diagnostics quote things; a line that
  // MENTIONS a failure line must not be harvested as one, or a green row grows
  // failures out of its own prose and the summary starts lying in the direction
  // that costs most — naming tests that did not fail.
  const quoted = [
    'console.log said: ✖ something (7ms) happened',
    'expected output to contain "✖ ghost test (1.0ms)"',
    '# note: ✖ not-a-test (2ms)',
  ].join('\n');
  assert.deepEqual(scanRowOutput(quoted).failingTests, []);
});

test('a failure line with trailing text is salvaged, not dropped', () => {
  // Pins the deliberate choice between two ways to be wrong (card 2026-0290 §5c).
  // The exact pattern's `$` anchor is what keeps a name like `slow hook (200ms)
  // does not interfere: …` whole — a lazy match without it stops at the first
  // duration and reports `slow hook`. But an anchor DROPS what it rejects, and a
  // dropped diagnosis is this card's own failure mode, so a line that opens like
  // a failure and carries a duration is taken verbatim instead.
  //
  // DEFENSIVE AND SYNTHETIC: the node:test spec reporter is NOT known to emit a
  // line of this shape, and this fixture is not evidence that it does. It pins
  // what happens if anything ever does.
  const { failingTests } = scanRowOutput([
    '✖ slow hook (200ms) does not interfere: subprocess spawns after hook completes (1.234ms)',
    '✖ mangled by something downstream (0.5ms) ← trailing junk',
  ].join('\n'));
  assert.deepEqual(failingTests, [
    'slow hook (200ms) does not interfere: subprocess spawns after hook completes',
    'mangled by something downstream (0.5ms) ← trailing junk',
  ]);
});

test('the scanner is chunk-boundary independent', () => {
  // Pins the property the live gate depends on and a whole-string test cannot
  // see: the gate feeds arriving stdout chunks, which split lines at arbitrary
  // bytes. Sliced one character at a time — the worst case — the result must be
  // identical to the whole-string scan. NOT claiming anything about ordering
  // between stdout and stderr, which the gate keeps on separate streams.
  const scanner = createRowScanner();
  for (const ch of FAILING_ROW) scanner.push(ch);
  assert.deepEqual(scanner.result(), scanRowOutput(FAILING_ROW));
});

test('the scanner flushes a final line that has no trailing newline', () => {
  // Pins the tail case: a runner killed mid-write, or one that simply does not
  // end with a newline, must not lose its last line — which can be the verdict.
  const scanner = createRowScanner();
  scanner.push('hang-guard: 346/346 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached');
  assert.match(scanner.result().hangGuard, /346\/346 files reported/);
});

// ── renderGateSummary ──────────────────────────────────────────────────────

const render = (results) => renderGateSummary(results).join('\n');

test('a green gate renders one PASS line per row and nothing else', () => {
  // Pins: a passing row carries no diagnosis, so the block stays the size it is
  // today when nothing is wrong.
  assert.deepEqual(renderGateSummary([
    { name: 'row-a', code: 0, failingTests: [], hangGuard: 'hang-guard: 346/346 files reported, 0 killed' },
    { name: 'row-b', code: 0, failingTests: [], hangGuard: null },
  ]), ['=== gate:systems ===', '  PASS  row-a', '  PASS  row-b']);
});

test('a FAIL row carries its verdict and its failing test names into the block', () => {
  // Pins the whole point of card 2026-0290 §5c: the diagnosis survives a `tail`.
  // Both the verdict and every name are in the closing block, not upstream in
  // the row's own output.
  const out = render([
    { name: 'processGroupSignal:false', code: 1, ...scanRowOutput(FAILING_ROW) },
  ]);
  assert.match(out, /FAIL {2}processGroupSignal:false/);
  assert.match(out, /hang-guard: 346\/346 files reported/);
  assert.match(out, /failing tests \(3\):/);
  for (const name of ['inner one', 'a nested failing case', 'top level failing case']) {
    assert.ok(out.includes(`✖ ${name}`), `the block dropped '${name}'`);
  }
});

test('a FAIL row with no ✖ line is named as a different defect, not left blank', () => {
  // Pins card 2026-0268's shape at the render level: the block must SAY that no
  // test was named and point at the verdict, so a wedged row is told apart from
  // a test failure at a glance. NOT claiming it diagnoses which wedge it was.
  const out = render([{ name: 'processGroupSignal:false', code: 1, ...scanRowOutput(WEDGED_ROW) }]);
  assert.match(out, /NO TEST WAS NAMED/);
  assert.match(out, /hang-guard: 344\/346 files reported, 1 killed, 3 leaked/);
});

test('a FAIL row that never printed a verdict says so rather than printing nothing', () => {
  // Pins the worst case — the runner died before its own summary — as a stated
  // outcome instead of an empty gap under the FAIL line.
  const out = render([{ name: 'row', code: 1, failingTests: [], hangGuard: null }]);
  assert.match(out, /NO VERDICT LINE/);
});

test('a mass failure is capped at ten names and completed by count', () => {
  // Pins: a row where hundreds of tests red still yields a readable block, and
  // the true total is stated rather than silently truncated.
  //
  // EVERY NUMBER BELOW IS A LITERAL, DELIBERATELY. Deriving them from
  // NAMED_FAILURE_LIMIT — which an earlier version did — moves both sides of
  // each assertion together when the constant changes, so the cap's VALUE
  // becomes unkillable and the test degrades into restating its own subject.
  // The constant stays where it belongs, in the renderer; this test is the
  // independent expectation. Change the cap and you change these lines too.
  const failingTests = Array.from({ length: 17 }, (_, i) => `case ${i}`);
  const out = render([{ name: 'row', code: 1, failingTests, hangGuard: 'hang-guard: 346/346 files reported, 0 killed' }]);
  assert.match(out, /failing tests \(17\):/);
  assert.ok(out.includes('✖ case 9'), 'the tenth name was not printed');
  assert.ok(!out.includes('✖ case 10'), 'printed an eleventh name, past the cap of ten');
  assert.match(out, /and 7 more/);
});

test('the scan is identical for colourized (TTY) and plain output', () => {
  // Pins the property that makes the summary a TTY/redirect invariant: the spec
  // reporter wraps every failure line in SGR escapes when its destination is a
  // terminal, and a pty rewrites the line ending to CRLF. Fixture below is the
  // reporter's REAL colourized shape, captured under a pty. NOT claiming general
  // ANSI handling — only that the diagnosis does not depend on how the gate was
  // invoked.
  const COLOUR_ROW = [
    '\x1b[31m✖ top level failing case \x1b[90m(0.149611ms)\x1b[39m\x1b[39m\r',
    '  \x1b[31m✖ inner one \x1b[90m(0.958133ms)\x1b[39m\x1b[39m\r',
    '\x1b[32m✔ passing case \x1b[90m(0.081033ms)\x1b[39m\x1b[39m\r',
    'hang-guard: 346/346 files reported, 0 killed, 0 leaked process(es) swept, stream ended cleanly, run cap not reached\r',
  ].join('\n');
  const { failingTests, hangGuard } = scanRowOutput(COLOUR_ROW);
  assert.deepEqual(failingTests, ['top level failing case', 'inner one']);
  assert.match(hangGuard, /^hang-guard: 346\/346 files reported/);
});
