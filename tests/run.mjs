// Programmatic test runner — the node wrapper on this device hoists leading
// `--flags` into NODE_OPTIONS, which rejects `--test`, so we invoke the
// node:test runner via its public API instead.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSafeRoot, assertStoreIsolated } from './safeStoreRoot.mjs';

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
const { orchStoreRoot } = await import('../src/projects.js');
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
function countFakeClaudeProcs() {
  let pids;
  try { pids = readdirSync('/proc'); } catch { return -1; } // no /proc (non-Linux)
  let n = 0;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('fake-claude.mjs')) n++;
    } catch { /* vanished or unreadable — skip */ }
  }
  return n;
}
let peakFakeClaude = 0;
let sampledProcs = false;
const procSampler = setInterval(() => {
  const n = countFakeClaudeProcs();
  if (n < 0) return; // /proc unavailable
  sampledProcs = true;
  if (n > peakFakeClaude) peakFakeClaude = n;
}, 100);
procSampler.unref?.();

const concurrency = resolveConcurrency();
// 60s per-file ceiling: proportionate headroom for heavy subprocess files that
// chain several 10s `waitFor`s (see helpers.mjs) when co-scheduled under
// concurrency on a slow Termux box — only fires on a genuine hang.
const stream = run({ files, concurrency, timeout: 60_000 });
let failed = 0;
stream.on('test:fail', (data) => {
  // Skip the implicit top-level pass/fail summary entries; only count real failures.
  if (data.details?.type === 'suite') return;
  failed++;
});
const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);
await new Promise((resolve) => reporter.on('end', resolve));

clearInterval(procSampler);
await fs.rm(safeRoot.root, { recursive: true, force: true });
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
