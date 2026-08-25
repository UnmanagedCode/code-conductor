// Shared harness for the hang-guard regression suite (cards 2026-0190, 2026-0198).
//
// Each case runs the REAL tests/run.mjs as a subprocess against a fixture under
// tests/fixtures/hang/, with the deadlines squeezed to ~1.5-8s via the CC_TEST_*
// overrides that tests/hangGuardConfig.mjs already exposes. Nothing here
// re-implements the guard's rules: the leaked-handle predicate lives only in
// tests/handleLeakGuard.mjs and every deadline only in hangGuardConfig.mjs, so
// the cases set env and read output. A copy of the rule here could agree with
// itself while the shipped guard was broken.
//
// Fixtures are `*.fixture.mjs`, so run.mjs's discover() (which globs
// `*.test.mjs`) never picks them up during a normal suite run — several of them
// hang or wedge by design — while an explicit argv path still runs them.
//
// This module is NOT named `*.test.mjs`, so discover() ignores it too — same
// convention as helpers.mjs / procTree.mjs / hangGuardConfig.mjs. The cases live
// in the five tests/hang-guard-*.test.mjs files, which each import from here:
// one harness, five consumers, so the squeezed deadlines below cannot drift
// between them. That single-sourcing is also what makes a broken-guard
// measurement a one-line, one-place edit (see the FILE_KILL_MS comment in
// hangGuardConfig.mjs).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killDescendants } from './procTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER = path.join(__dirname, 'run.mjs');
export const fixture = name => path.join(__dirname, 'fixtures', 'hang', `${name}.fixture.mjs`);

// Squeezed deadlines shared by every case except where a test overrides one.
export const LEAK_GRACE = 1500;
export const FILE_KILL = 8000;   // deliberately >> LEAK_GRACE, so the two are separable
export const SWEEP = 1500;
// The holder lifetime in detached-orphan.fixture.mjs and
// silent-orphan.fixture.mjs, single-sourced here because each is only valid
// while the holder outlives something: detached-orphan needs it far above SWEEP,
// silent-orphan needs it above a whole healthy inner run. Both fixtures document
// their own inequality.
export const HOLDER_LIFETIME = 60_000;
// 12s, NOT 30s. The largest legitimate inner wait is FILE_KILL (8000), so 12s
// leaves headroom while bounding a run whose guard is BROKEN. Measured with a
// broken stall trigger at 30s: three cases fell back to the inner cap, the file
// reached 107.2s, the OUTER 90s per-file watchdog SIGKILLed it, and the report
// truncated to 9 of 12 cases — losing exactly the diagnostics naming which guard
// broke. The regression suite must not be silenceable by the regressions it
// catches.
export const FAST = {
  CC_TEST_LEAK_GRACE_MS: String(LEAK_GRACE),
  CC_TEST_FILE_KILL_MS: String(FILE_KILL),
  CC_TEST_ORPHAN_SWEEP_MS: String(SWEEP),
  CC_TEST_RUN_CAP_MS: '12000',
  CC_TEST_HOLDER_LIFETIME_MS: String(HOLDER_LIFETIME),
};

// The inner runner emits a full spec report, including `tests`/`pass`/`fail`
// count lines. Those must never reach OUR stdout: an external count-based parser
// reading this suite's output would fold the inner run's totals into the outer
// run's. This card exists to make the suite legible to exactly such a parser, so
// neutralise the count lines while keeping every diagnostic line intact.
export function redactTotals(out) {
  return out.replace(/^[^\S\n]*[ℹi][^\S\n]*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b.*$/gmu,
    '<inner-count-line redacted by hangGuardCase.mjs>');
}

// Runs the real runner against one fixture. Always awaits the child's exit, so
// this file never leaves a ChildProcess handle behind — Layer B is preloaded
// into this very file and would (correctly) fail it if we did.
// hardTimeoutMs is 20s, not 45s: it only fires when an inner runner never arms
// its own cap, and TWO such cases at 45s sum past the outer 90s per-file watchdog
// — which would SIGKILL this file and truncate exactly the diagnostics naming
// which guard broke. 20s keeps two comfortably under the deadline.
// `signalAfterMs` sends ONE signal to the nested runner that long after spawn —
// the only way to exercise its interrupt path, since an interrupt is by
// definition not something a fixture can do to itself. It targets `child.pid`
// alone, never a process group: the runner shares OUR group (spawn without
// `detached`), so a group signal would hit this test file too.
export function runGuard(name, env = FAST, { hardTimeoutMs = 20_000, stdoutPauseMs = 0, discardStdout = false, signalAfterMs = 0, signal = 'SIGTERM' } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // NODE_TEST_CONTEXT must not reach the child. node:test sets it in every
    // per-file test child, and a nested run() that sees it prints "run() is
    // being called recursively within a test file. skipping running files" and
    // silently runs NOTHING — the inner runner would report 0 tests and every
    // assertion below would fail for the wrong reason.
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [RUNNER, fixture(name)], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    // stderr is ALWAYS drained, so the guard's own diagnostics reach us even when
    // stdout is deliberately stalled below.
    child.stderr.on('data', d => { out += d; });
    const keep = d => { if (!discardStdout) out += d; };
    if (stdoutPauseMs > 0) {
      // Simulate a slow consumer (a pager, a slow disk) by reading nothing for
      // this long, so the runner's writes hit backpressure once the pipe fills.
      // We must still drain EVENTUALLY, or the child cannot close and we would be
      // testing our own deadlock instead of the guard.
      child.stdout.pause();
      setTimeout(() => { child.stdout.on('data', keep); child.stdout.resume(); },
        stdoutPauseMs).unref?.();
    } else {
      child.stdout.on('data', keep);
    }
    let signalTimer;
    if (signalAfterMs > 0) {
      signalTimer = setTimeout(() => {
        try { child.kill(signal); } catch { /* already gone */ }
      }, signalAfterMs);
    }
    // Backstop so a guard regression surfaces as a failed assertion here rather
    // than as a stalled test. killDescendants FIRST: several fixtures leak a
    // busy-looping or interval-holding process, and SIGKILLing only the nested
    // runner would leave it reparented to init spinning a core forever — this
    // card's own failure class, in this card's own test.
    const bail = setTimeout(() => {
      try { killDescendants(child.pid); } catch { /* best effort */ }
      child.kill('SIGKILL');
    }, hardTimeoutMs);
    // Clear on BOTH paths: a still-armed signal timer would hold this file's loop
    // open past its teardown and Layer B (preloaded here) would fail it as a leak.
    child.on('error', err => { clearTimeout(bail); clearTimeout(signalTimer); reject(err); });
    child.on('close', (code, sig) => {
      clearTimeout(bail);
      clearTimeout(signalTimer);
      resolve({ code, signal: sig, out: redactTotals(out), wallMs: Date.now() - startedAt });
    });
  });
}
