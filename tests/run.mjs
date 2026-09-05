// Programmatic test runner — the node wrapper on this device hoists leading
// `--flags` into NODE_OPTIONS, which rejects `--test`, so we invoke the
// node:test runner via its public API instead.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSafeRoot, assertStoreIsolated, removeSafeRoot, pinGitConfig } from './safeStoreRoot.mjs';
import { snapshot, censusMatching, liveChildren, descendants, killTree, killDescendants, killPids,
         processesWithMarker, settleResidual, reapResidual } from './procTree.mjs';
import { FILE_KILL_MS, RUN_CAP_MS, ORPHAN_SWEEP_MS, RESIDUAL_SETTLE_MS } from './hangGuardConfig.mjs';
import { enableCompileCache, COMPILE_CACHE_MAX_BYTES } from './compileCache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pin the whole run to a throwaway store root BEFORE any test file forks. The
// sidecar stores (archived-sessions, etc.) resolve their on-disk root from
// PROJECTS_ROOT, falling back to the REAL production store when unset. Every
// child process inherits this env, so a test with no root of its own — and any
// out-of-window fire-and-forget write — lands in the temp dir, never the live
// store. Individual files still mkdtemp their own per-test roots under it.
const safeRoot = createSafeRoot();
process.env.PROJECTS_ROOT = safeRoot.projectsRoot;
process.env.CLAUDE_PROJECTS_ROOT = safeRoot.claudeProjectsRoot;

// Run-unique marker, exported BEFORE any child forks so every descendant at any
// depth inherits it. This is how a leaked process is identified EXACTLY rather
// than heuristically — see processesWithMarker in tests/procTree.mjs. It gets its
// own variable because PROJECTS_ROOT (the obvious candidate) is reassigned by
// bootServer per server, so a grandchild spawned mid-test would not carry the
// run root. The ONLY other writer is markRun() in tests/safeStoreRoot.mjs, and
// it uses `??=` — it mints a marker for a STANDALONE file run and never replaces
// the one exported here, so a value seen by a child is always its own run's.
const RUN_MARKER = path.basename(safeRoot.root); // mkdtemp'd, so unique per run
process.env.CC_TEST_RUN_ID = RUN_MARKER;

// Pin git's global config at a run-scoped file, HERE — before any test file
// forks — so no repo the run creates inherits the developer's ~/.gitconfig or
// git's automatic detached repack. See pinGitConfig in tests/safeStoreRoot.mjs
// for what it disables and why the GIT_CONFIG_* env form does not close it
// (card 2026-0290 §3); tests/git-maintenance-isolation.test.mjs is its
// regression test.
pinGitConfig(safeRoot.root);

// Warm-start the children. Every test file runs in its own process and pays V8
// compile + type-stripping of the same `helpers.mjs -> server.ts -> src/*.ts`
// graph; a shared on-disk compile cache turns that ~770ms of each child's ~1s
// startup into a load. HERE, in the same pre-fork block as the env above, because
// run() below passes no `env` option — children inherit this process's env, so one
// call covers `npm test`, both gate rows and every mutation-harness iteration with
// no per-child wiring. tests/compileCache.mjs owns the directory choice, the size
// bound and the CC_TEST_COMPILE_CACHE=0 opt-out.
const compileCache = enableCompileCache({ repoRoot: path.join(__dirname, '..') });
// Printed ONLY on a reset — that is the one surprising event. A run that simply
// used its cache says nothing.
if (compileCache.reset) {
  console.log(`compile-cache: reset ${compileCache.dir} ` +
    `(was ${Math.round(compileCache.bytes / 1e6)} MB, cap ${Math.round(COMPILE_CACHE_MAX_BYTES / 1e6)} MB)`);
}

// Backstop: abort loudly if the resolved store still points into the real
// workspace (env forced above, so this validates the default and catches a
// future regression rather than silently corrupting production). Dynamic import
// so it runs AFTER the env is set (static imports hoist above statements).
const { orchStoreRoot } = await import('../src/projects.ts');
try {
  assertStoreIsolated(orchStoreRoot());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Each test file runs in its own child process (node:test `isolation: 'process'`
// default), and the suite is already isolated: bootServer binds an ephemeral
// port (listen(0)) and mkdtemp's a unique home per server, so files don't
// contend over ports or paths. That lets us run multiple files concurrently.
// Half the cores, capped at 8. Override with TEST_CONCURRENCY (1 restores the
// old fully-serial behavior).
//
// THE CAP WAS 4, AND THE `cores / 2` TERM IS UNCHANGED — only the ceiling moved.
// BE PRECISE ABOUT WHERE THAT BITES: the two expressions agree only while
// floor(cores / 2) <= 4, i.e. at **9 cores or fewer** (an 8-core box still gets 4,
// a 4-core box still gets 2). From 10 cores up the cap is no longer what binds and
// the result rises with the core count — 10 cores now gets 5, 12 gets 6, 14 gets 7,
// 16+ gets 8. A 12-core CI machine therefore DOES change behaviour here.
// Measured on a 16-core box, where both terms bind at once and every figure below
// is therefore the literal output of this expression, not an extrapolation from a
// different core count:
//   * 16 SLOTS ARE MEASURED WORSE, which is the question this cap exists to answer
//     and used to answer only by absence: 91.2s against 82.9s wall, for CPU up 54%
//     (746.8s against 484.8s), with per-file walls roughly DOUBLED as the
//     deadline-bound files starved. Raising the ceiling is a tried and rejected
//     idea, not an untried one.
//   * AND 8 IS ALREADY NEAR-SATURATED: summed file-time over wall runs 7.27-7.46 of
//     the 8 slots, so there is no idle dispatcher for a ninth to fill.
//   * THERE IS NO LONGER A SINGLE-FILE FLOOR, so more slots help again. There
//     was: tests/idle-wake-ownership.test.mjs cost 48.9s of a 57.2s quiet run at
//     44b0b60, DEADLINE-bound (bounded real wall-clock windows) rather than
//     CPU-bound, so no number of slots could get below it. Card 2026-0221 split
//     it into eight tests/idle-wake-*.test.mjs files over tests/idleWakeCase.mjs
//     — ~45 mutually independent windows, so the file's cost went from their SUM
//     to the family's MAX — taking the quiet suite to 42.5s (692aead) with a
//     largest member of 9.9s. tests/hang-guard.test.mjs was the same shape and
//     the same fix: card 2026-0198 split it into five
//     tests/hang-guard-*.test.mjs files, its cases being independent subprocess
//     runs, so its cost went from the SUM of their squeezed deadlines to the MAX
//     (30 183ms -> 8 493ms quiet). Past those two splits the suite is
//     aggregate-work-bound at concurrency 8, not bound by any one file.
//   * contention does NOT argue for backing off: under 8 spinners, concurrency 8
//     was both FASTER than 4 (79.2s vs 87.6s) and had a marginally BETTER per-file
//     kill margin (3.00x vs 2.92x). Both runs green. Nor does a whole SECOND suite
//     run alongside: `gate:systems` runs its two rows concurrently (card 2026-0344)
//     and the per-file walls did not move — the slowest file measured 16724/16681ms
//     across sequential rows against 16569/16611ms across concurrent ones.
//   * the fake-claude subprocess guardrail below stayed at peak 3-4 of a budget of
//     12 at every concurrency measured (4/8/16, quiet and contended) — and the one
//     reading above 3 at concurrency 4 was CONTENDED, i.e. the lower slot count, so
//     it is not concurrency-driven.
// The timing-sensitive waits (control-request 5s, waitFor 4s) were the original
// reason for 4; they were re-measured across 11 concurrency-8 whole-suite runs and
// none of them tripped.
function resolveConcurrency() {
  const env = process.env.TEST_CONCURRENCY;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

async function discover() {
  const want = process.argv.slice(2);
  if (want.length > 0) {
    return want.map(a => path.isAbsolute(a) ? a : path.resolve(process.cwd(), a));
  }
  const entries = await fs.readdir(__dirname);
  return entries
    .filter(n => n.endsWith('.test.mjs'))
    .map(n => path.join(__dirname, n))
    .sort();
}

const files = await discover();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

// Process-count guardrail. Tests default to an IN-PROCESS fake claude (see
// helpers.mjs bootServer), so a normal run should fork essentially no
// `fake-claude.mjs` subprocesses — only the handful of `realProcess:true` tests
// do. Sample the peak concurrent count via /proc and fail if it blows past a
// small budget, catching a regression where the default flips back to
// subprocess (which the Android phantom-process killer punishes) or a new test
// spawns real processes without opting in. /proc reads are safe on this host;
// pkill/lsof are not — do not use them here.
//
// IT COUNTS THIS RUN'S DESCENDANTS, NOT THE BOX'S PROCESSES (card 2026-0344).
// The budget is a claim about the suite's own behaviour, and a box-wide count
// makes a sibling suite run on the same machine — another worktree, or the
// gate's second row — fail a run that is green on every test. Measured before
// the fix: two concurrent `node tests/run.mjs` on this box both reported `fail
// 0` and both exited 1 at peaks of 14 and 15. censusMatching (tests/procTree.mjs)
// narrows the cmdline match by CC_TEST_RUN_ID; `peakFakeClaudeSeen` keeps the
// box-wide figure so the narrowing cannot go blind unnoticed.
const FAKE_CLAUDE_BUDGET = 12;
let peakFakeClaude = 0;     // peak carrying THIS run's marker — the budgeted figure
let peakFakeClaudeSeen = 0; // peak visible box-wide, whoever owns them
let sampledProcs = false;   // at least one tick READ /proc successfully
let samplerTicks = 0;       // ticks that ran at all

// ---------------------------------------------------------------------------
// Layer A of the suite hang guard (card 2026-0190) — the PROCESS-level
// guarantee. The `timeout: 60_000` passed to run() below reaches each child as
// `--test-timeout`, which is a PER-TEST deadline on the test body's promise: it
// cancels the TEST, and has nothing to do with the child's lifetime. A test
// that PASSES while leaking a handle never trips it at all. Since node emits a
// file's terminal `test:summary` only when its child EXITS, such a file wedges
// `reporter.on('end')` below forever — the 2026-0183 failure, which cost
// code-mutant's whole 300s external ceiling.
//
// `--test-force-exit` was evaluated and REJECTED: it does make leaking children
// exit, but it process.exit()s the child and TRUNCATES its pending report to the
// parent pipe. Two measured whole-suite scans with it on disagreed by 31 tests,
// one silently emitting nothing at all for tests/mcp-conductor-view.test.mjs
// while still reporting `fail 0` and exit 0. A silent green is strictly worse
// than a hang, which is why A1 below exists regardless of cause.
// ---------------------------------------------------------------------------

// A1 — completeness ledger. Every discovered file must emit its own terminal
// per-file summary. Anything discovered but never reported is named and counted
// as a failure at the end, so a silently-absent file is impossible.
const discovered = new Set(files);
const reported = new Set();
const fileStartedAt = new Map(); // file -> ms at first sighting
const fileDurations = new Map(); // file -> dispatch→child-done ms (see test:complete)

// A2 — per-file process watchdog. Maps live direct children to the test file
// named as the LAST element of their argv (verified: node:test's per-file child
// is a direct child of this process and carries the absolute path we passed to
// run() as its final argument). A child alive longer than FILE_KILL_MS is
// SIGKILLed together with its whole descendant tree.
const childFirstSeen = new Map(); // pid -> { at, file }
const killedFiles = new Map();    // file -> ms it had been alive when killed
// Descendants observed under each file's child WHILE IT WAS ALIVE. Recorded
// eagerly because we cannot recover them later: when the child dies, its own
// children are reparented to init, so they stop being descendants of this
// runner and no /proc walk from here will ever find them again. A grandchild
// that inherited the child's stdio keeps the REPORT PIPE open, so the stream
// never ends even though every test passed and the child exited cleanly
// (measured: the run hung until the absolute cap).
const fileDescendants = new Map(); // file -> Map<pid, ident>
const childGoneAt = new Map();     // file -> ms its last live child vanished
let sweptOrphans = 0;              // leaked pids we managed to SIGKILL
let streamStalled = false;         // all files accounted for, stream never ended
// When each discovered file became final — see the "SETTLED" note in the sampler.
const settledAt = new Map();       // file -> ms
let streamEnded = false;
let resolveWait = null;            // lets a stall abandon the reporter-end wait
// Set when node emits its single RUN-LEVEL summary (`data.file === undefined`).
// This is the discriminator that keeps the stall check from firing on a healthy
// run whose STDOUT CONSUMER is slow — see the stall block for why that matters.
let nodeFinished = false;

const procSampler = setInterval(() => {
  samplerTicks++;
  const snap = snapshot();
  const census = censusMatching('fake-claude.mjs', RUN_MARKER, snap);
  if (census.available) {
    sampledProcs = true;
    if (census.owned > peakFakeClaude) peakFakeClaude = census.owned;
    if (census.seen > peakFakeClaudeSeen) peakFakeClaudeSeen = census.seen;
  }
  const now = Date.now();
  const live = new Set();
  for (const { pid, argv } of liveChildren(process.pid, snap)) {
    const file = argv[argv.length - 1];
    if (!discovered.has(file)) continue; // not a per-file test child
    live.add(pid);
    if (!fileDescendants.has(file)) fileDescendants.set(file, new Map());
    for (const d of descendants(pid, snap)) {
      fileDescendants.get(file).set(d, snap.byPid.get(d)?.ident ?? null);
    }
    childGoneAt.delete(file);
    if (!childFirstSeen.has(pid)) { childFirstSeen.set(pid, { at: now, file }); continue; }
    const seen = childFirstSeen.get(pid);
    const age = now - seen.at;
    if (age <= FILE_KILL_MS || killedFiles.has(seen.file)) continue;
    // Kill the tree, not just the child — see fileDescendants above.
    const pids = killTree(pid, snap);
    killedFiles.set(seen.file, age);
    console.error(
      `\nhang-guard: KILLED ${seen.file} after ${age}ms (limit ${FILE_KILL_MS}ms; ` +
      `SIGKILLed pids ${pids.join(',') || 'none'}). The file never exited, so it would ` +
      'have hung the whole run — node only reports a file when its child exits.',
    );
  }
  // Drop exited pids so a recycled pid can't inherit a stale firstSeen, and
  // note when each file lost its last live child.
  for (const [pid, seen] of childFirstSeen) {
    if (live.has(pid)) continue;
    childFirstSeen.delete(pid);
    if (!childGoneAt.has(seen.file)) childGoneAt.set(seen.file, now);
  }
  // STREAM-STALL DETECTION — the termination guarantee for a leaked process.
  //
  // The trigger is deliberately NOT "this file failed to report". The measured
  // orphan shape is a file whose child exits CLEANLY with every test passing:
  // its summary ARRIVES, so a `reported`-gated check switches itself off in
  // exactly the case it exists for. Meanwhile a process holding stdio it
  // inherited from that child keeps our read end open, so `reporter.on('end')`
  // never fires and the run falls through to the absolute cap — the 2026-0183
  // outcome, reached through a shape we had already measured.
  //
  // The honest condition is "the run should be over but is not": every
  // discovered file is accounted for (reported or killed), yet the stream has
  // not ended. At that point the stream can teach us NOTHING further — every
  // file's verdict is already in — so we stop waiting on it. That is what bounds
  // the damage even when the leaked process cannot be identified at all, and it
  // needs no /proc access to work.
  // A file is SETTLED once we will learn nothing further about it.
  //   1. it reported — the ordinary case;
  //   2. we killed it — NOT load-bearing for detection: a killed file's child is
  //      by definition gone, so clause 3 would settle it anyway. All this clause
  //      changes is the TIMESTAMP (kill time rather than the earlier
  //      child-vanished time), which widens the grace slightly for a killed file.
  //      Nothing observes the difference; it is kept for intent, not effect;
  //   3. its child is gone and it still has not reported — load-bearing. Layer B
  //      exits a leaking child, which yields a test:fail but never a
  //      test:summary, so waiting on `reported` alone would wait forever and fall
  //      through to the cap.
  for (const f of discovered) {
    if (settledAt.has(f)) continue;
    if (reported.has(f) || killedFiles.has(f)) settledAt.set(f, now);
    else if (childGoneAt.has(f)) settledAt.set(f, childGoneAt.get(f));
  }
  // Grace measured from the LAST file to settle, so it is applied once rather
  // than compounding per file.
  // `nodeFinished` is REQUIRED, and is what makes this safe on a slow stdout
  // consumer. The ledger settles from events on the SOURCE stream, which fire at
  // push time; the wait is on the COMPOSED reporter, which cannot end until
  // stdout drains. Under `| less`, `| tee` on a slow disk, or any bursty non-TTY
  // consumer, everything settles while `end` is still blocked on backpressure —
  // measured: 9 sampler ticks across a 2s paused reader — so without this gate a
  // perfectly healthy run would declare a stall, SIGKILL-sweep and exit 1.
  // Raising ORPHAN_SWEEP_MS cannot fix that; a pager pause is unbounded.
  //
  // The run-level summary is the exact discriminator (both directions measured):
  // node emits it at push time in the clean case (~44ms, with nothing consuming
  // our stdout) and NEVER in the genuine wedge (absent through 5s). So node
  // finished ⇒ never a stall; node didn't finish ⇒ detection unchanged.
  const shouldBeOver = !nodeFinished &&
    settledAt.size === discovered.size &&
    now - Math.max(...settledAt.values()) > ORPHAN_SWEEP_MS;

  if (!streamEnded && !streamStalled && shouldBeOver) {
    streamStalled = true;
    sweepOrphans(snap, 'stream stall');
    console.error(
      `\nhang-guard: STREAM STALLED — all ${discovered.size} discovered file(s) are settled, ` +
      `but the report stream had still not ended ${ORPHAN_SWEEP_MS}ms later. A test leaked a live ` +
      'process holding stdio inherited from its test child, which keeps our read end open. ' +
      'Abandoning the wait so the run still produces a verdict. This FAILS the run: a test that ' +
      'leaks a live process must not read as a pass.',
    );
    resolveWait?.();
  }
}, 100);

// BEST-EFFORT kill of leaked processes. Two sources, neither complete:
//   1. our own live descendants (a grandchild whose parent is still alive);
//   2. pids recorded under each file while its child was alive.
//
// WHY THIS CANNOT BE MADE COMPLETE — do not re-attempt the obvious fixes:
//   * A grandchild is reparented to init the moment its parent dies, so it is
//     no longer reachable by any /proc walk from here.
//   * If the file completed inside one 100ms sampler tick it was never recorded
//     either (measured: a 33ms file's orphan survived an entire run).
//   * Identifying the orphan by FD-INODE MATCHING does not work: node spawns
//     child stdio over socketpairs, and a socketpair's two ends have DIFFERENT
//     inodes, so our /proc/<pid>/fd link never equals the orphan's (measured:
//     zero overlap, every time). This refutes inode EQUALITY only — peer
//     resolution does exist, via netlink UNIX_DIAG_PEER; that is out of scope
//     here, not impossible, so nobody should be warned off it by this note.
//
// The third source below is an EXACT identity and covers everything the first
// two miss. Termination does not depend on any of them: the stream-stall check
// above needs no /proc at all.
function sweepOrphans(snap, why) {
  const targets = descendants(process.pid, snap).reverse()
    .map(pid => ({ pid, ident: snap.byPid.get(pid)?.ident ?? null }));
  // Everything carrying this run's marker: an EXACT identity that covers a
  // detached orphan, a reparented one, and one from a file too fast to have been
  // sampled — none of which the two lists above can see. Needs the environ-aware
  // snapshot, which is why the sweep takes its own rather than reusing the
  // sampler's.
  targets.push(...processesWithMarker(RUN_MARKER, snapshot({ environ: true })));
  for (const perFile of fileDescendants.values()) {
    for (const [pid, ident] of [...perFile].reverse()) targets.push({ pid, ident });
  }
  const seen = new Set();
  const orphans = killPids(targets.filter(t => (seen.has(t.pid) ? false : seen.add(t.pid))));
  if (orphans.length === 0) return;
  sweptOrphans += orphans.length;
  console.error(
    `\nhang-guard: SWEPT ${orphans.length} leaked process(es) ` +
    `(pids ${orphans.join(',')}; trigger: ${why}).`,
  );
}
// Sweep on an INTERRUPTED run too. A `detached` child is in its OWN process
// group, so a terminal SIGINT to the runner's group never reaches it — which is
// why an interrupted campaign leaks where a completed one (now) does not.
// Registered here, immediately after sweepOrphans' definition, because
// RUN_MARKER and sweepOrphans are `const`/function bindings this closure reads.
//
// SIGKILL stays uncoverable BY CONSTRUCTION — no in-process handler can run for
// it. tests/reapOrphans.mjs exists for that residue.
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(sig, () => {
    console.error(`\nhang-guard: ${sig} — sweeping this run's processes before exiting.`);
    sweepOrphans(snapshot(), sig.toLowerCase());
    // Restate 128+signo explicitly: installing ANY listener for a signal removes
    // node's own default handling, exit status included, so without this the
    // runner would fall through to a natural exit and every caller would see a
    // different status than before. The normal-exit path (`process.exit(failed
    // === 0 && !guardrailFailed ? 0 : 1)`) is untouched — `process.once` never
    // fires on it.
    process.exit(code);
  });
}

procSampler.unref?.();

const concurrency = resolveConcurrency();
// 60s per-file ceiling: proportionate headroom for heavy subprocess files that
// chain several 10s `waitFor`s (see helpers.mjs) when co-scheduled under
// concurrency on a slow Termux box — only fires on a genuine hang.
// Preload the DOM-vs-null tripwire into every per-file child: a node compared
// against null/undefined by an equal-family assertion throws a short
// AssertionError instead of stalling the file for 33-120s in assert's
// serializer (tests/dom-assert-tripwire.mjs). `run()` spawns process.execPath
// directly, so this does not go through the node wrapper noted at line 1.
// Preload the handle-leak guard alongside it (Layer B — tests/handleLeakGuard.mjs):
// it registers a root after() hook that arms an unref'd LEAK_GRACE_MS timer, so a
// file which finishes its tests but leaves the loop open fails by name instead of
// hanging the run forever.
const tripwireUrl = pathToFileURL(path.join(__dirname, 'dom-assert-tripwire.mjs')).href;
const leakGuardUrl = pathToFileURL(path.join(__dirname, 'handleLeakGuard.mjs')).href;
const stream = run({
  files, concurrency, timeout: 60_000,
  execArgv: ['--import', tripwireUrl, '--import', leakGuardUrl],
});
let failed = 0;
// A KILLED FILE'S RED OUTCOME IS GUARDED TWICE, AND NO TEST COVERS EITHER GUARD
// ALONE. This handler is one path: when the watchdog SIGKILLs a child, node
// synthesizes a file-level test:fail, counted here. The other is the completeness
// ledger's `unreported` loop near the end of this file, which also increments
// `failed` because a killed child never emits its summary. Either one alone still
// fails the run, so disabling just one is invisible to
// tests/summary-attribution.test.mjs (its killed-file case asserts only that the run
// is red) — verified: a mutant disabling either single site SURVIVES, while one
// disabling both is killed. If you remove one, you are removing the redundancy, not
// dead code, and nothing will tell you.
stream.on('test:fail', (data) => {
  // Skip the implicit top-level pass/fail summary entries; only count real failures.
  if (data.details?.type === 'suite') return;
  failed++;
});
// Ledger wiring. A per-file `test:summary` carries `data.file`; the single
// run-level summary emitted last carries `file === undefined`, so the truthiness
// check is what distinguishes them (verified against node v24.18.0).
stream.on('test:dequeue', (d) => {
  if (d.file && !fileStartedAt.has(d.file)) fileStartedAt.set(d.file, Date.now());
});
stream.on('test:summary', (d) => {
  if (!d.file) { nodeFinished = true; return; } // the single run-level summary
  reported.add(d.file);
});
// DURATION COMES FROM test:complete, NOT test:summary — do not fold this back
// into the handler above. Per-file summaries are emitted in `files` order, so a
// file that finishes ahead of an earlier-listed one has its summary HELD until
// that one reports, and then `Date.now()` charges it the earlier file's wall.
// Measured, same two files, order swapped: parser.test.mjs reported 1172ms in one
// order and 108ms in the other, and in the first it RANKED ABOVE the file that
// actually spent the time. That inflation is what made the slowest-5 line read as
// a plateau.
//
// test:complete fires at the file's real completion and is order-independent
// (measured). Preferred over test:summary's own duration_ms, which is measured
// inside the child and so excludes spawn+import: dispatch->child-done keeps this
// figure comparable to FILE_KILL_MS, which is a process-lifetime deadline.
// MEASURED on a 16-core box at the default concurrency: summary.duration_ms runs
// 31-297ms LOWER, never higher, across 90 file observations. SAMPLE: every 6th name
// of the sorted tests/*.test.mjs list (45 of the 266 files then in the suite — the
// live count is on the verdict line below), skipping the files that
// spawn nested runners of their own (then hang-guard + summary-attribution; now the
// five hang-guard-*.test.mjs + summary-attribution); two runs, one
// idle and one under a concurrent mutation campaign, which agreed closely — so the
// range is not a load artefact.
//
// THE RANGE IS THE PORTABLE PART; THE CENTRE IS NOT. Median 219-234ms and mean
// 179-181ms describe THAT sample. The excluded work IS spawn+import, so the centre
// tracks the import weight of whichever files you pick: the cheapest files here sit
// at ~31-35ms and express+ws importers reach ~297ms, and a lighter-weight subset of
// the suite medians near 87ms. Quote the population with the number, and do not
// re-narrow it to a tight range — an earlier "consistently 25-50ms" claim was ~5x
// low because it described only the cheapest files.
//
// Inner tests emit test:complete too (measured: 11 events for tests/diff.test.mjs).
// The FILE-level one carries name === file, which is the exact discriminator, so
// this does not rely on it being last.
stream.on('test:complete', (d) => {
  if (!d.file || d.name !== d.file) return; // only the file-level test
  const startedAt = fileStartedAt.get(d.file);
  if (startedAt !== undefined) fileDurations.set(d.file, Date.now() - startedAt);
});
const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);

// A3 — absolute run cap. Races the stream's own end against RUN_CAP_MS so a
// wedge we somehow failed to kill still produces OUR verdict rather than an
// external harness's ceiling.
//
// The cap timer is deliberately REF'D (the plan called for unref'd), and this is
// LOAD-BEARING, not belt-and-braces. An unref'd timer cannot fire once the loop
// has otherwise drained — the "all children gone but the stream never emitted
// 'end'" case, where the runner would exit NATURALLY with code 0 and skip the
// verdict entirely. Critically, `procSampler` is itself .unref()'d, so on a
// genuinely drained loop the stream-stall check above cannot run either: this
// timer is the ONLY surviving mechanism for that shape. Do not unref it.
//
// Disclosed gap: no test discriminates ref'd from unref'd, because inducing a
// drained loop with a pending stream requires something holding the stream open,
// and everything that does also holds a handle. tests/hang-guard-run-cap.test.mjs
// pins the cap's observable behaviour instead (fires / fails / prints the verdict /
// bounds the wall) with a child still alive — a state an unref'd timer would also
// fire in. The `finally` below is what stops it outliving a clean run.
let capTripped = false;
let capTimer;
try {
  await Promise.race([
    new Promise((resolve) => {
      resolveWait = resolve; // the stream-stall check above abandons the wait
      reporter.on('end', () => { streamEnded = true; resolve(); });
    }),
    new Promise((resolve) => { capTimer = setTimeout(() => { capTripped = true; resolve(); }, RUN_CAP_MS); }),
  ]);
} finally {
  // Release on BOTH paths. A teardown reachable only on success is the exact bug
  // class this card is about — do not move these into the happy path.
  clearInterval(procSampler);
  clearTimeout(capTimer);
}

if (capTripped) {
  console.error(
    `\nhang-guard: RUN CAP TRIPPED — the run exceeded ${RUN_CAP_MS}ms and was aborted. ` +
    'Raise CC_TEST_RUN_CAP_MS if the box is merely slow (e.g. a starvation campaign); ' +
    'otherwise a file is wedged and is named below.',
  );
  // killDescendants, NOT killTree — killTree(process.pid) would SIGKILL the
  // runner itself and turn a reportable timeout into a bare exit 137 with no
  // verdict at all.
  const snap = snapshot();
  for (const pid of killDescendants(process.pid, snap)) {
    console.error(`hang-guard:   SIGKILLed straggler ${pid}`);
  }
  // Same sweep the sampler runs — one implementation, so the cap path cannot
  // drift from it.
  sweepOrphans(snap, 'run cap');
  failed++;
}

// The sweep on the NORMAL end of a run. Every other trigger sits on a path that
// is already failing (stream stall, run cap), and a leak reaches neither: a
// leaked process only wedges the stream if it holds stdio inherited from US, and
// a plugin child holds pipes to the TEST FILE's child instead. So the stream ends
// cleanly, the cap is never reached, nothing looks, and the process survives on
// the box forever (measured: 21 such orphans across 9 runs, every one of whose
// run roots had been removed — i.e. every owning run exited normally).
sweepOrphans(snapshot(), 'run end');
// Reap BEFORE the run root is removed, so a live process can never be left with a
// (deleted) cwd inside it. This check is what PINS that order: it sits between
// the sweep and removeSafeRoot below, so moving the sweep after teardown makes it
// fire.
//
// It HOLDS the invariant rather than only reporting it. Everything in `residual`
// matched THIS run's marker, so it is already licensed by the same identity the
// sweep uses — reap it through the same killPids path. Reporting alone would print
// the diagnostic and then let removeSafeRoot run anyway, leaving a live process
// with a (deleted) cwd inside a deleted root: exactly the state the order exists
// to prevent. The reap does not soften the verdict — the run still goes red.
//
// Both halves live in tests/procTree.mjs so they are pinned by return value
// rather than only by whole-run behaviour: inline, deleting the reap left the
// entire suite green (the diagnostic still printed, the run still reddened), and
// the settle loop's stale-snapshot filter had no discriminating test at all.
const residual = await settleResidual(
  processesWithMarker(RUN_MARKER, snapshot({ environ: true })),
  RUN_MARKER,
  { settleMs: RESIDUAL_SETTLE_MS },
);
if (residual.length > 0) {
  console.error(`\nhang-guard: ${reapResidual(residual).message}`);
  failed++;
}

// A2b — the verdict line, printed UNCONDITIONALLY (green or red). A green run
// must STATE the property rather than merely not violate it, and a red run needs
// it just as much: the slowest-file figure is the standing evidence that
// FILE_KILL_MS's margin is still real as the suite grows.
const unreported = [...discovered].filter(f => !reported.has(f));
const slowest = [...fileDurations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
// A sweep means a test leaked a live process that had to be SIGKILLed — a defect
// in the test, not a tidy-up. Without this branch the run reads exit 0 and we
// have traded a hang for a silent green, the very class this card names as worse
// than a hang. Counted as ONE defect regardless of how many processes it left
// behind: the stall and the sweep are two symptoms of the same leak, and `failed`
// feeds a count-based parser that this card exists to keep honest.
//
// It is LOAD-BEARING for a leak that wedges nothing (card 2026-0226): the run-end
// sweep above reaches a process that neither the stall trigger nor the cap can
// see, and on that path `sweptOrphans > 0` is the signal. It was belt-and-braces
// while every sweep sat on an already-failing path; that is no longer so, and
// deleting it now buys exactly that outcome.
//
// It is not the ONLY guard on that path — the RESIDUAL check above is a second
// one, for a process that survived the sweep rather than one that was swept. Do
// not restate a count of the guards here: the set changes on other cards, and a
// census in a comment goes stale silently. Grep `failed++` for the live list.
if (streamStalled || sweptOrphans > 0) failed++;
console.log(
  `\nhang-guard: ${reported.size}/${discovered.size} files reported, ` +
  `${killedFiles.size} killed, ${sweptOrphans} leaked process(es) swept, ` +
  `${streamStalled ? 'STREAM STALLED' : 'stream ended cleanly'}, ` +
  `${capTripped ? 'RUN CAP TRIPPED' : 'run cap not reached'}`,
);
// The verdict line is the standing evidence for the whole property, so it must
// say when the watchdog could not actually look. Without /proc, the per-file
// kill watchdog and the orphan sweep are both inert and "0 killed / 0 swept"
// means "blind", not "clean".
if (!sampledProcs && samplerTicks > 0) {
  console.log(
    'hang-guard: WARNING — /proc was unavailable, so the per-file kill watchdog ' +
    'and the orphan sweep never ran. The counts above are "not observed", not "none".',
  );
}
if (slowest.length > 0) {
  console.log(
    `hang-guard: slowest files (limit ${FILE_KILL_MS}ms): ` +
    slowest.map(([f, ms]) => `${path.basename(f)} ${ms}ms`).join(', '),
  );
}
for (const file of unreported) {
  // Never silently absent — whatever the cause (wedged child, a truncated
  // report, a process.exit before any test registered), the file is named and
  // the run goes red. This is the SECOND of the two independent guards on a killed
  // file's red outcome (the other is the test:fail handler above, which sees the
  // synthesized file-level failure). Removing either alone keeps the run red and is
  // therefore caught by no test — see the note on that handler.
  console.error(`hang-guard: NO REPORT from ${file} — the file never emitted a summary.`);
  failed++;
}

await removeSafeRoot(safeRoot.root);
let guardrailFailed = false;
if (sampledProcs) {
  console.log(`\nguardrail: peak concurrent fake-claude subprocesses = ${peakFakeClaude} (budget ${FAKE_CLAUDE_BUDGET})`);
  // Only when the box held more than we own. It is not decoration: it is the one
  // signal that would show this guard going BLIND. hasMarker fails closed, so a
  // future test that spawns fake-claude with a curated env dropping CC_TEST_RUN_ID
  // takes the counted figure to 0 while the box-wide one stays high — which reads
  // as a clean run unless the two are printed together.
  if (peakFakeClaudeSeen > peakFakeClaude) {
    console.log(
      `guardrail: peak visible box-wide = ${peakFakeClaudeSeen}; the excess carries another ` +
      'CC_TEST_RUN_ID (a concurrent suite run) and is not this run\'s to answer for. A COUNTED ' +
      'figure near zero against a high box-wide one is this guard blind, not a clean run.',
    );
  }
  // RUN_REAL_CLAUDE runs extra real-binary smoke tests; don't enforce there.
  if (process.env.RUN_REAL_CLAUDE !== '1' && peakFakeClaude > FAKE_CLAUDE_BUDGET) {
    console.error(
      `guardrail FAILED: peak ${peakFakeClaude} exceeded budget ${FAKE_CLAUDE_BUDGET}. ` +
      'A test likely spawns real fake-claude subprocesses without bootServer({realProcess:true}) ' +
      '— the default must stay in-process.',
    );
    guardrailFailed = true;
  }
} else {
  console.log('\nguardrail: /proc unavailable — peak subprocess sampling skipped');
}
process.exit(failed === 0 && !guardrailFailed ? 0 : 1);
