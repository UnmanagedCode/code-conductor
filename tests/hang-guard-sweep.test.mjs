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
import { FAST, redactTotals, runGuard } from './hangGuardCase.mjs';

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

// Same duplicate-pid guard as tests/orphan-reaper.test.mjs, for the same reason:
// `new Map(entries)` keeps the LAST entry for a repeated key, so a reused pid
// silently voids the earlier row — it stays readable, stays commented, and stops
// reaching the code under test. Found once on this branch; guarded so the next
// one fails loudly.
const snapOf = rows => {
  const seen = new Set();
  for (const r of rows) {
    assert.ok(!seen.has(r.pid), `duplicate pid ${r.pid} in a snapshot table — ` +
      'the later row silently voids the earlier one, which then tests nothing');
    seen.add(r.pid);
  }
  return {
    available: true,
    byPid: new Map(rows.map(r => [r.pid, { ident: '1', argv: [], ...r }])),
    byParent: new Map(),
  };
};
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
    // NAME SHARING — the other half of the anchor, and the direction a plain
    // `includes` on the needle gets WRONG: this variable's NAME ends with ours,
    // so `CC_TEST_RUN_ID=<marker>\0` appears verbatim inside it. This predicate
    // holds the kill authority for all four sweep triggers, so it is the one
    // that must refuse (card 2026-0226 round 1).
    { pid: 4008, env: `PATH=/usr/bin\0PREV_CC_TEST_RUN_ID=${MARK}\0` },
  ];
  const hits = processesWithMarker(MARK, snapOf(rows)).map(h => h.pid).sort((a, b) => a - b);
  assert.deepEqual(hits, [4001, 4002],
    'only pids carrying THIS run\'s marker, never init, ourselves, another run, or a stranger');
});

test('processesWithMarker refuses to match when it cannot see', () => {
  // No marker and no /proc are both "I cannot tell" — and must never be read as
  // "everything matches", which would SIGKILL the box. THIS predicate is the one
  // holding kill authority: it feeds sweepOrphans -> killPids on all four sweep
  // triggers, so its falsy-marker guard matters more than its single-pid twin's.
  //
  // The box below is POPULATED with the two rows a falsy marker can actually
  // match, because the obvious assertion is vacuous: asking `''` about a snapshot
  // of normally-marked rows passes with `!marker` deleted, since strict equality
  // rejects them anyway. A row only pins the guard if markerIn's answer for it can
  // EQUAL the falsy marker.
  const falsyBox = snapOf([
    { pid: 4001, env: envWith(MARK) },                  // normal — rejected either way
    { pid: 4004, env: 'PATH=/usr/bin\0HOME=/root\0' },  // no entry: markerIn -> null
    { pid: 4013, env: 'PATH=/usr/bin\0CC_TEST_RUN_ID=\0' }, // empty VALUE: markerIn -> ''
  ]);
  assert.deepEqual(processesWithMarker('', falsyBox), [],
    'an empty marker matched the empty-valued entry — that is a licence to SIGKILL it');
  assert.deepEqual(processesWithMarker(null, falsyBox), [],
    'a null marker matched every unmarked process on the box');
  assert.deepEqual(processesWithMarker(undefined, falsyBox), []);
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
  // prove nothing. killPids checks the `pid === self || pid <= 1` sentinel FIRST
  // and re-verifies identity SECOND (tests/procTree.mjs:173 then :179), so the
  // identity re-check is a fallback that MASKS a deleted sentinel conjunct: with
  // 1 and 7777 unmapped, identOf returned null, a row that got past the deleted
  // conjunct was then rejected by `identFn(pid) !== ident` anyway, and the test
  // stayed green (measured, both conjuncts). Mapping them makes the re-check pass
  // the row through, leaving each sentinel guard as the ONLY thing between it and
  // a SIGKILL — which is the invariant this case exists for.
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

// A live pid, asked the cheapest way there is. Signal 0 checks for existence
// without delivering anything; ESRCH is "gone", EPERM is "alive but not ours".
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};

// ONE source for the fixture's marker line: the rendezvous that FIRES the
// interrupt below and the pid this case READS BACK are the same pattern, or the
// signal could fire on a line the assertion then refuses. No `g` flag — a global
// regex carries `lastIndex` across `.test()` calls and would skip matches.
const HOLDER_LINE = /silent-orphan: holder pid=(\d+)/;

const holderPidFrom = (out) => {
  const m = HOLDER_LINE.exec(out);
  assert.ok(m, `the fixture never printed its holder pid:\n${out}`);
  return Number(m[1]);
};

test('a leak that wedges nothing is still swept, at the END of a healthy run', async () => {
  // THE CASE THIS WHOLE CARD EXISTS FOR, and the only behavioural proof that the
  // class is closed. Every other sweep case leaks a holder of the runner's own
  // stdio, so the STREAM STALL trigger reaches it; this holder has
  // `stdio: 'ignore'` and holds nothing, so before card 2026-0226 the stream
  // ended cleanly, the cap was never reached, NOTHING looked, and the run exited
  // 0 with a live process left on the box. Measured pre-fix: exit 0,
  // `0 leaked process(es) swept`, holder still alive after the run.
  const r = await runGuard('silent-orphan');
  const holder = holderPidFrom(r.out);

  // NON-VACUITY, and it is load-bearing: without this pair someone could satisfy
  // the case by making the fixture stall, and it would pass through the OLD
  // trigger while proving nothing about the new one. Both must hold — the run
  // must have ended the healthy way AND still gone red.
  assert.match(r.out, /stream ended cleanly/,
    'the fixture wedged the stream, so this proves the stall trigger, not the run-end sweep');
  assert.match(r.out, /run cap not reached/);

  assert.match(r.out, /hang-guard: SWEPT \d+ leaked process\(es\) \(pids [\d,]+; trigger: run end\)/,
    'the sweep must fire on the run-end trigger specifically');
  assert.equal(r.code, 1, `a leaked live process must fail the run:\n${r.out}`);

  // `SWEPT` printed is NOT proof of death — killPids reports what it signalled,
  // and a bad ident re-check or a wrong pid would print the same line. Ask the
  // kernel. Bounded poll: the holder's parent is already gone, so init reaps it
  // at once; this tolerates that latency without tolerating survival.
  const deadline = Date.now() + 3000;
  while (pidAlive(holder) && Date.now() < deadline) await new Promise(r2 => setTimeout(r2, 25));
  assert.equal(pidAlive(holder), false,
    `holder ${holder} survived the sweep — SWEPT was printed but nothing died`);
});

test('the run-end sweep runs BEFORE the run root is removed', async () => {
  // ORDER, pinned by a check that can only be satisfied one way round. run.mjs
  // re-reads its own marker AFTER sweeping and BEFORE removeSafeRoot; move the
  // sweep past teardown and a live process is left with a (deleted) cwd inside a
  // removed run root — the state all 21 measured orphans were found in — and the
  // RESIDUAL line fires. This also guards the other direction: a sweep whose
  // SIGKILL had not landed by the time the check reads /proc would print it too,
  // which is why the check reads `environ` (empty for a zombie) and so fails
  // closed toward clean.
  const r = await runGuard('silent-orphan');
  assert.doesNotMatch(r.out, /hang-guard: RESIDUAL/,
    `a marked process was still alive at teardown:\n${r.out}`);
});

// BOTH signal legs, because run.mjs pairs each with its OWN exit status and a
// single-signal test lets the other one float: mutating
// `[['SIGINT', 130], ['SIGTERM', 143]]` to `[['SIGINT', 143], ...]` survived the
// whole suite while only SIGTERM was sent. The sweep ACTION is shared, so it is
// pinned by either leg; what needs both is the CODE PAIRING.
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`${signal} mid-run sweeps this run's processes and exits ${code}`, async () => {
    // An INTERRUPTED run is the one path the run-end sweep cannot cover, and it is
    // the one an interrupted campaign actually takes. A `detached` child sits in
    // its own process group, so a terminal SIGINT/SIGTERM to the runner's group
    // never reaches it — pre-fix the runner died on node's default handling and the
    // holder was left alive on the box with nothing having looked.
    //
    // The signal is CAUSED by the fixture's own marker, not scheduled after a
    // delay: `signalWhen: HOLDER_LINE` fires the interrupt in the same tick the
    // holder-pid line is observed, so "the pid was printed before the signal" is
    // a causal fact, not a start-up margin on a starved box (card 2026-0228 —
    // the `signalAfterMs: 1200` this replaced went red 6/14 runs at 72-way,
    // because spawn→marker measures 759-1585 ms there).
    //
    // CC_TEST_DWELL_MS keeps the fixture's test body open so the runner is still
    // mid-run when the signal lands: 4000ms, comfortably inside FILE_KILL (8000)
    // so the per-file watchdog is not what ends this. It no longer bounds the
    // GREEN path — the signal lands at spawn→marker and the interrupt cuts the
    // dwell short — it bounds the FAILURE path, i.e. how fast a marker that never
    // arrives goes red (measured 4.9-5.6 s at 72-way with the rendezvous
    // neutered). SIGKILL is deliberately not tested — no in-process handler can
    // run for it, which is what tests/reapOrphans.mjs exists for.
    const r = await runGuard('silent-orphan',
      { ...FAST, CC_TEST_DWELL_MS: '4000' },
      { signalWhen: HOLDER_LINE, signal });
    const holder = holderPidFrom(r.out);

    assert.match(r.out, new RegExp(`hang-guard: ${signal} — sweeping this run's processes before exiting\\.`),
      `the interrupt path never swept:\n${r.out}`);
    // The trigger string is the signal's own name, so a handler wired to the
    // wrong signal cannot pass by sweeping under the other one's label.
    assert.match(r.out,
      new RegExp(`hang-guard: SWEPT \\d+ leaked process\\(es\\) \\(pids [\\d,]+; trigger: ${signal.toLowerCase()}\\)`));
    // 128+signo — node's OWN default status, restated by the handler because
    // installing any listener for a signal REMOVES that default. A run that exits
    // some other status has changed what every caller sees, and the two legs carry
    // DIFFERENT numbers, so asserting one proves nothing about the other.
    assert.equal(r.code, code,
      `expected 128+${signal}=${code}, got code=${r.code} signal=${r.signal}:\n${r.out}`);
    assert.equal(r.signal, null, 'the runner must exit under its own control, not die from the signal');

    const deadline = Date.now() + 3000;
    while (pidAlive(holder) && Date.now() < deadline) await new Promise(r2 => setTimeout(r2, 25));
    assert.equal(pidAlive(holder), false,
      `holder ${holder} survived an interrupted run — this is the leak an interrupted campaign leaves`);
  });
}
