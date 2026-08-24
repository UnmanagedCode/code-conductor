// Regression suite for the suite hang guard (card 2026-0190), part 4 of 5:
// the leaked-process IDENTITY logic (processesWithMarker / killPids) plus the
// two orphan shapes only that identity can find.
//
// Split out of the former tests/hang-guard.test.mjs by card 2026-0198. The
// harness (RUNNER, fixture(), the deadlines, FAST, redactTotals, runGuard) lives
// once in tests/hangGuardCase.mjs — read its header before changing anything
// here.
//
// The pure-unit cases live HERE deliberately: the predicate pair and killPids
// are the sweep's own identity logic, and the safety-critical half of it
// (over-firing means SIGKILLing something that is not ours). Keeping them in the
// cheapest file also means they still report if a heavier hang-guard file is
// ever SIGKILLed — which is why the harness's own redactTotals() unit sits here
// too rather than in a file that can be truncated.

import test from 'node:test';
import assert from 'node:assert';
import { killPids, processesWithMarker } from './procTree.mjs';
import { redactTotals, runGuard } from './hangGuardCase.mjs';

// --- the harness's own count-line redaction ---------------------------------
//
// redactTotals() is pure, is shared by all five hang-guard files, and is
// otherwise pinned by NOTHING: every case asserts guard-diagnostic regexes, and
// `r.out` only reaches stdout inside a failure message, so neutralising the
// regex to the identity function leaves the whole suite green (measured). It
// lives in the cheapest file for the same reason the predicate cases do.

test('redactTotals neutralises inner count lines and nothing else', () => {
  // A real inner spec report: node's count lines, plus the diagnostic lines that
  // MUST survive. `✖ failing tests:` is the trap — it contains the word "tests"
  // but is not a count line, and a reader parsing counts must still see it.
  const sample = [
    '✔ leak-on-pass: passes but never closes its server (1.41ms)',
    'ℹ tests 12',
    'ℹ suites 0',
    'ℹ pass 11',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 8124.304519',
    '  i pass 3',                       // ASCII fallback glyph, indented
    '✖ failing tests:',
    '  AssertionError [ERR_ASSERTION]: deliberate failure before cleanup',
    'handle-leak-guard: the event loop was STILL OPEN',
    'hang-guard: 0/1 files reported, 1 killed, 0 leaked process(es) swept',
  ].join('\n');

  const out = redactTotals(sample);

  // THE POINT OF THE FUNCTION: an external count-based parser reading this
  // suite's output must not be able to find an inner total to fold into ours.
  assert.doesNotMatch(out,
    /^[^\S\n]*[ℹi][^\S\n]*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/mu,
    'an inner count line survived redaction — the inner run\'s totals can now be ' +
    'folded into this suite\'s by a count-based parser');
  assert.doesNotMatch(out, /\b12\b/, 'the inner `tests 12` figure is still readable');
  assert.doesNotMatch(out, /8124/, 'the inner duration_ms figure is still readable');
  assert.equal((out.match(/^<inner-count-line redacted by hangGuardCase\.mjs>$/gm) ?? []).length, 9,
    'every count line, unicode and ASCII, indented or not, must be replaced');

  // EVERY diagnostic line survives intact — redacting them would defeat the
  // suite, which exists to say WHICH guard broke.
  for (const keep of [
    '✔ leak-on-pass: passes but never closes its server (1.41ms)',
    '✖ failing tests:',
    '  AssertionError [ERR_ASSERTION]: deliberate failure before cleanup',
    'handle-leak-guard: the event loop was STILL OPEN',
    'hang-guard: 0/1 files reported, 1 killed, 0 leaked process(es) swept',
  ]) {
    assert.ok(out.split('\n').includes(keep), `redaction ate a diagnostic line: ${keep}`);
  }
});

// --- the leaked-process predicate, table-driven ------------------------------
//
// processesWithMarker is pure over its snapshot argument, so both directions are
// testable with synthesised rows and no real processes. This is the safety-
// critical half: over-firing here means SIGKILLing something that is not ours.

const snapOf = rows => ({
  available: true,
  byPid: new Map(rows.map(r => [r.pid, { ident: '1', argv: [], ...r }])),
  byParent: new Map(),
});
const MARK = 'cc-testrun-Abc123';
const envWith = id => `PATH=/usr/bin\0CC_TEST_RUN_ID=${id}\0HOME=/root\0`;

test('processesWithMarker matches this run\'s descendants and nothing else', () => {
  const rows = [
    { pid: 1, env: envWith(MARK) },                       // init — never, even if marked
    { pid: process.pid, env: envWith(MARK) },             // ourselves — never
    { pid: 4001, env: envWith(MARK) },                    // plain descendant
    { pid: 4002, env: envWith(MARK) },                    // detached descendant, same marker
    { pid: 4003, env: envWith('cc-testrun-Other99') },    // a DIFFERENT concurrent run
    { pid: 4004, env: 'PATH=/usr/bin\0HOME=/root\0' },   // a stranger, no marker at all
    { pid: 4005, env: '' },                               // environ unreadable (not ours)
    { pid: 4006, env: 'CC_TEST_RUN_IDX=' + MARK + '\0' }, // near-miss variable name
    // PREFIX SHARING — the cross-run fratricide case the trailing-NUL anchor
    // exists for. This marker STARTS WITH ours, so an unanchored `includes`
    // matches it and one run's sweep SIGKILLs another run's processes (measured
    // with a truncated marker: an inner runner killed the outer run's).
    { pid: 4007, env: envWith(MARK + 'XY') },
  ];
  const hits = processesWithMarker(MARK, snapOf(rows)).map(h => h.pid).sort((a, b) => a - b);
  assert.deepEqual(hits, [4001, 4002],
    'only pids carrying THIS run\'s marker, never init, ourselves, another run, or a stranger');
});

test('processesWithMarker refuses to match when it cannot see', () => {
  // No marker and no /proc are both "I cannot tell" — and must never be read as
  // "everything matches", which would SIGKILL the box.
  assert.deepEqual(processesWithMarker('', snapOf([{ pid: 4001, env: envWith(MARK) }])), []);
  // The unavailable snapshot is deliberately POPULATED with a row that WOULD
  // match. An empty byPid makes this pass with the `!snap.available` guard
  // deleted, since the loop returns [] either way — and a partially populated
  // unavailable snapshot is exactly what a /proc partial read yields, the one case
  // where that guard is all that stands between "I cannot see" and a kill list.
  assert.deepEqual(
    processesWithMarker(MARK, {
      available: false,
      byPid: new Map([[4001, { pid: 4001, ident: '1', argv: [], env: envWith(MARK) }]]),
      byParent: new Map(),
    }),
    [], 'an unavailable snapshot must yield nothing even when a row would match');
});

test('killPids re-verifies pid identity before signalling', () => {
  // The safety direction: a remembered pid may have been RECYCLED onto an
  // unrelated process by the time we act (Termux runs pid_max 32768, so a long
  // session wraps). starttime cannot collide across incarnations.
  const signalled = [];
  const kill = pid => signalled.push(pid);
  // 1 and 7777 MUST map to their recorded ident, or the two sentinel rows below
  // prove nothing. With them unmapped, identOf returns null, the identity
  // re-check rejects both rows first, and the `pid === self || pid <= 1` guard is
  // never reached — so deleting either conjunct leaves this test green
  // (measured). Mapping them makes each sentinel guard the ONLY thing standing
  // between the row and a SIGKILL, which is the invariant this case exists for.
  const identOf = pid => ({
    5001: 'same', 5002: 'DIFFERENT-NOW', 5003: null, 1: 'same', 7777: 'same',
  }[pid] ?? null);

  const killed = killPids([
    { pid: 5001, ident: 'same' },           // identity intact -> kill
    { pid: 5002, ident: 'was' },            // pid recycled    -> MUST NOT kill
    { pid: 5003, ident: 'was' },            // vanished        -> MUST NOT kill
    { pid: 5004 },                          // no ident recorded -> kill (best effort)
    { pid: 1, ident: 'same' },              // init      -> never, EVEN THOUGH the
                                            //   ident re-check would now pass it
    { pid: 7777, ident: 'same' },           // "ourselves" -> never, likewise
  ], { identOf, kill, self: 7777 });

  assert.deepEqual(signalled.sort((a, b) => a - b), [5001, 5004]);
  assert.deepEqual(killed.sort((a, b) => a - b), [5001, 5004],
    'the return value must report only what was actually signalled');
});

// --- Layer A: the parent-side process guarantee ----------------------------

test('an orphan grandchild holding stdio cannot wedge the run', async () => {
  // THIS CASE DOES NOT PIN THE MARKER SOURCE, and the case below is the only one
  // that does — do not read the pair as redundant cover for it. This fixture's
  // holder is NOT detached, so the sampler records it under `fileDescendants`
  // while the test child is still alive, and sweepOrphans' LINEAGE source still
  // finds it with `processesWithMarker`'s contribution deleted (established in
  // 2026-0198's review: that deletion kills `fast-orphan` alone, not this case).
  // What this case pins is the outcome —
  // a stdio-holding grandchild is swept, the run goes red, and it never falls
  // through to the absolute cap — across whichever source reaches it.
  const r = await runGuard('orphan-grandchild');
  assert.equal(r.code, 1, `expected a red run:\n${r.out}`);
  assert.match(r.out, /hang-guard: SWEPT \d+ leaked process\(es\)/);
  assert.ok(r.wallMs < 20_000, `orphan run took ${r.wallMs}ms — it fell through to the absolute run cap`);
});

test('a leak from a file too fast to be sampled is still found and killed', async () => {
  // ~30ms file: under one 100ms sampler tick, so the orphan is never recorded by
  // parentage, and its parent exits at once so it is reparented to init and no
  // descendants() walk can reach it. Only the CC_TEST_RUN_ID marker source
  // (processesWithMarker) finds it — which makes this the UNIQUE pin on that
  // source. The case above cannot stand in for it; see the note there.
  const r = await runGuard('fast-orphan');
  assert.notEqual(r.code, 0, `a leaked live process must fail the run:\n${r.out}`);
  assert.match(r.out, /hang-guard: SWEPT \d+ leaked process\(es\)/,
    'a sub-tick orphan must still be identified and SIGKILLed');
  assert.ok(r.wallMs < 20_000, `run took ${r.wallMs}ms — it fell through to the absolute run cap`);
});
