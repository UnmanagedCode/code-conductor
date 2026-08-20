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
import { snapshot, countMatching, liveChildren, descendants, killTree, killDescendants, killPids } from './procTree.mjs';
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
const countFakeClaudeProcs = () => countMatching('fake-claude.mjs');
let peakFakeClaude = 0;
let sampledProcs = false;

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
const fileDescendants = new Map(); // file -> Set<pid>
const childGoneAt = new Map();     // file -> ms its last live child vanished
const sweptFiles = new Set();

const procSampler = setInterval(() => {
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
    if (!fileDescendants.has(file)) fileDescendants.set(file, new Set());
    for (const d of descendants(pid, snap)) fileDescendants.get(file).add(d);
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
  // Orphan sweep: the child is gone but the file still has not reported. In the
  // normal case the summary follows the child's exit within milliseconds, so
  // anything still outstanding after ORPHAN_SWEEP_MS means something the child
  // left behind is holding the pipe. Kill exactly the pids we recorded under it.
  for (const [file, goneAt] of childGoneAt) {
    if (reported.has(file) || sweptFiles.has(file)) continue;
    if (now - goneAt <= ORPHAN_SWEEP_MS) continue;
    sweptFiles.add(file);
    const orphans = killPids([...(fileDescendants.get(file) ?? [])].reverse());
    if (orphans.length === 0) continue;
    console.error(
      `\nhang-guard: SWEPT ${orphans.length} orphan process(es) left by ${file} ` +
      `(pids ${orphans.join(',')}). They outlived their parent while holding its stdio, ` +
      'which keeps the report pipe open and hangs the run.',
    );
  }
}, 100);
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
    new Promise((resolve) => reporter.on('end', resolve)),
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
  // verdict at all. Also sweep every orphan recorded under a file whose child
  // has already been reparented away.
  const stragglers = [
    ...killDescendants(process.pid),
    ...killPids([...fileDescendants.values()].flatMap(s => [...s])),
  ];
  for (const pid of stragglers) console.error(`hang-guard:   SIGKILLed straggler ${pid}`);
  failed++;
}

// A2b — the verdict line, printed UNCONDITIONALLY (green or red). A green run
// must STATE the property rather than merely not violate it, and a red run needs
// it just as much: the slowest-file figure is the standing evidence that
// FILE_KILL_MS's margin is still real as the suite grows.
const unreported = [...discovered].filter(f => !reported.has(f));
const slowest = [...fileDurations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(
  `\nhang-guard: ${reported.size}/${discovered.size} files reported, ` +
  `${killedFiles.size} killed, ${capTripped ? 'RUN CAP TRIPPED' : 'run cap not reached'}`,
);
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
