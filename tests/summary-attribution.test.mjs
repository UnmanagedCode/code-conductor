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

  // (1) ORDER-INDEPENDENCE. fast finishes ~35ms in but is listed after slow, so
  // its summary is held for ~1.2s. Measured: ~1240ms unfixed, 33-38ms fixed.
  assert.ok(fast < 400,
    `fast.fixture.mjs does ~35ms of work but was reported as ${fast}ms — its figure is ` +
    `inheriting the wall of an earlier-listed file that was still running:\n${diag}`);

  // (2) THE FIGURE TRACKS EACH FILE'S OWN WALL. Two-sided on purpose: medium's real
  // wall is neither extreme, so neither inflation (unfixed: ~1200ms) nor a collapse
  // to a small constant satisfies it. Measured 633-635ms fixed.
  assert.ok(medium >= 450 && medium <= 900,
    `medium.fixture.mjs does ~600ms of work but was reported as ${medium}ms — the figure ` +
    `does not track this file's own wall:\n${diag}`);

  // (3) THE RANKING ORDERS BY WALL ACTUALLY SPENT. This is what the line exists to
  // publish, and it is asserted with a MARGIN rather than by position alone:
  // unfixed, every figure collapses to within ~1ms, so which name sorts first is a
  // coin flip (measured: the correct one won 4 of 5 runs). A bare position check
  // would therefore pass against the broken reporter most of the time. The margin
  // is ~33x once fixed, and position follows from the reporter's own sort.
  assert.ok(slow >= 2 * fast,
    `slow.fixture.mjs (${slow}ms) should dominate fast.fixture.mjs (${fast}ms) by a wide ` +
    `margin; a near-tie means every file is being charged the same held wall:\n${diag}`);
  assert.equal(ranking[0].name, 'slow.fixture.mjs',
    `the file that actually spent the wall must rank first:\n${diag}`);
});
