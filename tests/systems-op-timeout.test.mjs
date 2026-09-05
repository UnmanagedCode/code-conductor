// THE CEILING, AT THE SURFACES THAT PAY IT.
//
// The provider here completes the handshake and then answers nothing: it
// accepts every operation and never terminates one. That is a provider DEFECT,
// not a supported condition — nothing in ProviderConnection's supervision fires
// on it, because it has not died, has not broken the framing, and answered the
// hello. So the only thing that settles an operation against it is
// DEFAULT_OP_TIMEOUT_MS, and every surface cc has that issues an untimed `exec`
// waits that ceiling out: a session lookup once, the project list three times
// in sequence.
//
// What these pin is one bound and one failure mode. cc does not model,
// classify, retry or recover from such a provider — see
// docs/systems-protocol.md, "Non-conformance is a provider defect".
//
// ORCH_OP_TIMEOUT_MS IS THE SEAM, and it has to be set before
// providerSystem.ts is evaluated: DEFAULT_OP_TIMEOUT_MS reads it once at module
// load, and the registry constructs its handles with no injection point — so
// this env var is the only way to reach a REGISTRY-built handle's bound at a
// surface without waiting 60 s for it. `node --test` gives each file its own
// process, so it cannot leak into a sibling (notably
// tests/systems-provider-supervision.test.mjs, which pins the unoverridden
// 60_000).
//
// EVERY MODULE THAT COULD READ IT IS IMPORTED DYNAMICALLY, for the reason
// tests/run.mjs:49 already records: static imports hoist above statements, so
// an assignment written above them runs too late. Measured here first —
// with the assignment on line 1 and static imports, the fence still fired at
// 60000ms.
process.env.ORCH_OP_TIMEOUT_MS = '1000';
const CEILING_MS = 1_000;

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const { bootServer, api, freshProjectsRoot, rmrf } = await import('./helpers.mjs');
const { bindRemoteSystem, seedRepo, git, wedgeLaunch, timedOutCode1Launch } = await import('./remoteSystem.mjs');
const { ProviderSystem, EXEC_TIMEOUT_SLACK_MS } = await import('../src/systems/providerSystem.ts');
const { createWorktree, listWorktrees, runGit } = await import('../src/worktrees.ts');
const { adoptProject, findSessionLocation } = await import('../src/projects.ts');
const { updateSystem } = await import('../src/appSettings.ts');
const { disposeSystemHandles, isSystemRefusal } = await import('../src/systems/registry.ts');

// A handle straight onto the non-answering provider, with no server and no
// registry — the two handle-level tests need the fixture, not a project.
function wedgeHandle(opts = {}) {
  return new ProviderSystem({ id: 'wbox', launch: { argv: wedgeLaunch() }, ...opts });
}

// ── T2: the wiring, and that the override is read ────────────────────

// PINS TWO CLAIMS AT ONCE, and neither is the value:
//   1. `?? DEFAULT_OP_TIMEOUT_MS` is what an options object with no
//      `defaultOpTimeoutMs` actually falls back to — the handle is built with
//      none, so any other fallback changes the number in the message.
//   2. DEFAULT_OP_TIMEOUT_MS reads ORCH_OP_TIMEOUT_MS. Delete the env read and
//      the fallback becomes 60_000: the message names the wrong number AND the
//      assertion below on elapsed time blows.
//
// `stat` is used rather than `readFile` because it is a DERIVED operation — an
// exec cc issues with no caller deadline at all, which is the shape `runGit`
// and every §7 derivation have.
test('an unconfigured handle falls back to DEFAULT_OP_TIMEOUT_MS, which reads ORCH_OP_TIMEOUT_MS', async () => {
  const sys = wedgeHandle();
  try {
    const started = Date.now();
    await assert.rejects(() => sys.stat('/x'), (e) => {
      assert.equal(e.code, 'ETIMEDOUT', e.message);
      assert.match(e.message, new RegExp(`${CEILING_MS}ms`), e.message);
      return true;
    });
    assert.ok(Date.now() - started < CEILING_MS * 4,
      `the injected ceiling is the one that fired, not the 60s default (took ${Date.now() - started}ms)`);
  } finally { sys.dispose(); }
});

// ── The abandon bound, and the number it names ───────────────────────

// PINS card 2026-0318 §5.3: when the PROVIDER never reports a command's exit,
// what settles the command is cc's own abandon timer at
// `timeoutMs + EXEC_TIMEOUT_SLACK_MS` — and that is the number the worker is
// told, together with WHOSE silence caused it.
//
// The card's own defect was a message naming the wrong number: it named the
// per-command ceiling, which is the deadline the PROVIDER was given, while the
// wait the worker actually served was that ceiling plus the slack. Both halves
// below are asserted at a NON-DEFAULT bound, and at two DIFFERENT ones, so
// neither a hardcoded constant nor a copy of the other's value can pass.
//
// This is also the row that keeps the backstop: a command that produces no
// sentinel at all — this provider sends nothing — is a DIFFERENT failure mode
// from a backgrounded job, and the sentinel-settle does not cover it.
//
// The two probes run CONCURRENTLY on one handle (multiplexed ids, independent
// timers), so the test costs one slack, not two.
test('a command the provider never answers is abandoned at timeoutMs + the slack, and says so', async () => {
  assert.equal(typeof EXEC_TIMEOUT_SLACK_MS, 'number',
    'the slack is EXPORTED so this test can COMPUTE the bound instead of restating it');
  const RAW_MS = 100;
  const SHELL_MS = 250;
  const sys = wedgeHandle();
  const started = Date.now();
  try {
    const [raw] = await Promise.all([
      sys.exec({ shell: 'echo hi' }, { cwd: '/tmp', timeoutMs: RAW_MS }),
      assert.rejects(() => sys.shell({ cwd: '/tmp', commandTimeoutMs: SHELL_MS }).run('echo hi'), (e) => {
        assert.equal(e.code, 'ETIMEDOUT', e.message);
        assert.match(e.message, new RegExp(`\\b${SHELL_MS + EXEC_TIMEOUT_SLACK_MS}ms\\b`),
          `the message names the wait the worker actually served: ${e.message}`);
        assert.doesNotMatch(e.message, new RegExp(`\\b${SHELL_MS}ms\\b`),
          `and NOT the deadline the provider was given: ${e.message}`);
        assert.match(e.message, /never reported/, `and says whose silence caused it: ${e.message}`);
        return true;
      }),
    ]);
    assert.equal(raw.timedOut, true);
    assert.equal(raw.abandonedAfterMs, RAW_MS + EXEC_TIMEOUT_SLACK_MS,
      'the result carries the abandoning timer\'s OWN computed value');
    assert.ok(Date.now() - started < (SHELL_MS + EXEC_TIMEOUT_SLACK_MS) * 3,
      `both bounds fired rather than being waited out (took ${Date.now() - started}ms)`);
  } finally { sys.dispose(); }
});

// PINS the other side of the same field: a command the provider DID answer —
// with its own timeout — carries no `abandonedAfterMs`, so the presence of the
// field is what distinguishes cc's silence-bound from a provider-reported one,
// and the message keeps naming the provider's deadline.
test('a timeout the provider REPORTS carries no abandon value, and names the provider\'s own deadline', async () => {
  const sys = new ProviderSystem({ id: 'wbox3', launch: { argv: timedOutCode1Launch() } });
  try {
    const r = await sys.exec({ shell: 'echo hi' }, { cwd: '/tmp', timeoutMs: 30_000 });
    assert.equal(r.timedOut, true, 'the far side answered, with timedOut set');
    assert.equal(r.abandonedAfterMs, undefined, 'cc abandoned nothing — the provider reported');
    await assert.rejects(() => sys.shell({ cwd: '/tmp', commandTimeoutMs: 30_000 }).run('echo hi'), (e) => {
      assert.equal(e.code, 'ETIMEDOUT', e.message);
      assert.match(e.message, /still running after 30000ms/, e.message);
      assert.match(e.message, /per-command ceiling/, e.message);
      return true;
    });
  } finally { sys.dispose(); }
});

// ── T3: runGit's failure mode ────────────────────────────────────────

// PINS: a git command whose answer never arrived leaves `runGit` as a THROWN
// system refusal, not as `{code:124, stdout:''}`. Without the throw, every
// `code !== 0` guard reads the timeout as git's own answer — which is how
// `isGitRepo` produced a false `false` (T4 is that half at the surface).
//
// The tag is asserted separately from the code: `systemRefusal: true` is what
// the six converters key on, so dropping it would leave the throw correct and
// every conversion broken.
test('runGit throws a tagged system refusal when git never answers', async () => {
  const sys = wedgeHandle({ defaultOpTimeoutMs: 300 });
  try {
    await assert.rejects(() => runGit(sys, '/tmp', ['rev-parse', '--git-dir']), (e) => {
      assert.equal(e.code, 'GIT_TIMED_OUT', e.message);
      assert.equal(e.statusCode, 504, e.message);
      assert.equal(isSystemRefusal(e), true, 'the converters key on the tag, not the code');
      assert.match(e.message, /system 'wbox'/, e.message);
      return true;
    });
  } finally { sys.dispose(); }
});

// PINS: a timeout the PROVIDER reports becomes a `runGit` refusal too — the
// second producer path into the same guard, and the only one T3 does not cover.
// T3 starts from cc's own abandon timer; this starts from an `exit` frame the
// far side sent with `timedOut` set, and runs it through `#exec` → the
// collector → `runGit`. No other single test asserts that composite:
// systems-protocol-conformance and systems-provider-parity both stop at the
// ExecResult (`r.timedOut`, `r.code`) and neither calls `runGit`.
//
// AND IT ADDS NO MUTATION-DETECTABLE COVERAGE, which is the more important half
// of this header. `ExecOutputCollector.result` returns
// `code: timedOut ? 124 : …` (src/systems/execCollector.ts), and BOTH
// implementations of `exec` route through that collector — so the flag and the
// code are FUSED one layer BELOW this guard, and `{timedOut:true, code≠124}`
// can never reach it. Measured: against this fixture, which sends `code:1`,
// `sys.exec` resolves `{code:124, timedOut:true}`.
//
// So `if (r.timedOut)` and `if (r.code === 124)` are extensionally identical at
// `runGit`, and this test CANNOT tell them apart — do not read it as
// load-bearing for that distinction. The pairing is cc's own contract, enforced
// by the collector, not a coincidence of what the reference provider,
// ProviderSystem's abandon timer and groupedCommand happen to emit. The
// mutation prover confirmed the code-keyed mutant survives the whole suite; it
// is waived as equivalent, not uncovered.
test('a timeout the provider reports becomes a runGit refusal, not just cc\'s own', async () => {
  const sys = new ProviderSystem({ id: 'wbox2', launch: { argv: timedOutCode1Launch() } });
  try {
    await assert.rejects(() => runGit(sys, '/tmp', ['rev-parse', '--git-dir']), (e) => {
      assert.equal(e.code, 'GIT_TIMED_OUT', e.message);
      assert.equal(isSystemRefusal(e), true, 'the converters key on the tag');
      return true;
    });
  } finally { sys.dispose(); }
});

// ── T4–T6: the surfaces ──────────────────────────────────────────────

describe('a provider that accepts every operation and answers none', () => {
  let ctx, baseUrl, home, remote, tree, wt;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    // Adopted and worktree'd on a HEALTHY provider, so every fixture below is
    // real: the registration exists, the tree exists, git knows about both.
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    await git(tree, 'add', '-A');
    await git(tree, 'commit', '-q', '-m', 'conventions');
    wt = await createWorktree('app', { name: 'feature' });
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // Swap the healthy row for the non-answering provider. updateSystem disposes
  // the live handle, so the next operation really gets the new process — and
  // the swap itself is cheap, because registration is bounded by the HANDSHAKE
  // (10 s, ProviderConnection) and this provider answers that.
  const goMute = () => updateSystem(remote.id, { launch: wedgeLaunch() });

  // PINS THE WHOLE FAILURE-MODE CONTRACT AT A SURFACE, in three parts:
  //   - `isGitRepo` is ABSENT, not `false`. Before runGit threw, the row read
  //     `isGitRepo: false` with `systemUnreachable: null` — cc asserting a box
  //     is reachable and is not a git repository, having never got an answer
  //     from it. That is the falsehood routes.ts's own comment forbids.
  //   - `systemUnreachable` names the system, so the absence is never ambiguous.
  //   - the worktree REGISTRATIONS still list: they are store-derived, and a
  //     project whose worktrees vanish is indistinguishable from one with none.
  test('the project row reports git facts as ABSENT, names the system, and still lists worktrees', async () => {
    await goMute();
    const { status, body } = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(status, 200);
    const row = body.find(p => p.name === 'app');
    assert.ok(row, JSON.stringify(body));
    assert.equal(row.isGitRepo, undefined, JSON.stringify(row));
    assert.equal('isGitRepo' in row, false, 'absent from the response, not present-and-false');
    assert.match(String(row.systemUnreachable), new RegExp(remote.id), JSON.stringify(row));
    assert.equal(row.worktrees.length, 1, JSON.stringify(row.worktrees));
    assert.equal(row.worktrees[0].worktreeName, wt.worktreeName);
  });

  // PINS: on this card's own two surfaces the refusal DEGRADES and never
  // propagates — `listWorktrees` applies no git filter, and the lookup answers
  // `null` for a session it cannot place rather than failing the caller. These
  // are the two swallow sites; the row above is the one that discloses.
  test('the worktree listing and the session lookup swallow it rather than failing', async () => {
    await goMute();
    const got = await listWorktrees('app');
    assert.deepEqual(got.map(w => w.worktreeName), [wt.worktreeName]);
    assert.equal(await findSessionLocation(randomUUID()), null);
  });

  // PINS card 2026-0299 §6's ruling: a timed-out walk answers EXACTLY as a walk
  // against a box that is down does. This card introduces a new route to the
  // unfiltered listing (`isSystemRefusal` → no filter, replacing `isGitRepo` →
  // a false `false`), and both arms run on ONE fixture so a future editor
  // cannot make the timeout arm prune, refuse, or answer differently.
  //
  // The fixture is a registration git has genuinely forgotten: the directory is
  // removed behind cc's back and really pruned, which is the one case where the
  // git filter changes the answer.
  test('a timed-out walk lists exactly what a down box lists', async () => {
    await rmrf(wt.worktreePath);
    await git(tree, 'worktree', 'prune');

    const healthy = await listWorktrees('app');
    assert.deepEqual(healthy.map(w => w.worktreeName), [],
      'a healthy box PRUNES a registration git no longer reports');

    await goMute();
    const muted = await listWorktrees('app');
    assert.deepEqual(muted.map(w => w.worktreeName), [wt.worktreeName],
      'a box that never answers SURFACES it — the same answer a DOWN box gives');
  });
});
