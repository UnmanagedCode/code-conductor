// Single source for every hang-guard deadline. The parent (tests/run.mjs,
// Layer A) and the child-side preload (tests/handleLeakGuard.mjs, Layer B) both
// read from here, so a guard can never protect its own private copy of a
// number.
//
// Every deadline is env-overridable for exactly one reason: the guard's own
// regression suite (tests/hang-guard-*.test.mjs, sharing tests/hangGuardCase.mjs)
// drives the REAL code path at millisecond scale instead of asserting against a
// re-implementation of the rule. That keeps CONVENTIONS.md's "no long real
// sleeps" rule satisfiable without a second, test-only copy of the logic.

function ms(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${envName}=${JSON.stringify(raw)} is not a positive number of milliseconds`);
  }
  return n;
}

// Parent-side, per test file: SIGKILL a child process that has outlived this.
// MUST stay above the 60s per-test `timeout` passed to run() in run.mjs, so it
// can never pre-empt a test that node itself would still cancel and report.
// THE SLOWEST FILE WAS tests/idle-wake-ownership.test.mjs. Card 2026-0221 split it
// into the tests/idle-wake-*.test.mjs family over the shared harness in
// tests/idleWakeCase.mjs, and THE SPLIT REMEDY BELOW DID TRANSFER TO IT. An earlier
// revision of this comment said it did not, because the file's cost was bounded real
// wall-clock windows (paced turns, heartbeat intervals) rather than work. That is
// true and it bounds the wrong quantity: it says the family's TOTAL cannot shrink,
// while this deadline is charged the MAX. The windows sat in mutually INDEPENDENT
// tests — measured: the per-test durations summed to 48 414ms inside a 48 640ms file
// wall, i.e. the file was its tests plus ~0.2s of spawn+import — so one file was
// charged their sum and the family is now charged its largest member.
//
// ONE RECORD. Before-figures at 44b0b60, after-figures at 692aead, both on a
// 16-core box, 2026-08-26. RE-POINT THE SHAS ON A REBASE — a rebase rewrites them
// and the anchor silently dangles. Re-derive rather than extrapolate:
//
//   node tests/run.mjs                 # healthy; read the hang-guard verdict line
//
//   margin of the family's worst file        BEFORE ->  AFTER
//     healthy, whole-suite, quiet        48 865ms (1.84x) ->    9 861ms (9.13x)
//     healthy, whole-suite, 72-way       58 153ms (1.55x) -> <14 343ms (>6.3x)
//     BROKEN GUARD (recipe below)       149 002ms (0.60x) ->   31 932ms (2.82x)
//   suite wall around them: 57 206ms -> 42 516ms quiet, 195 682ms -> 112 268ms at
//   72-way.
//
// THE STARVED ROW IS A BOUND, NOT A POINT, and deliberately so: after the split no
// idle-wake-* file reaches the starved verdict line's top five at all, so the only
// figure that run supports is "below its 5th entry" (server-restart, 14 343ms).
// Running the eight files ALONE at 72-way puts the worst at 11 328ms (7.94x), which
// is a lighter condition than a 284-file run and so a lower bound. Quote whichever
// you measure, with its width.
//
// WHAT DRIFTS: every millisecond figure, with the box and the ambient load. WHAT IS
// ANCHORED: the ORDER of those three rows (broken worst, then starved, then quiet),
// and that the BROKEN row is the one that decides this constant. Starvation moves
// this family barely at all, because timers fire on schedule under load: BEFORE the
// split, quiet to 72-way, the whole suite grew 242% while the file grew 19%; AFTER,
// the suite grew 164% (42 516 -> 112 268ms) while the family's worst grew at most
// 45%. CASE COUNT is the threat here, and it is additive: a new case adds to the max
// only once it exceeds the largest existing file.
//
// THE BROKEN ROW WAS BELOW 1x BEFORE THE SPLIT, and this is what that cost: the
// guard SIGKILLed the file at 90 077ms, the run reported 0/1 files, and the file
// never emitted a summary — so node's own tests/pass/fail tally and every per-test
// name went with it. Reached by a SINGLE ENVIRONMENT-ONLY regression, no edit
// anywhere (ORCH_SUBSCRIBE_TIMEOUT_MS=999 collapses
// DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS to 0, so every second-precision window is
// refused and each affected test rides to waitFor's 10s default instead of to its
// own window — 13 of them did):
//
//   ORCH_SUBSCRIBE_TIMEOUT_MS=999 node tests/run.mjs tests/idle-wake-*.test.mjs
//   CC_TEST_FILE_KILL_MS=900000 CC_TEST_RUN_CAP_MS=1200000 \
//     ORCH_SUBSCRIBE_TIMEOUT_MS=999 node tests/run.mjs tests/idle-wake-*.test.mjs
//
// The second form existed to see the wall the kill HID. Post-split there is no
// longer one to hide: measured at 692aead, the FIRST form reports 8/8 files, 0
// killed, with node's own 45/24/21 tally and every per-test name intact, and the
// worst file's 31 932ms read straight off its verdict line. That is the whole point
// of the split — keep the second form only for the day a new case pushes a file past
// this constant again. A MARGIN COMMENT STATING ONLY THE HEALTHY NUMBER INVITES
// RAISING THIS CONSTANT AFTER A FALSE KILL; the answer to a broken row is more
// files, not a later deadline.
// RE-ANCHOR THIS WHEN THE TOP FILE CHANGES.
//
// HOW TO REPRODUCE THE STARVED CONDITION: docs/architecture.md -> "Reproducing CPU
// starvation". It is recorded once, there — every starved figure in this repo cites
// the same recipe and a second copy would drift.
//
// hang-guard is no longer at the top, and is no longer one file. Card 2026-0198
// split tests/hang-guard.test.mjs into five tests/hang-guard-*.test.mjs files
// (file-kill / run-cap / layer-b / sweep / stall) over the shared harness in
// tests/hangGuardCase.mjs. Its cases are independent nested-runner subprocess
// runs whose cost is their squeezed DEADLINE, not work, so one file was charged
// the SUM of every case's deadline and five files are charged the MAX. Measured
// before -> after: **30 183ms -> 8 493ms quiet** (2.98x -> 10.60x) and
// **35 299ms -> 9 369ms starved** (2.55x -> 9.61x). The post-split floor is a
// single 8.2s case (busyloop, which sits out FILE_KILL=8000 by construction), so
// a new case now adds to the max, not the sum, until it exceeds that.
//
// DO NOT READ THE TOP FIVE AS A PLATEAU. This comment used to, on the strength of
// the top five sitting "within ~600ms of each other" quiet and ~2.7s starved. That
// spread was a BUG in the figure, not a property of the suite: run.mjs computed
// each file's duration at `test:summary` time, and per-file summaries are emitted
// in `files` order, so a file finishing ahead of an earlier-listed one had its
// summary HELD and was then charged that file's wall. The four files trailing
// hang-guard.test.mjs in the old ranking were inheriting its ~30s; their real
// durations were 8ms, 344ms, 386ms and ~100ms. Card 2026-0206 moved the figure to
// `test:complete` (order-independent). The ranking is now steep. Measured on a
// QUIET 16-core box at 692aead (2026-08-26), post-split. RE-POINT THIS SHA IF
// THE BRANCH IS REBASED — a rebase rewrites it and the anchor silently dangles:
//   idle-drain-settle 16 582 / header-playbook-enforcement 10 375 /
//   plugins-supervisor 9 902 / idle-wake-ownership 9 861 /
//   idle-wake-abort-qualifier 9 759 ms
// so a flat top five reappearing is itself the signal that the metric regressed.
//
// NO ENTRY IS CONDITION-STABLE, THE HEAD LEAST OF ALL — and an earlier revision of
// this comment said the opposite ("only the head of that list is stable"), which
// card 2026-0221's split made false. The head now depends on the CONDITION, because
// the two kinds of slow file respond to load differently: a DEADLINE-BOUND file
// (bounded wall-clock windows) leads a quiet run and barely moves under starvation,
// while a CPU-BOUND one leads under load. Measured at 72-way in the same 284-file
// run: the head becomes playbook-enforce (19 305ms), which is absent from the quiet
// five entirely, the quiet head idle-drain-settle drops to second (17 649ms), and no
// idle-wake-* file appears at all.
// So compare a fresh verdict line only against one taken at the SAME load, and
// expect the tail to re-order freely — observed even before the split,
// worktree-feature-branch and worktrees overtaking server-restart and pushing
// hang-guard-file-kill out of the top five entirely. The standing signal is not a
// re-order at all: it is a FLAT line, which is the 2026-0206 metric bug returning.
//
// WATCH THE TREND, BUT NOT VIA THE OLD ONE. An earlier revision tracked a starved
// slowest-file trend of 19.4s -> 28.8s -> 38.6s (4.6x -> 3.1x -> 2.3x). Every one
// of those figures was taken with the pre-2026-0206 metric that charged files each
// other's wall, so the numbers do not survive; only the direction does. Track the
// live verdict line instead.
//
// THE BINDING CONSTRAINT IS NOT THE HEALTHY-RUN FIGURE. What actually governs
// whether the regression suite can be silenced by the regressions it catches is
// the BROKEN-GUARD figure: a case whose guard is regressed stops being bounded by
// that guard and rides to whichever inner deadline still bounds it. WHICH ONE
// DIFFERS PER RECIPE — do not assume the 12s cap when extending this:
//   * stall trigger (SWEEP): orphan-grandchild and fast-orphan ride to the 12s
//     RUN CAP. Only those two of the four stall-dependent cases — detached-orphan
//     aborts in ~3ms on its `SWEEP * 4 < HOLDER_LIFETIME` precondition, which
//     reads the same mutated constant, and stall-grace keeps its own local 2500ms
//     CC_TEST_ORPHAN_SWEEP_MS override and is untouched;
//   * Layer B exit (LEAK_GRACE): the leaking files fall through to Layer A's
//     inner 8s FILE_KILL (~8.13s each), NOT to the cap;
//   * Layer A kill (FILE_KILL): busyloop rides to the 12s RUN CAP.
// Measured with the stall trigger disabled: the single file took
// **47 408ms (1.90x)**; the worst of the five files takes **24 720ms (3.64x)**.
// Per induced regression, worst file: stall trigger 24 225ms, Layer B exit
// 24 720ms, Layer A per-file kill 12 405ms — and in all three the run stayed
// **5/5 files reported, 0 killed**, i.e. every case's named diagnostic survived.
//
// OBTAIN IT EDIT-FREE — no temporary change to tests/run.mjs is needed (an earlier
// revision of this comment said otherwise). Raising a deadline past the inner run
// cap disables its branch behaviourally, and the harness single-sources all of
// them, so it is a ONE-LINE, ONE-PLACE edit in tests/hangGuardCase.mjs:
//
//   SWEEP 1500 -> 9999999        (stall trigger)   then
//   LEAK_GRACE 1500 -> 9999999   (Layer B exit)    then
//   FILE_KILL 8000 -> 60000      (Layer A kill)
//   node tests/run.mjs tests/hang-guard-*.test.mjs   # revert after each
//
// Per single case, without touching the harness at all:
//
//   CC_TEST_LEAK_GRACE_MS=1500 CC_TEST_FILE_KILL_MS=8000 CC_TEST_RUN_CAP_MS=12000 \
//   CC_TEST_HOLDER_LIFETIME_MS=60000 CC_TEST_ORPHAN_SWEEP_MS=9999999 \
//     node tests/run.mjs tests/fixtures/hang/detached-orphan.fixture.mjs
//
// The reassuring half: exceeding this constant yields a TRUNCATED RED, never a
// green. The per-file watchdog SIGKILLs the file, the completeness ledger names
// it, and the run fails; what is lost is the diagnostic saying WHICH guard broke.
// Splitting divided that loss by five — a kill now costs one file's cases, not
// all sixteen — which is why it was the right fix rather than raising this
// constant. The measurements above do not argue for raising it.
//
// The `hang-guard:` verdict line prints the slowest 5 files on every run, green
// or red. THAT live line, not this comment, is the load-bearing evidence.
export const FILE_KILL_MS = ms('CC_TEST_FILE_KILL_MS', 90_000);

// Child-side: how long after the root after() hook begins we wait before
// declaring the event loop leaked.
//
// DEADLINE INVERSION — read this before changing either number. LEAK_GRACE_MS is
// 6x TIGHTER than FILE_KILL_MS, and it is armed at the FIRST root after() hook,
// which (because a --import preload registers before the file's own hooks) is
// before the file's own teardown has even started. So in practice LEAK_GRACE_MS,
// not FILE_KILL_MS, is the effective per-file TEARDOWN deadline: a file whose
// teardown legitimately takes longer than this is failed by Layer B as a leak,
// and the 90s figure never gets a say. Under the ~2.7x slowdown measured at
// 24-way starvation, a file with ~6s of quiet-box teardown crosses it. Slowest
// observed teardown on this tree is far below that, but if a file ever starts
// awaiting many child exits in teardown, this is the number to raise — not
// FILE_KILL_MS.
export const LEAK_GRACE_MS = ms('CC_TEST_LEAK_GRACE_MS', 15_000);

// Parent-side: the grace between every discovered file being SETTLED (reported,
// killed, or its child gone without reporting) and declaring the report stream
// stalled. Normally `end` follows the last summary within milliseconds — measured
// at ~4ms — so this is almost pure margin. It is applied once, from the last file
// to settle, rather than compounding per file.
export const ORPHAN_SWEEP_MS = ms('CC_TEST_ORPHAN_SWEEP_MS', 5_000);

// Parent-side, at TEARDOWN: how long the run-end residual check gives a
// just-signalled process to actually leave the process table before calling it a
// survivor. NOT a tolerance on anything a test asserts, and not a deadline any
// guard rides to — it exists because "is it alive?" cannot be decided
// instantaneously about a process we signalled microseconds ago.
//
// THIS CONSTANT IS NOT THE FIX FOR THE FALSE RESIDUAL — do not read it as one.
// That was a STALE SNAPSHOT, not slow signal delivery, and the fix is the LIVE
// hasMarker re-verify in settleResidual (tests/run.mjs). Demonstrated
// deterministically: take a /proc walk, SIGKILL the holder, wait 50ms, and the
// walk's CACHED environ still names it while a live re-read does not.
// processesWithMarker's readdirSync('/proc') samples the pid list microseconds
// after the sweep's kills, so a pid early in a ~2700-pid iteration is read inside
// its own death window. Observed once at load 25 with SWEPT and RESIDUAL naming
// the same pid on an otherwise healthy run.
//
// 250ms IS A MEASUREMENT-INFORMED CHOICE, NOT A GUARANTEE — do not quote a
// margin from it as though it bounded the broken case.
//
// What was measured is the HEALTHY path: process.kill() to /proc/<pid>/environ no
// longer answering, for a marked detached orphan on a 16-core box.
//   n=30,  load ~25.0 : p50 1.4ms  p90 3.6ms            max 5.3ms
//   n=200, load ~12.4 : p50 1.3ms  p90 3.1ms  p99 6.9ms max 7.7ms
//   n=200, load ~25.5 : p50 0.4ms  p90 4.5ms  p99 8.5ms max 9.9ms
// Quote the LARGEST tail (9.9ms), not the smallest sample: the first run's 5.3ms
// max sits inside the later runs' tails, so a margin computed from it is an
// artefact of n=30. Against 9.9ms the bound is ~25x.
//
// THE RELEVANT WORST CASE IS NOT IN THAT TABLE, and no fixed bound can cover it.
// A signalled process is not reaped while it is in uninterruptible (D-state)
// sleep, and swap pressure or cgroup CPU throttling can stretch the same window
// arbitrarily. None of those are load-average-shaped, so measuring harder does
// not produce a bound that proves anything.
//
// WHAT MAKES THAT ACCEPTABLE IS THE FAILURE DIRECTION, not the margin. Exceeding
// the bound yields a VISIBLE RED, never a silent leak: the process is returned as
// residual, re-SIGKILLed (harmlessly — it is already dying, and killPids
// re-verifies identity first), named in the RESIDUAL line, and the run fails. So
// the cost of the bound being too small is a false red on an otherwise-clean run,
// which is loud and diagnosable; the cost of it being too large is only teardown
// latency on a run that is already failing. Raise CC_TEST_RESIDUAL_SETTLE_MS if a
// box shows that false red — that escape hatch, not a bigger default, is the
// answer to a pathologically slow reaper.
//
// It cannot mask a real leak in either direction: a process that outlives its own
// SIGKILL by the whole bound is still returned and still fails the run, and one
// that exits inside the window did not survive the run. And it is only ever paid
// when the first snapshot found something — a healthy run returns without
// sleeping at all (pinned in tests/orphan-reaper.test.mjs).
export const RESIDUAL_SETTLE_MS = ms('CC_TEST_RESIDUAL_SETTLE_MS', 250);

// Parent-side, absolute: the whole run may not exceed this. LAST-RESORT
// BACKSTOP ONLY — it exists to make an unbounded hang finite, not to bound a
// slow box. The layers that actually produce a timely verdict are the per-file
// ones above (FILE_KILL_MS / LEAK_GRACE_MS / ORPHAN_SWEEP_MS), and those are
// what have to fit inside an external harness's ceiling; a scoped mutation run
// is a handful of files, so they fire long before this does.
//
// MEASURED: a full 268-file run under 24-way CPU starvation (load avg ~30) takes
// ~157-170s — so the original 240s left only ~1.4x margin and would have gone red
// on a merely-loaded box. The file count has grown since (cards 2026-0198 and
// 2026-0221 both split a file); read the live count off the verdict line's
// `N/N files reported` rather than trusting a number minted here, and note the
// margin is wide enough that the figure has not needed re-taking. A cap that fires on a slow box is a false red, and this
// card exists to make the suite's cost BELIEVABLE.
//
// NOTE, because the plan said the opposite: 600s is ABOVE code-mutant's own
// timeout (`timeoutMs` in harness/mutation/config.json, 300s), so the plan's
// stated property — "below 300s so we, not it, produce the verdict" — is NOT
// true of this constant and must not be re-asserted. It is benign, and the
// reason is the layering above: the per-file deadlines (90s / 15s / 5s) plus the
// stream-stall check are what actually terminate a wedged run, and all of them
// fire well inside 300s. The cap is only the backstop behind those.
// Re-measure if the suite grows substantially.
export const RUN_CAP_MS = ms('CC_TEST_RUN_CAP_MS', 600_000);
