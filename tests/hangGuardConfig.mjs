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
// Slowest whole file measured on this tree: mcp-subscribe-to-idle at 12.3s.
// The `hang-guard:` verdict line prints the slowest file every run — that is
// the standing evidence this margin is still real as the suite grows.
export const FILE_KILL_MS = ms('CC_TEST_FILE_KILL_MS', 90_000);

// Child-side: how long after the root after() hook begins we wait before
// declaring the event loop leaked. The whole 267-file suite runs in ~62s at
// concurrency 4, so no single file's teardown comes near this.
export const LEAK_GRACE_MS = ms('CC_TEST_LEAK_GRACE_MS', 15_000);

// Parent-side: how long after a file's child process disappears we still wait
// for that file's summary before assuming something the child left behind is
// holding the report pipe, and sweeping the orphans we recorded under it.
// Normally the summary follows the child's exit within milliseconds, so this is
// almost pure margin; it exists because an orphan grandchild is reparented to
// init the instant its parent dies and is unreachable from here afterwards.
export const ORPHAN_SWEEP_MS = ms('CC_TEST_ORPHAN_SWEEP_MS', 5_000);

// Parent-side, absolute: the whole run may not exceed this. Sized so WE
// produce the verdict rather than an external harness's ceiling (code-mutant
// kills at 300s). A run that is merely slow — e.g. the criterion-3 starvation
// campaign under 24-way CPU load — must raise this via CC_TEST_RUN_CAP_MS
// rather than eat a false red; see docs/architecture.md.
export const RUN_CAP_MS = ms('CC_TEST_RUN_CAP_MS', 240_000);
