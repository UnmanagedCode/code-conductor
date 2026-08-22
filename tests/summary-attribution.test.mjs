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
//      plus SUB-SECOND RESOLUTION in its assertion (5). Fails against the pre-fix
//      `test:summary` source, and (5) alone fails against a reporter that coarsens
//      the figure to whole seconds — which every other assertion here survives.
//   2. `a KILLED file keeps its figure` — a file with NO summary and NO inner
//      completion. Fails against the pre-fix source AND against sourcing the
//      duration from the last INNER `test:complete`.
//   3. `post-test teardown is inside the figure` — fails against the INNER-complete
//      source (the pre-fix source passes it, since node emits a summary at exit).
//
// Like tests/hang-guard.test.mjs, this spawns the REAL tests/run.mjs against
// fixtures and reads its output. Nothing here re-implements the reporting rule: the
// shipped reporter is the thing under test, and a second copy of the rule here could
// agree with itself while the shipped one was broken.
//
// ── THRESHOLD ALGEBRA — read before changing a fixture sleep or a constant ───────
// Every bound below is a RATIO or an ORDERING, never an absolute ms figure. Load
// inflates every figure by that file's own spawn+import cost, so absolutes drift
// with it while ratios and differences largely cancel it. (An earlier revision
// asserted `medium <= 900` and went red on a CORRECT reading of 972ms under
// starvation.)
//
// THE SPAWN COST IS PER FILE, NOT COMMON. This is the trap: an earlier revision did
// the algebra with a single shared C and concluded assertion (2) had 800ms of slack,
// when it had 200ms — and (2) was then MEASURED FAILING 1 run in 20 under starvation
// (slow 1788 / medium 1431, margin -1ms). The costs differ SYSTEMATICALLY, not
// randomly: slow.fixture.mjs is dispatched at t=0 into a free slot, while medium
// waits for the slot fast vacates and pays a contended spawn. So C_medium > C_slow
// as a rule, and the difference is what the bounds have to absorb.
//
// With medium's sleep M=1200 and slow's S=2100 (fast = C_f, medium = M + C_m,
// slow = S + C_s, subsecond = 550 + C_sub), each assertion tolerates:
//   (1) fast * 3 < medium        while  3*C_f - C_m  <  M          = 1200ms
//   (2) medium * 1.25 < slow     while  1.25*C_m - C_s  <  S - 1.25M = 600ms
//   (4) slow >= 2100             unconditional — it is a control, not a bound
//   (5) 0 < medium - subsecond < 1000  while  C_sub - C_m < 650  and
//                                            C_m - C_sub < 350
// Measured spawn costs: ~37ms quiet. Under 16 CPU spinners, over 20 runs, the
// per-file maxima were C_f 323ms, C_m 271ms, C_s 264ms, C_sub 236ms — but the MAXIMA
// are not the risk, the SPREAD between two files in one run is: (2)'s binding
// quantity 1.25*C_m - C_s ranged -29..198ms, peaking within 2ms of the 200ms that
// S=1700 allowed. That is why S moved to 2100, buying 600ms. Verified after the
// change over 20 starved runs: 0 assertions would fail, and the raw margins were
// (1) min 425ms, (2) min 402ms, (4) min 70ms, (5) gap 569-849ms inside its 0-1000
// band.
//
// Two standing warnings. Raising M widens (1) but NARROWS (2), so the sleeps are
// solved together, never tuned one at a time. And do not re-derive these bounds with
// a single C: that is the exact error that shipped a marginal assertion.
//
// THAT RE-SOLVE COST SOMETHING, WHICH IS WHY subsecond.fixture.mjs EXISTS. At
// M=600 / S=1200 assertion (2) happened to DOUBLE as a resolution check: both its
// figures quantized to 1000ms, so `1250 < 1000` caught a reporter that coarsened the
// figure to whole seconds. At the current M=1200 / S=2100 they land on 1000 and
// 2000 and (2) passes on them, so that coverage was lost as a side effect of tuning
// the sleeps.
// Assertion (5) pins resolution EXPLICITLY rather than relying on the coincidence,
// which is what lets these sleeps be chosen for C-tolerance alone.
// ─────────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert';
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
// CONCURRENCY 2 is the default here because test 1 needs slow and fast to hold the
// two slots together (so fast finishes inside slow's window) and medium to be
// dispatched into the slot fast vacates.
async function runFixtures(names, extraEnv = {}) {
  const { code, out } = await new Promise((resolve, reject) => {
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

  // Quote ONLY `hang-guard:` lines in assertion messages. The inner runner emits a
  // full spec report including `ℹ tests/pass/fail` count lines, and this suite is
  // read by count-based parsers — folding the inner run's totals into ours is the
  // exact hazard tests/hang-guard.test.mjs's redactTotals exists for. Selecting the
  // diagnostic lines we want is cheaper than redacting the ones we don't.
  const guardLines = out.split('\n').filter(l => /^hang-guard:/.test(l));
  const diag = guardLines.join('\n') || '(no hang-guard: lines in output)';

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
  // ARGV ORDER IS LOAD-BEARING: slow FIRST. discover() preserves argv order, and the
  // bug only fires for a file listed after one that is still running. Reverse these
  // and the unfixed reporter looks correct.
  const { code, diag, ranking, of } = await runFixtures(['slow', 'fast', 'medium', 'subsecond']);
  assert.equal(code, 0, `the fixture run should be green:\n${diag}`);
  assert.equal(ranking.length, 4, `expected all four fixtures in the ranking:\n${diag}`);

  const slow = of('slow'), medium = of('medium'), fast = of('fast'), sub = of('subsecond');

  // (1) A TRIVIAL FILE IS NOT CHARGED A WORKING FILE'S WALL. The primary bug-catcher:
  // unfixed, fast is charged the ~1.7s it spent WAITING for slow's summary. It fails
  // by ~3x — measured unfixed, fast 1732ms against a ceiling of medium/3 = 566ms, so
  // 1732/566 = 3.06x. (Derive this ratio afresh if you change a fixture sleep; it is
  // medium/3 vs fast, not a round number.) Tolerance C < 600ms (see the algebra above).
  assert.ok(fast * 3 < medium,
    `fast.fixture.mjs (no sleep, reported ${fast}ms) should be far cheaper than ` +
    `medium.fixture.mjs (1200ms sleep, reported ${medium}ms); a near-tie means fast is ` +
    `inheriting the wall of an earlier-listed file that was still running:\n${diag}`);

  // (2) THE FIGURE RESOLVES TWO FILES THAT BOTH DID REAL BUT DIFFERENT WORK. This is
  // precisely what the old plateau hid — four trivial files reading within ~600ms of
  // the one real culprit. Tolerance C < 800ms.
  assert.ok(medium * 1.25 < slow,
    `medium.fixture.mjs (1200ms sleep, reported ${medium}ms) should be clearly cheaper ` +
    `than slow.fixture.mjs (2100ms sleep, reported ${slow}ms); the figure is not ` +
    `resolving their real walls:\n${diag}`);

  // (3) THE PUBLISHED RANKING IS THE TRUE ORDER. Asserted as the WHOLE sequence, not
  // "slow is first": unfixed, medium is always LAST (its dequeue is the latest, so it
  // inherits least of the held wall) while slow and fast tie to within ~1ms and trade
  // first place at random — measured, the correct file won first place in 4 of 5 runs,
  // so a first-place-only check would pass against the broken reporter most of the
  // time. The full sequence never matches unfixed and always matches fixed.
  assert.deepEqual(ranking.map(r => r.name),
    ['slow.fixture.mjs', 'medium.fixture.mjs', 'subsecond.fixture.mjs', 'fast.fixture.mjs'],
    `the ranking must order files by the wall they actually spent:\n${diag}`);

  // (4) Control, not a discriminator — it also passes against the unfixed reporter.
  // slow.fixture.mjs sleeps 2100ms, so dispatch→child-done can never be below that at
  // any load. Kills a mutant that collapses the figure to a small constant.
  assert.ok(slow >= 2100,
    `slow.fixture.mjs sleeps 2100ms, so it cannot legitimately report ${slow}ms:\n${diag}`);

  // (5) SUB-SECOND RESOLUTION. medium and subsecond differ by only ~650ms of true
  // wall, so the reported figures must stay strictly ordered AND stay under a second
  // apart. Stated as a two-sided bound on the DIFFERENCE, which is what makes it
  // both load-safe and complete:
  //   * a difference cancels the common spawn cost C to first order, so unlike an
  //     absolute bound it does not drift with load;
  //   * every way of coarsening the figure to whole seconds violates one side —
  //     tie the two (difference 0, violating the lower bound) or split them across
  //     adjacent buckets (difference exactly 1000, violating the upper). That is why
  //     it does not matter WHERE the buckets happen to fall.
  // NOTHING ELSE HERE CATCHES THAT. Quantized, the four figures become 2000 / 1000 /
  // 1000 / 0, on which assertions (1)-(4) all pass and even the ranking sequence in
  // (3) still matches, because the sort is stable and the tie preserves insertion
  // order. Measured true gap: 650ms quiet.
  const gap = medium - sub;
  assert.ok(gap > 0 && gap < 1000,
    `medium.fixture.mjs (1200ms sleep, reported ${medium}ms) and subsecond.fixture.mjs ` +
    `(550ms sleep, reported ${sub}ms) differ by ~650ms of real wall, so the reported ` +
    `figures must differ by more than 0 and less than 1000ms — got ${gap}ms. A gap of 0 ` +
    `means the figure lost sub-second resolution; a gap of exactly 1000 means the two ` +
    `were rounded into adjacent whole seconds:\n${diag}`);
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
  // placeholder at the bottom of the list.
  assert.equal(ranking[0].name, 'killed.fixture.mjs',
    `the killed file must still rank as the most expensive file:\n${diag}`);
  assert.ok(killed > of('fast') * 3,
    `killed.fixture.mjs (${killed}ms) must dominate fast.fixture.mjs (${of('fast')}ms):\n${diag}`);
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
