// Single source for every hang-guard deadline. The parent (tests/run.mjs,
// Layer A) and the child-side preload (tests/handleLeakGuard.mjs, Layer B) both
// read from here, so a guard can never protect its own private copy of a
// number.
//
// Every deadline is env-overridable for exactly one reason: the guard's own
// regression suite (tests/hang-guard.test.mjs) drives the REAL code path at
// millisecond scale instead of asserting against a re-implementation of the
// rule. That keeps CONVENTIONS.md's "no long real sleeps" rule satisfiable
// without a second, test-only copy of the logic.

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
// MEASURED slowest whole file: ~30.0s quiet, **~38.6s under 24-way CPU
// starvation** — a ~2.3x margin against the 90s limit at the worst observation.
// There is ONE culprit, tests/hang-guard.test.mjs, which serially spawns a dozen
// nested runners, some CPU-burning. It is DEADLINE-bound rather than CPU-bound:
// ~29.9s at concurrency 4, ~30.1s at 8, ~30.1s at 16, ~30.0s under 8-spinner
// contention — 0.8% across a 4x concurrency range.
//
// DO NOT READ THE TOP FIVE AS A PLATEAU. This comment used to, on the strength of
// the top five sitting "within ~600ms of each other" quiet and ~2.7s starved. That
// spread was a BUG in the figure, not a property of the suite: run.mjs computed
// each file's duration at `test:summary` time, and per-file summaries are emitted
// in `files` order, so a file finishing ahead of an earlier-listed one had its
// summary HELD and was then charged that file's wall. The four files trailing
// hang-guard.test.mjs in the old ranking were inheriting its ~30s; their real
// durations were 8ms, 344ms, 386ms and ~100ms. Card 2026-0206 moved the figure to
// `test:complete` (order-independent). The ranking is now steep — measured at
// concurrency 8: 29 953 / 15 251 / 13 126 / 11 326 / 10 362 ms — so a flat top five
// reappearing is itself the signal that the metric regressed.
//
// Card 2026-0198's evidence quotes the old plateau reading and its "before"
// figures were taken with the broken metric; restate them against the fixed one
// before relying on them.
//
// WATCH THE TREND. Across this card's three review rounds the starved
// slowest-file figure went 19.4s -> 28.8s -> 38.6s (margin 4.6x -> 3.1x -> 2.3x),
// driven almost
// entirely by cases added to tests/hang-guard.test.mjs plus the bounded
// wall-clock windows in tests/mcp-subscribe-to-idle.test.mjs. It is still safe,
// but the next few additions to either file should either split
// tests/hang-guard.test.mjs (its cases are independent subprocess runs, so
// splitting recovers concurrency) or raise this constant — deliberately, with a
// fresh measurement, not reactively after a false KILL.
//
// THE BINDING CONSTRAINT IS NOT THE HEALTHY-RUN FIGURE. 38.6s / ~2.3x is what a
// GREEN run costs. What actually governs whether the regression suite can be
// silenced by the regressions it catches is the BROKEN-GUARD figure: with the
// stall trigger disabled, several cases in tests/hang-guard.test.mjs fall back to
// their inner cap and the file takes **68.9s quiet** — ~1.31x against this
// constant, and at or past it once starved. Obtain it in one command:
//
//   temporarily disable the stall branch in tests/run.mjs, then
//   `time node tests/run.mjs tests/hang-guard.test.mjs`
//
// The reassuring half: exceeding it yields a TRUNCATED RED, never a green. The
// per-file watchdog SIGKILLs the file, the completeness ledger names it, and the
// run fails; what is lost is the diagnostic saying WHICH guard broke. That is why
// card 2026-0198 (split tests/hang-guard.test.mjs — its cases are independent
// subprocess runs, so splitting recovers concurrency AND divides the broken-guard
// cost) is the right fix rather than raising this constant.
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
