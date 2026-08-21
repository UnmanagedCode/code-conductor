// Programmatic test runner — the node wrapper on this device hoists leading
// `--flags` into NODE_OPTIONS, which rejects `--test`, so we invoke the
// node:test runner via its public API instead.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSafeRoot, assertStoreIsolated, removeSafeRoot } from './safeStoreRoot.mjs';
import { snapshot, countMatching, liveChildren, descendants, killTree, killDescendants, killPids,
         orphansInOurGroup } from './procTree.mjs';
import { FILE_KILL_MS, RUN_CAP_MS, ORPHAN_SWEEP_MS } from './hangGuardConfig.mjs';

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
// Default to half the cores (capped at 4) to leave headroom for each file's
// express+ws boot and the timing-sensitive waits (control-request 5s, waitFor
// 4s) that contention could otherwise trip. Override with TEST_CONCURRENCY
// (1 restores the old fully-serial behavior).
function resolveConcurrency() {
  const env = process.env.TEST_CONCURRENCY;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
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
const FAKE_CLAUDE_BUDGET = 12;
let peakFakeClaude = 0;
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
const fileDurations = new Map(); // file -> dispatch→report ms

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

const procSampler = setInterval(() => {
  samplerTicks++;
  const snap = snapshot();
  const n = countMatching('fake-claude.mjs', snap);
  if (n >= 0) {
    sampledProcs = true;
    if (n > peakFakeClaude) peakFakeClaude = n;
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
  // A file is SETTLED once we will learn nothing further about it. Three ways,
  // and all three are needed: it reported; we killed it; or its child is gone
  // and it still has not reported (Layer B exits a leaking child, which produces
  // a test:fail but never a test:summary — so waiting for `reported` alone would
  // wait forever and fall through to the cap).
  for (const f of discovered) {
    if (settledAt.has(f)) continue;
    if (reported.has(f) || killedFiles.has(f)) settledAt.set(f, now);
    else if (childGoneAt.has(f)) settledAt.set(f, childGoneAt.get(f));
  }
  // Grace measured from the LAST file to settle, so it is applied once rather
  // than compounding per file.
  const shouldBeOver = settledAt.size === discovered.size &&
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
//   * Fingerprinting the orphan by the stdio channel it inherited from us DOES
//     NOT WORK: node spawns child stdio over socketpairs, and a socketpair's two
//     ends have DIFFERENT inodes, so our /proc/<pid>/fd link never equals the
//     orphan's. Measured: zero matches, every time.
//   * Matching on `ppid == 1` was rejected as unsafe — it cannot tell our orphan
//     from an unrelated system daemon.
//
// Termination is therefore guaranteed by the stream-stall check above, which
// needs none of this; killing is opportunistic. A leaked process we cannot
// identify still fails the run and is still reported, as a stall.
function sweepOrphans(snap, why) {
  const targets = descendants(process.pid, snap).reverse()
    .map(pid => ({ pid, ident: snap.byPid.get(pid)?.ident ?? null }));
  // Reparented-but-still-in-our-job processes. This is what catches a leak from
  // a file too fast to have been sampled, which neither list below can see.
  targets.push(...orphansInOurGroup(snap));
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
  if (!d.file) return;
  reported.add(d.file);
  const startedAt = fileStartedAt.get(d.file);
  if (startedAt !== undefined) fileDurations.set(d.file, Date.now() - startedAt);
});
const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);

// A3 — absolute run cap. Races the stream's own end against RUN_CAP_MS so a
// wedge we somehow failed to kill still produces OUR verdict rather than an
// external harness's ceiling.
//
// The cap timer is deliberately REF'D (the plan called for unref'd). An unref'd
// timer cannot fire if the loop has otherwise drained — precisely the "all
// children gone but the stream never emitted 'end'" case, where the parent would
// then exit NATURALLY with code 0, skipping the verdict entirely. That is the
// silent-green class this card exists to close, so the timer holds the loop and
// the `finally` below is what stops it from outliving a clean run.
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

// A2b — the verdict line, printed UNCONDITIONALLY (green or red). A green run
// must STATE the property rather than merely not violate it, and a red run needs
// it just as much: the slowest-file figure is the standing evidence that
// FILE_KILL_MS's margin is still real as the suite grows.
const unreported = [...discovered].filter(f => !reported.has(f));
const slowest = [...fileDurations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
// A sweep means a test leaked a live process that had to be SIGKILLed. That is
// a defect in the test, not a tidy-up: without this the run reads exit 0 and we
// have traded a hang for a silent green — the very class this card names as
// worse than a hang.
// A stall or a sweep means a test leaked a live process. Without this the run
// reads exit 0 and we have traded a hang for a silent green — the very class
// this card names as worse than a hang.
if (streamStalled) failed++;
failed += sweptOrphans;
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
  // the run goes red.
  console.error(`hang-guard: NO REPORT from ${file} — the file never emitted a summary.`);
  failed++;
}

await removeSafeRoot(safeRoot.root);
let guardrailFailed = false;
if (sampledProcs) {
  console.log(`\nguardrail: peak concurrent fake-claude subprocesses = ${peakFakeClaude} (budget ${FAKE_CLAUDE_BUDGET})`);
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
