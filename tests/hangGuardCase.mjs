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
// `signalWhen` is a RENDEZVOUS, not a delay. Pass a RegExp and ONE signal is
// sent to the nested runner the moment the captured stream first matches it —
// synchronously, in the same tick as the observation, once only. Signalling is
// the only way to exercise the runner's interrupt path, since an interrupt is by
// definition not something a fixture can do to itself; making the signal
// CAUSED BY the fixture's own marker is what keeps that from being an assertion
// across a machine-speed window (card 2026-0228). The fixed `signalAfterMs:
// 1200` this replaced required the whole nested boot chain to fit in 1200 ms:
// measured spawn→marker 759-1585 ms at 72-way starvation vs 87-115 ms idle, so
// the sweep file went red 5-6/14 runs / 6-8/28 interrupt legs there (two
// independent campaigns) and never once quiet.
// There is deliberately NO fallback timer. "Wait N ms, then signal anyway" is
// `signalAfterMs` under a new name, and the run is already bounded three times
// over — the fixture's own dwell, then CC_TEST_RUN_CAP_MS, then hardTimeoutMs
// below — so a fourth bound would be a second source of truth. A marker that
// never arrives is a fast, loud red (measured 5.0-5.8 s per leg at 72-way),
// not a hang.
// It targets `child.pid` alone, never a process group: the runner shares OUR
// group (spawn without `detached`), so a group signal would hit this test file
// too.
export function runGuard(name, env = FAST, { hardTimeoutMs = 20_000, stdoutPauseMs = 0, discardStdout = false, signalWhen = null, signal = 'SIGTERM' } = {}) {
  // The rendezvous reads the SAME accumulator the case asserts on, so with
  // stdout discarded it could never match and the signal would silently never be
  // sent — a green-looking case that exercised no interrupt path at all.
  if (signalWhen && discardStdout) throw new Error(
    'runGuard: signalWhen rendezvouses on the captured stream, which discardStdout throws away — ' +
    'the signal would silently never be sent');
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
    let signalled = false;
    // Fires at most once. The kill is issued synchronously inside the observing
    // `data` handler, which TIGHTENS the R1 residual documented in
    // docs/architecture.md (the outer loop must not stall between the pipe
    // becoming readable and the signal) — but it is a description of the code,
    // NOT a correctness requirement: deferring the kill (e.g. via setImmediate)
    // changes no outcome, since a late signal either still lands inside the
    // fixture's dwell or the leg goes loud red down the healthy-end path.
    // Mutation-verified as such, so do not add an assertion pinning it.
    //
    // The once-only `signalled` latch IS load-bearing and IS pinned by the two
    // interrupt legs. The pattern is matched against the accumulated `out`, so
    // without the latch every subsequent chunk would re-signal.
    const rendezvous = () => {
      if (signalled || !signalWhen || !signalWhen.test(out)) return;
      signalled = true;
      try { child.kill(signal); } catch { /* already gone */ }
    };
    // stderr is ALWAYS drained, so the guard's console.error diagnostics reach us
    // even when stdout is deliberately stalled below. Its console.log ones do NOT
    // arrive until the pause releases — see the routing rule below.
    //
    // `discardStdout`'s only caller is the slow-consumer case in
    // tests/hang-guard-run-cap.test.mjs, whose assertions therefore read a
    // stderr-only accumulator; that observability is PINNED there by `the
    // discarded-stdout shape carries stderr diagnostics and drops stdout ones`,
    // which runs the same discarding shape against detached-orphan and asserts
    // both patterns arrive while the console.log verdict line does not.
    // "Capture stdout instead of discarding it" was measured and REFUSED: with
    // the 4000ms pause in place and no discard, the accumulator is still empty,
    // because a failing run's `close` fires at ~1.8s and the parent never
    // resumes to read anything. Dropping the discard hides the dependency
    // instead of removing it.
    //
    // The rendezvous is called from BOTH handlers, and only the stdout one is
    // exercised today: a fixture's own `writeSync(2, …)` reaches us on the
    // runner's STDOUT, because node:test relays it as a `test:stderr` event and
    // run.mjs's spec reporter pipes to process.stdout (measured 5/5 with
    // silent-orphan). So this call is currently unexercised — deleting it leaves
    // the suite green — and it is NOT dead code.
    //
    // THE WRITER CALL DECIDES THE HANDLER, and `hang-guard:` output is split
    // across both. run.mjs's console.error diagnostics reach the handler here:
    // the SIGINT/SIGTERM banners, `SWEPT` under every trigger, `STREAM STALLED`,
    // `NO REPORT`. Its console.log diagnostics reach the stdout handler instead,
    // including the verdict line (grep run.mjs for `files reported,`), the /proc
    // WARNING (`WARNING — /proc was unavailable`) and `slowest files (limit`. So
    // a case rendezvousing on a console.error diagnostic needs THIS call and
    // nothing else — which is why it stays — while one waiting on the verdict
    // line must hook stdout. Check which writer emits your pattern rather than
    // assuming a stream; guessing stderr is how card 2026-0228's silent
    // no-signal failed in the first place.
    child.stderr.on('data', d => { out += d; rendezvous(); });
    const keep = d => { if (!discardStdout) out += d; rendezvous(); };
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
    // Backstop so a guard regression surfaces as a failed assertion here rather
    // than as a stalled test. killDescendants FIRST: several fixtures leak a
    // busy-looping or interval-holding process, and SIGKILLing only the nested
    // runner would leave it reparented to init spinning a core forever — this
    // card's own failure class, in this card's own test.
    const bail = setTimeout(() => {
      try { killDescendants(child.pid); } catch { /* best effort */ }
      child.kill('SIGKILL');
    }, hardTimeoutMs);
    // Clear on BOTH paths: a still-armed bail would hold this file's loop open
    // past its teardown and Layer B (preloaded here) would fail it as a leak.
    // `bail` is the only timer here that needs clearing, and the INTERRUPT PATH
    // arms none at all (which is what the rendezvous bought over the delay it
    // replaced). The one other timer in this function is the `stdoutPauseMs`
    // pause-release above — armed only in that configuration, and `.unref()`d, so
    // it can never be what holds the loop open.
    child.on('error', err => { clearTimeout(bail); reject(err); });
    child.on('close', (code, sig) => {
      clearTimeout(bail);
      resolve({ code, signal: sig, out: redactTotals(out), wallMs: Date.now() - startedAt });
    });
  });
}
