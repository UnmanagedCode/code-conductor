// Regression guard for the per-file duration figure in the `hang-guard:` verdict
// line (card 2026-0206).
//
// THE BUG. run.mjs used to compute each file's duration at `test:summary` time.
// Per-file summaries are emitted in `files` order, so a file that finishes ahead of
// an earlier-listed one has its summary HELD until that one reports — and then gets
// charged the earlier file's wall. The slowest-5 line, which is the standing
// evidence that FILE_KILL_MS's margin is real, therefore reported a flat plateau of
// near-identical figures instead of naming the file that actually spent the time.
// The fix reads `test:complete` (order-independent) instead.
//
// Like tests/hang-guard.test.mjs, this spawns the REAL tests/run.mjs against
// fixtures and reads its output. Nothing here re-implements the reporting rule: the
// shipped reporter is the thing under test, and a second copy of the rule here
// could agree with itself while the shipped one was broken.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killDescendants } from './procTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run.mjs');
const fixture = name => path.join(__dirname, 'fixtures', 'attribution', `${name}.fixture.mjs`);

// Runs the real runner against the three fixtures and returns its `hang-guard:`
// lines plus the parsed slowest-files ranking.
//
// ARGV ORDER IS LOAD-BEARING: slow FIRST. discover() preserves argv order, and the
// bug only fires for a file listed after one that is still running. Reverse these
// and the unfixed reporter looks correct.
//
// CONCURRENCY 2, not the suite default: slow and fast must hold the two slots
// together (so fast finishes inside slow's window), and medium must then be
// dispatched into the slot fast vacates.
async function runFixtures() {
  const { code, out } = await new Promise((resolve, reject) => {
    // NODE_TEST_CONTEXT must not reach the child. node:test sets it in every
    // per-file test child, and a nested run() that sees it prints "run() is being
    // called recursively within a test file. skipping running files" and silently
    // runs NOTHING — the inner runner would report 0 files and every assertion
    // below would fail for the wrong reason.
    const childEnv = {
      ...process.env,
      TEST_CONCURRENCY: '2',
      // The fixtures cannot hang, so this only bounds a genuine regression in the
      // runner itself — and it keeps that case well inside the OUTER 90s per-file
      // watchdog, which would otherwise SIGKILL this file and truncate the
      // diagnostics naming what broke.
      CC_TEST_RUN_CAP_MS: '30000',
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [RUNNER, fixture('slow'), fixture('fast'), fixture('medium')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    child.stderr.on('data', d => { buf += d; });
    // Backstop so a runner regression surfaces as a failed assertion here rather
    // than as a stalled test. killDescendants FIRST — SIGKILLing only the nested
    // runner would leave its fixture children reparented to init.
    const bail = setTimeout(() => {
      try { killDescendants(child.pid); } catch { /* best effort */ }
      child.kill('SIGKILL');
    }, 30_000);
    child.on('error', err => { clearTimeout(bail); reject(err); });
    // Always awaits the child's exit, so this file never leaves a ChildProcess
    // handle behind — Layer B (tests/handleLeakGuard.mjs) is preloaded into this
    // very file and would correctly fail it if we did.
    child.on('close', c => { clearTimeout(bail); resolve({ code: c, out: buf }); });
  });

  // Quote ONLY `hang-guard:` lines in assertion messages. The inner runner emits a
  // full spec report including `ℹ tests/pass/fail` count lines, and this suite is
  // read by count-based parsers — folding the inner run's totals into ours is the
  // exact hazard tests/hang-guard.test.mjs's redactTotals exists for. Selecting
  // the diagnostic lines we want is cheaper than redacting the ones we don't.
  const guardLines = out.split('\n').filter(l => /^hang-guard:/.test(l));
  const diag = guardLines.join('\n') || '(no hang-guard: lines in output)';

  const line = guardLines.find(l => l.startsWith('hang-guard: slowest files'));
  assert.ok(line, `no slowest-files line was printed:\n${diag}`);
  // e.g. "hang-guard: slowest files (limit 90000ms): slow.fixture.mjs 1237ms, ..."
  const ranking = [...line.matchAll(/([\w.-]+\.fixture\.mjs) (\d+)ms/g)]
    .map(([, name, ms]) => ({ name, ms: Number(ms) }));
  assert.equal(ranking.length, 3, `expected all three fixtures in the ranking:\n${diag}`);

  const of = name => {
    const hit = ranking.find(r => r.name === `${name}.fixture.mjs`);
    assert.ok(hit, `${name}.fixture.mjs missing from the ranking:\n${diag}`);
    return hit.ms;
  };
  return { code, diag, ranking, of };
}

test('the verdict line charges each file its OWN wall, not an earlier-listed file\'s', async () => {
  const { code, diag, ranking, of } = await runFixtures();
  assert.equal(code, 0, `the fixture run should be green:\n${diag}`);

  const slow = of('slow'), medium = of('medium'), fast = of('fast');

  // EVERY ASSERTION BELOW IS A RATIO OR AN ORDERING, NOT AN ABSOLUTE ms BOUND, AND
  // THAT IS DELIBERATE — do not "tighten" one back into an absolute. Load adds a
  // roughly COMMON spawn+import cost to all three figures, so absolutes drift with
  // it while ratios hold. Measured quiet: slow 1237 / medium 635 / fast 37. Measured
  // under 16-spinner starvation (load 22-29, ~2.3x): 1398 / 972 / 142 — an earlier
  // revision of this test asserted `medium <= 900` and went red on that 972.
  // Unfixed, every figure collapses onto the held wall: ~1237 / ~1199 / ~1237.

  // (1) A TRIVIAL FILE IS NOT CHARGED A WORKING FILE'S WALL. The primary
  // bug-catcher: unfixed, fast is charged the ~1.2s it spent WAITING for slow's
  // summary, so this fails by ~3x at any load. Fixed margin is ~17x quiet, ~7x
  // starved.
  assert.ok(fast * 3 < medium,
    `fast.fixture.mjs (~35ms of work, reported ${fast}ms) should be far cheaper than ` +
    `medium.fixture.mjs (~600ms of work, reported ${medium}ms); a near-tie means fast is ` +
    `inheriting the wall of an earlier-listed file that was still running:\n${diag}`);

  // (2) THE FIGURE RESOLVES TWO FILES THAT BOTH DID REAL BUT DIFFERENT WORK. This is
  // precisely what the old plateau hid — four trivial files reading within ~600ms of
  // the one real culprit. Holds until the common spawn cost reaches ~1.8s (observed
  // ~370ms at 2.3x slowdown, so ~4.8x headroom).
  assert.ok(medium * 1.25 < slow,
    `medium.fixture.mjs (~600ms of work, reported ${medium}ms) should be clearly cheaper ` +
    `than slow.fixture.mjs (~1200ms, reported ${slow}ms); the figure is not resolving ` +
    `their real walls:\n${diag}`);

  // (3) THE PUBLISHED RANKING IS THE TRUE ORDER. Asserted as the WHOLE sequence, not
  // "slow is first": unfixed, medium is always LAST (its dequeue is the latest, so it
  // is charged the least of the held wall) while slow and fast tie to within ~1ms and
  // trade first place at random — measured, the correct file won first place in 4 of 5
  // runs, so a first-place-only check would pass against the broken reporter most of
  // the time. The full sequence never matches unfixed, and always matches fixed.
  assert.deepEqual(ranking.map(r => r.name),
    ['slow.fixture.mjs', 'medium.fixture.mjs', 'fast.fixture.mjs'],
    `the ranking must order files by the wall they actually spent:\n${diag}`);

  // (4) Control, not a discriminator — it also passes against the unfixed reporter.
  // slow.fixture.mjs sleeps 1200ms, so dispatch→child-done can never be below that
  // at any load. Kills a mutant that collapses the figure to a small constant.
  assert.ok(slow >= 1200,
    `slow.fixture.mjs sleeps 1200ms, so it cannot legitimately report ${slow}ms:\n${diag}`);
});
