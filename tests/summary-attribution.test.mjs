// Regression guard for the per-file duration figure in the `hang-guard:` verdict
// line (card 2026-0206).
//
// THE BUG. run.mjs used to compute each file's duration at `test:summary` time.
// Per-file summaries are emitted in `files` order, so a file that finishes ahead of
// an earlier-listed one had its summary HELD until that one reported — and was then
// charged the earlier file's wall. The slowest-5 line, which is the standing
// evidence that FILE_KILL_MS's margin is real, therefore reported a flat plateau of
// near-identical figures instead of naming the file that actually spent the time.
// The fix reads the FILE-LEVEL `test:complete` (order-independent) instead.
//
// THREE SEAMS, THREE TESTS, and they fail against different wrong implementations —
// keep all three:
//   1. `the verdict line charges each file its OWN wall` — the ordering bug itself,
//      plus MILLISECOND RESOLUTION in its assertion (5). Fails against the pre-fix
//      `test:summary` source, on assertions (1), (2) and (2b). NOTE: under the argv
//      order this file now uses, assertion (3) does NOT kill that mutant alone —
//      see (3)'s own comment.
//   2. `a KILLED file keeps its figure` — a file with NO summary and NO inner
//      completion. Fails against the pre-fix source AND against sourcing the
//      duration from the last INNER `test:complete`.
//   3. `post-test teardown is inside the figure` — fails against the INNER-complete
//      source (the pre-fix source passes it, since node emits a summary at exit).
//      DELIBERATE CO-GUARD, NOT A UNIQUE DISCRIMINATOR — do not delete it for
//      lacking a unique killer. A mutation catalog finds unique killers for 1 and 2
//      but none for 3: every kill it scores co-fires with 1 or 2, and STRUCTURALLY
//      so, because a single-site duration mutation applies one formula to every file
//      and therefore trips the fixtures that measure the most wall first. It is kept
//      for a case a catalog of single-site mutants cannot express: a REFACTOR onto a
//      completion event whose duration excludes `after()` hooks would leave 1 green
//      (its fixtures have no hooks) and plausibly 2 as well, and 3 is the only
//      assertion here that states teardown inclusion POSITIVELY, on a green run.
//
// Like the tests/hang-guard-*.test.mjs suite, this spawns the REAL tests/run.mjs against
// fixtures and reads its output. Nothing here re-implements the reporting rule: the
// shipped reporter is the thing under test, and a second copy of the rule here could
// agree with itself while the shipped one was broken.
//
// ── THE CHAIN — read before changing a fixture increment or an argv order ─────────
// NO BOUND IN TEST 1 CONTAINS A CHILD-LIFECYCLE TERM. That is the design, and it
// replaces an earlier revision's "threshold algebra", which tolerated a per-file
// spawn+import cost C by RATIO. Read that sentence precisely: ONE machine-speed term
// survives, it is PARENT-side, and it is quantified below under "THE ONE RESIDUAL".
// This banner used to claim no machine-speed term at all, which was false — and a
// test artifact that overstates its own load-independence is the exact disease this
// card treats. A ratio MULTIPLIES C instead of cancelling it:
// `fast * 3 < medium` reduces to an absolute cap of C < 600ms, and C was measured at
// 772ms at 72-way starvation (vs ~320ms at the repo's standard 24-way width). That
// assertion went red 42% of the time on a completely correct reporter — card
// 2026-0222, and docs/architecture.md's rule: make each branch reachable ONLY by
// construction, never by margin.
//
// THE CONSTRUCTION. The four ranking fixtures chain their COMPLETIONS
// (tests/fixtures/attribution/chain.mjs). Each waits for its predecessor's PROCESS
// TO EXIT, spends its own designed increment, then publishes its own pid:
//     fast  0  ->  subsecond +550  ->  medium +650  ->  slow +900
// so the chain still sums to 2100ms, but as CUMULATIVE separations rather than as
// four independent races against spawn cost.
//
// WHY EACH BOUND HOLDS AT ANY LOAD. run.mjs reports `done - dequeue` (dequeue is
// stamped at `test:dequeue`, i.e. at DISPATCH, before the child boots — which is why
// a fixture doing no work at all can still report 772ms). So for any two files:
//
//     reported_a - reported_b = (done_a - done_b) + (dequeue_b - dequeue_a)
//
//   * `dequeue_b - dequeue_a >= 0` whenever a is listed BEFORE b: node dispatches in
//     `files` order and, at TEST_CONCURRENCY=4, all four fit in the window together.
//   * `done_a - done_b >=` the designed increment, because a does not begin its own
//     increment until b's PROCESS HAS EXITED.
//
// BOTH OF THOSE TERMS ARE NON-NEGATIVE. But `done` is stamped in the inner runner's
// `test:complete` HANDLER, not at the child's exit, so the identity carries a third,
// PARENT-side term — the delivery lag of each event, `J_a - J_b`. It is mean-zero and
// small (measured buffers over the floors: +12..+53ms quiet, +46..+539ms at 72-way),
// but it is not structurally zero. So the honest claim is: every bound below is a
// lower bound that no CHILD-SIDE cost can violate, and the multiplied-C term that made
// this file flake is gone. It is not a widened tolerance — it is a far tighter claim
// than the ratios were — but it is not literally unconditional either.
//
// TWO LOAD-BEARING CHOICES, both commented at their call site: `TEST_CONCURRENCY: 4`
// (fewer slots than chained fixtures DEADLOCKS the chain — loudly, via chain.mjs's
// 10s rendezvous cap) and the argv order `slow, medium, subsecond, fast`, DESCENDING by
// expected figure, which is what puts the dequeue stagger in the safe direction.
//
// GATING ON EXIT RATHER THAN ON THE MARKER IS LOAD-BEARING AND WAS MEASURED. An
// earlier cut released the successor when the predecessor WROTE its marker, at the
// end of its test body — which leaves `exitCost_predecessor` inside the difference
// and subtracting. At 72-way that broke all three bounds (minima 1050 / 811 / 460
// against 1200 / 900 / 550, standalone red 13/24). chain.mjs's header carries the
// numbers and the correlation that isolated the term. Waiting for the process to be
// GONE removes it and turns `exitCost_successor` into a positive buffer.
//
// THE ONE RESIDUAL MACHINE-SPEED TERM, stated honestly, because the banner above is
// deliberately narrow about it. What is left is `J_successor - J_predecessor`, the
// PARENT's delivery lag for the two file-level `test:complete` events. ONE CONTIGUOUS
// STALL OF THE PARENT'S EVENT LOOP SPANNING BOTH COMPLETIONS compresses their reported
// difference toward zero — that is the branch that is still reachable by MARGIN rather
// than by construction, and it is why this file cannot claim totality.
//
// The stall has to be roughly the size of the designed increment it is attacking:
// ~600ms to break (2b), ~850ms for (2), ~1150ms for (1). Not theoretical — the runner
// self-inflicts stalls of this shape via procSampler's synchronous whole-/proc
// snapshot (~2900 pids on this box), and Termux has documented multi-hundred-ms
// throttle events.
//
// CONSEQUENCE FOR ANYONE TUNING THE INCREMENTS: 550ms, the SMALLEST link, is what sets
// the stall size that breaks this suite. DO NOT SHRINK IT WITHOUT RE-MEASURING — every
// ms off it is a ms off the parent-stall the file can absorb.
//
// The exposure is vastly smaller than the multiplied-C term it replaced (which reached
// 770ms of CHILD cost per file and fired 42% of the time), and it fails LOUD — a
// compressed difference goes red, never silently green. IF IT EVER EXCURSES, THE
// REMEDY IS NEVER TO LOOSEN A BOUND.
//
// WHAT THIS FILE DOES NOT CLAIM, stated as a boundary rather than as totality: a
// UNIFORM rescale of every figure by a constant factor (e.g. x1.5) passes everything
// here, because it violates no ordering, no designed separation and no resolution
// claim.
// ─────────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killDescendants } from './procTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run.mjs');
const fixture = name => path.join(__dirname, 'fixtures', 'attribution', `${name}.fixture.mjs`);

// Runs the real runner against the named fixtures and returns its `hang-guard:`
// lines plus the parsed slowest-files ranking.
//
// CONCURRENCY 2 is the default here because the non-chained fixtures (killed,
// teardown) need no overlap. Test 1's chain needs one slot per chained fixture and
// overrides it — see its call site.
async function runFixtures(names, extraEnv = {}) {
  // Per-call sync dir for the chain's markers. mkdtemp, not a fixed path: two
  // concurrent suite runs on one box must not see each other's markers.
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-attr-'));
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      // NODE_TEST_CONTEXT must not reach the child. node:test sets it in every
      // per-file test child, and a nested run() that sees it prints "run() is being
      // called recursively within a test file. skipping running files" and silently
      // runs NOTHING — the inner runner would report 0 files and every assertion
      // below would fail for the wrong reason.
      const childEnv = {
        ...process.env,
        TEST_CONCURRENCY: '2',
        // Bounds a genuine regression in the runner itself, and keeps that case well
        // inside the OUTER 90s per-file watchdog — which would otherwise SIGKILL this
        // file and truncate exactly the diagnostics naming what broke.
        CC_TEST_RUN_CAP_MS: '30000',
        CC_ATTR_SYNC_DIR: syncDir,
        ...extraEnv,
      };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [RUNNER, ...names.map(fixture)], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      child.stdout.on('data', d => { buf += d; });
      child.stderr.on('data', d => { buf += d; });
      // Backstop so a runner regression surfaces as a failed assertion here rather
      // than as a stalled test. killDescendants FIRST — SIGKILLing only the nested
      // runner would leave its fixture children reparented to init, and one of those
      // fixtures deliberately outlives its parent's deadline.
      const bail = setTimeout(() => {
        try { killDescendants(child.pid); } catch { /* best effort */ }
        child.kill('SIGKILL');
      }, 30_000);
      child.on('error', err => { clearTimeout(bail); reject(err); });
      // Always awaits the child's exit, so this file never leaves a ChildProcess
      // handle behind — Layer B (tests/handleLeakGuard.mjs) is preloaded into this
      // very file and would correctly fail it if we did.
      child.on('close', c => { clearTimeout(bail); resolve({ code: c, out: buf }); });
    });
  } finally {
    // In a `finally`, not after the await: the promise rejects on child.on('error').
    fs.rmSync(syncDir, { recursive: true, force: true });
  }
  const { code, out } = result;

  // Quote ONLY `hang-guard:` lines in assertion messages. The inner runner emits a
  // full spec report including `ℹ tests/pass/fail` count lines, and this suite is
  // read by count-based parsers — folding the inner run's totals into ours is the
  // exact hazard tests/hangGuardCase.mjs's redactTotals exists for. Selecting the
  // diagnostic lines we want is cheaper than redacting the ones we don't.
  const guardLines = out.split('\n').filter(l => /^hang-guard:/.test(l));

  // ON A RED INNER RUN, ALSO QUOTE ITS ERROR LINES. `hang-guard:` lines alone say a
  // file failed but never WHY, so a broken chain used to surface here as the generic
  // "the fixture run should be green" while chain.mjs's specific diagnostic ("predecessor
  // 'X' did not publish a pid and exit within 10000ms … TEST_CONCURRENCY was below the
  // number of chained fixtures") sat in `buf` and was discarded. Loud is not enough —
  // a failure has to be DIAGNOSABLE from this file's own output.
  //
  // The selection stays narrow on purpose: Error-bearing lines only, never the inner
  // run's `ℹ tests/pass/fail` counts. Folding those into our output is the exact hazard
  // tests/hangGuardCase.mjs's redactTotals exists for, and this suite is read by
  // count-based parsers. The `ℹ`/`#` drop is belt-and-braces on top of that.
  const errorLines = code === 0 ? [] : out.split('\n')
    .filter(l => /\b[A-Za-z]*Error\b/.test(l) && !/^\s*[ℹ#]/.test(l))
    .map(l => l.trim())
    .slice(0, 6);
  const diag = [
    guardLines.join('\n') || '(no hang-guard: lines in output)',
    ...(errorLines.length ? ['inner run errors:', ...errorLines] : []),
  ].join('\n');

  const line = guardLines.find(l => l.startsWith('hang-guard: slowest files'));
  assert.ok(line, `no slowest-files line was printed:\n${diag}`);
  // e.g. "hang-guard: slowest files (limit 90000ms): slow.fixture.mjs 1737ms, ..."
  const ranking = [...line.matchAll(/([\w.-]+\.fixture\.mjs) (\d+)ms/g)]
    .map(([, name, ms]) => ({ name, ms: Number(ms) }));

  const of = (name) => {
    const hit = ranking.find(r => r.name === `${name}.fixture.mjs`);
    assert.ok(hit, `${name}.fixture.mjs is MISSING from the slowest-files ranking — ` +
      `a file with no duration is dropped from the one diagnostic that names it:\n${diag}`);
    return hit.ms;
  };
  return { code, diag, guardLines, ranking, of };
}

test('the verdict line charges each file its OWN wall, not an earlier-listed file\'s', async () => {
  // TWO LOAD-BEARING ARGUMENTS HERE — see the chain block at the top of this file.
  //
  // ARGV ORDER `slow, medium, subsecond, fast`: DESCENDING by expected figure. Two
  // jobs at once. (a) slow is still FIRST, and the pre-fix bug only fires for a file
  // listed after one that is still running — reverse that and the unfixed reporter
  // looks correct. (b) every pair compared below is listed larger-first, so
  // `dequeue_b - dequeue_a >= 0` in each difference and the stagger can only ever
  // help. Do NOT reorder these to make assertion (3) a stronger discriminator; see
  // (3)'s comment for that trade.
  //
  // TEST_CONCURRENCY 4: one slot per chained fixture, so all four are dispatched
  // together and the chain is structural rather than a race. Fewer slots deadlocks
  // it, loudly, via chain.mjs's 10s rendezvous cap. resolveConcurrency (tests/run.mjs)
  // honours an explicit integer with NO core-derived cap, so this is portable to a
  // 2-core box.
  const { code, diag, ranking, of } =
    await runFixtures(['slow', 'medium', 'subsecond', 'fast'], { TEST_CONCURRENCY: '4' });
  assert.equal(code, 0, `the fixture run should be green:\n${diag}`);
  assert.equal(ranking.length, 4, `expected all four fixtures in the ranking:\n${diag}`);

  const slow = of('slow'), medium = of('medium'), fast = of('fast'), sub = of('subsecond');

  // (1) A TRIVIAL FILE IS NOT CHARGED A WORKING FILE'S WALL. The primary bug-catcher:
  // unfixed, fast is charged the wall it spent WAITING for slow's summary, so this
  // difference collapses toward ~0 (measured unfixed, every figure lands within a few
  // ms of slow's completion instant). medium's link ends 550 + 650 = 1200ms after
  // fast's, and medium is dequeued no later than fast, so 1200 is a floor at ANY load.
  assert.ok(medium - fast >= 1200,
    `medium.fixture.mjs completes 1200ms of chain after fast.fixture.mjs, so their ` +
    `reported figures must differ by at least that — got medium ${medium}ms, fast ` +
    `${fast}ms, difference ${medium - fast}ms. A near-tie means fast is inheriting the ` +
    `wall of an earlier-listed file that was still running:\n${diag}`);

  // (2) THE FIGURE RESOLVES TWO FILES THAT BOTH DID REAL BUT DIFFERENT WORK. This is
  // precisely what the old plateau hid — four trivial files reading within ~600ms of
  // the one real culprit. slow's link ends 900ms after medium's; slow is dequeued no
  // later than medium.
  assert.ok(slow - medium >= 900,
    `slow.fixture.mjs completes 900ms of chain after medium.fixture.mjs, so their ` +
    `reported figures must differ by at least that — got slow ${slow}ms, medium ` +
    `${medium}ms, difference ${slow - medium}ms. The figure is not resolving their ` +
    `real walls:\n${diag}`);

  // (2b) THE SAME CLAIM AT THE SMALLEST DESIGNED SEPARATION — the resolution floor.
  // Kills a reporter that rounds away separations below ~1s while preserving the
  // larger ones, which (1) and (2) would both survive.
  assert.ok(sub - fast >= 550,
    `subsecond.fixture.mjs completes 550ms of chain after fast.fixture.mjs, so their ` +
    `reported figures must differ by at least that — got subsecond ${sub}ms, fast ` +
    `${fast}ms, difference ${sub - fast}ms:\n${diag}`);

  // (3) THE PUBLISHED RANKING IS THE TRUE ORDER, asserted as the WHOLE sequence.
  //
  // KNOWN AND DELIBERATE: under this argv order it no longer kills the pre-fix
  // `test:summary` mutant ON ITS OWN. That mutant collapses every figure to slow's
  // completion instant, i.e. a near-tie, and the sort is stable, so it emits `files`
  // order — which is now exactly the expected sequence. (1), (2) and (2b) all fire on
  // that mutant instead, and they fire UNCONDITIONALLY, which the old argv order could
  // not offer. This is retained as a whole-sequence co-guard. Do NOT "restore" its
  // unique kill by reverting the argv order — that reintroduces the load term.
  assert.deepEqual(ranking.map(r => r.name),
    ['slow.fixture.mjs', 'medium.fixture.mjs', 'subsecond.fixture.mjs', 'fast.fixture.mjs'],
    `the ranking must order files by the wall they actually spent:\n${diag}`);

  // (4) Control, not a discriminator — it also passes against the unfixed reporter.
  // The chain sums to 550 + 650 + 900 = 2100ms before slow can exit, so dispatch→done
  // can never be below that at any load. Kills a mutant that collapses the figure to a
  // small constant.
  assert.ok(slow >= 2100,
    `slow.fixture.mjs completes at the end of a 2100ms chain, so it cannot ` +
    `legitimately report ${slow}ms:\n${diag}`);

  // (5) MILLISECOND RESOLUTION, stated as a lattice residue. The claim is simply "the
  // figure was not quantized", and this states it directly, with NO load term at all —
  // which the (0, 1000) band it replaces could not: that band's upper half was
  // measured OUTSIDE its range (gap 1053ms) on a correct reporter at load1 ~73.
  //
  // It is also STRICTLY STRONGER. Any whole-second lattice makes every figure
  // ≡ 0 (mod 1000) hence ≡ 0 (mod 100), so every mutant the band caught still dies —
  // and the 100ms and 500ms lattices the old header admits (as "the boundary of what
  // this file claims") now die too. False-positive probability with four independent
  // millisecond figures is ~1e-8.
  //
  // The band's LOWER half — medium and subsecond strictly ordered — is not lost:
  // (3) pins the full sequence and (2b) pins the separation numerically.
  const figures = [slow, medium, sub, fast];
  assert.ok(figures.some(ms => ms % 100 !== 0),
    `all four reported figures (${figures.join(', ')}) are multiples of 100ms, which ` +
    `four independent millisecond walls are not: the figure has been quantized onto a ` +
    `lattice and lost its resolution:\n${diag}`);
});

test('a KILLED file keeps its figure and its place in the ranking', async () => {
  // The case the diagnostic exists for: the ranking is how you find out which file
  // the watchdog killed. A killed file emits NO `test:summary` (node emits one only
  // when the child exits) and NO inner `test:complete` (its one test never
  // completes), so ONLY the file-level `test:complete` can supply its duration.
  // FILE_KILL squeezed to 2s; the companion fast file gives the ranking a second
  // entry so "keeps its place" is a real claim rather than a one-item list.
  const KILL_MS = 2000;
  const { code, diag, guardLines, ranking, of } =
    await runFixtures(['killed', 'fast'], { CC_TEST_FILE_KILL_MS: String(KILL_MS) });

  // The run MUST go red — a killed file is a real failure, and the completeness
  // ledger additionally names it as never having reported. Asserting green here
  // would be asserting the bug.
  //
  // THIS ASSERTION IS DELIBERATELY WEAK ABOUT *WHY* IT IS RED, and that has a known
  // consequence: run.mjs guards the red outcome twice (the synthesized test:fail
  // handler, and the ledger's unreported path), either of which alone suffices, so
  // disabling ONE of them is invisible here. Both call sites in tests/run.mjs carry
  // a note saying so. Strengthening this to pin a specific cause would close that,
  // at the price of coupling the test to which guard fires first.
  assert.notEqual(code, 0, `a killed file must fail the run:\n${diag}`);
  // Vacuity guard: without this the test would pass if the fixture simply finished
  // fast and was never killed at all.
  assert.ok(guardLines.some(l => /^hang-guard: KILLED .*killed\.fixture\.mjs after \d+ms/.test(l)),
    `the watchdog did not report killing killed.fixture.mjs, so this test proved ` +
    `nothing about killed files:\n${diag}`);

  const killed = of('killed');           // throws with a clear message if absent
  // It ran until the watchdog killed it, so its figure is bounded below by the
  // deadline itself — no load can make it smaller. 0.75x absorbs the sampler's 100ms
  // tick granularity.
  assert.ok(killed >= KILL_MS * 0.75,
    `killed.fixture.mjs ran until the ${KILL_MS}ms watchdog fired, so it cannot ` +
    `legitimately report ${killed}ms:\n${diag}`);
  // And it must still outrank the trivial file, i.e. the kill did not merely leave a
  // placeholder at the bottom of the list. THIS *IS* "killed > fast", stated
  // structurally: the ranking is sorted descending, and argv is ['killed', 'fast'] so
  // dequeue_killed <= dequeue_fast while done_killed > done_fast.
  //
  // A `killed > of('fast') * 3` ratio used to follow this line. IT WAS DELETED, DO NOT
  // RESTORE IT (card 2026-0222): a ratio between two wall figures multiplies the
  // per-file spawn cost instead of cancelling it — that one required C_fast < 667ms,
  // and C_fast was measured at 772ms at 72-way starvation, where it duly went red on a
  // correct reporter. It said nothing the two assertions around it do not: this line
  // carries the ordering, and the KILL_MS floor above carries the magnitude.
  assert.equal(ranking[0].name, 'killed.fixture.mjs',
    `the killed file must still rank as the most expensive file:\n${diag}`);
});

test('post-test teardown is inside the reported figure', async () => {
  // Teardown is where leaked handles surface (card 2026-0194: a ref'd socket
  // surviving server.close() cost a whole file's report), so a figure that stopped
  // at the last inner test would under-report the phase most worth watching.
  //
  // Discriminates the FILE-level `test:complete` from the last INNER one: the inner
  // test completes ~1ms in and the hook then sleeps ~900ms. Measured 954ms from the
  // file-level event; the inner-complete source would report ~40ms. The 700ms floor
  // sits between them and is load-safe in both directions — the sleep is wall-clock
  // so load cannot shrink it, and the wrong source would need 700ms of pure
  // spawn+import cost to sneak past.
  const { code, diag, ranking, of } = await runFixtures(['teardown']);
  assert.equal(code, 0, `the teardown fixture run should be green:\n${diag}`);
  assert.equal(ranking.length, 1, `expected exactly the one fixture:\n${diag}`);
  assert.ok(of('teardown') >= 700,
    `teardown.fixture.mjs does ~1ms of test work and ~900ms of TEARDOWN, but was ` +
    `reported as ${of('teardown')}ms — the figure is being cut off at the last inner ` +
    `test instead of at the file's process completion:\n${diag}`);
});
