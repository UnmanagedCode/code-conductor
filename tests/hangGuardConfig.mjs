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
// THE SLOWEST FILE IS tests/idle-wake-ownership.test.mjs, AND IT IS NOW THE SOLE
// OWNER OF THIS MARGIN. Measured at HEAD on a 16-core box: **33.0s quiet** (2.72x
// against the 90s limit) and **37.3s under 24-way CPU starvation** — **2.41x**,
// i.e. already past the 2.5x line at which this constant deserves a fresh look.
// Those figures and that remedy belong to card 2026-0211; do not act on them here.
// Its cost is bounded real wall-clock windows (paced turns, heartbeat intervals),
// which is why the split remedy below does not transfer to it.
// RE-ANCHOR THIS WHEN THE TOP FILE CHANGES.
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
// QUIET 16-core box at a23fbbb (2026-08-24), post-split. RE-POINT THIS SHA IF THE
// BRANCH IS REBASED — a rebase rewrites it and the anchor silently dangles:
//   idle-wake-ownership 33 036 / idle-drain-settle 16 618 /
//   header-playbook-enforcement 10 442 / server-restart 9 175 /
//   hang-guard-file-kill 8 507 ms
// so a flat top five reappearing is itself the signal that the metric regressed.
//
// ONLY THE HEAD OF THAT LIST IS STABLE. The 3rd-5th entries sit within ~2s of
// several other files and the tail RE-ORDERS UNDER AMBIENT LOAD — observed:
// worktree-feature-branch and worktrees overtaking server-restart and pushing
// hang-guard-file-kill out of the top five entirely. A fresh verdict line that
// disagrees with the tail above is not evidence of a regression; a fresh one that
// disagrees about the FIRST entry, or that is flat, is.
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

// Parent-side, absolute: the whole run may not exceed this. LAST-RESORT
// BACKSTOP ONLY — it exists to make an unbounded hang finite, not to bound a
// slow box. The layers that actually produce a timely verdict are the per-file
// ones above (FILE_KILL_MS / LEAK_GRACE_MS / ORPHAN_SWEEP_MS), and those are
// what have to fit inside an external harness's ceiling; a scoped mutation run
// is a handful of files, so they fire long before this does.
//
// MEASURED: a full 268-file run under 24-way CPU starvation (load avg ~30) takes
// (the suite is 273 files as of card 2026-0198's split; the figure below has not
// been re-taken since, and the margin is wide enough that it need not be)
// ~157-170s — so the original 240s left only ~1.4x margin and would have gone red
// on a merely-loaded box. A cap that fires on a slow box is a false red, and this
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
