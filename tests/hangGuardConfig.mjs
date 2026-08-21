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
// MEASURED slowest whole file on this tree: ~23.1s quiet / ~28.8s under 24-way
// CPU starvation (tests/hang-guard.test.mjs itself, which serially spawns ~11
// nested runners including CPU-burning and deliberately-capped ones), against a
// 90s limit — a ~3.1x margin at the starved figure. This figure
// MOVES with two things this card owns: the number of cases in
// tests/hang-guard.test.mjs, and the bounded wall-clock windows in
// tests/mcp-subscribe-to-idle.test.mjs (WATCHDOG_MS/OBSERVE_MS add ~6s of
// deliberate real waiting across three tests there). The `hang-guard:` verdict line prints the slowest 5 files on every
// run (green or red) — that live line, not this comment, is the load-bearing
// evidence; re-read it rather than trusting this number.
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
