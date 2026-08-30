// THE SYSTEM THAT IS UP WHEN AN OPERATION STARTS AND DIES DURING IT.
//
// Every failure fixture before this one made the system unreachable BEFORE the
// call, which is the case that already worked: `resolveSystem` refuses at the
// door and every caller's entry guard catches it. The other half — a handshake
// that succeeds, real work that really happens, then the far side going away
// mid-operation — went entirely untested, and a whole class of defects lived
// there.
//
// THE ROOT CAUSE all of these share: `runGit` used to launder "the command
// never ran" into a git ANSWER, returning `code: 1` with the transport
// diagnostic in `stderr` — indistinguishable from git having run and said no.
// Every finding below was a caller reading that as a fact about a repository:
// an invented absence, a git-conflict code carrying a transport cause, and —
// worst — safety checks whose FAILURE read as PASS.
//
// A spawn error is not a git result, so `runGit` now throws a system refusal and
// the structured vocabularies convert it. These pin the conversions.
//
// The fixture is `tests/fixtures/flakyProvider.mjs`: the real reference provider
// behind a passthrough that really serves N operations and then really dies.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git, flakyLaunch } from './remoteSystem.mjs';
import { adoptProject, worktreeStoreDir } from '../src/projects.ts';
import {
  createWorktree, mergeWorktreeIntoParent, removeWorktree, syncWorktree, listWorktrees, runGit,
} from '../src/worktrees.ts';
import { updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { liveSystemProto } from './systemHandle.mjs';

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const r = (await res.json()).result;
  return { ...r, text: (r.content ?? []).map(c => c.text).join('\n') };
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

describe('a system that dies mid-operation', () => {
  let ctx, baseUrl, home, remote, tree, wt;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    // Adopt materialises CONVENTIONS.md / CLAUDE.md into the tree; commit them
    // so the parent is CLEAN and a merge reaches its later steps rather than
    // stopping at the dirty-parent guard.
    await git(tree, 'add', '-A');
    await git(tree, 'commit', '-q', '-m', 'conventions');
    wt = await createWorktree('app', { name: 'feature' });
    // A commit on the worktree branch, so a merge has something to do.
    await fs.writeFile(path.join(wt.worktreePath, 'app.txt'), 'v2\n');
    await git(wt.worktreePath, 'add', '-A');
    await git(wt.worktreePath, 'commit', '-q', '-m', 'v2');
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // Swap the healthy system for one that dies. updateSystem disposes the live
  // handle, so the next operation gets the flaky process — the system really was
  // up for everything above and really is dying from here on.
  const goFlaky = (cfg) => updateSystem(remote.id, { launch: flakyLaunch(cfg) });

  // Every git call fails from here, but the HANDSHAKE still succeeds, so
  // resolution passes the door and the death happens inside the operation.
  const dieOnEveryGitCall = () => goFlaky({ budget: 0 });

  // A LIVE system on which exactly one command — `git status --porcelain` in
  // `at` — answers non-zero. This is the other half of the class: git RAN and
  // failed, so nothing throws and the guard has to notice by itself. Wrapped on
  // the live handle's own prototype (tests/systemHandle.mjs) so it holds in
  // whichever System implementation the run is using.
  async function withFailingStatus(at, body) {
    const sys = await systemById(remote.id, 'test');
    const proto = liveSystemProto(sys);
    const orig = proto.exec;
    proto.exec = async function (spec, opts) {
      const argv = spec?.argv ?? [];
      if (argv.includes('status') && argv.includes('--porcelain') && opts?.cwd === at) {
        return {
          code: 1, stdout: '', stderr: 'fatal: could not read status', output: '',
          timedOut: false, truncated: false, durationMs: 1, spawnError: null,
        };
      }
      return orig.call(this, spec, opts);
    };
    try { await body(); } finally { proto.exec = orig; }
  }

  // ── Fix 8: mid-merge ─────────────────────────────────────────────────

  // PINS: a merge whose first remote read dies refuses BY NAMING THE SYSTEM,
  // never by inventing the worktree's absence. `listWorktrees` returning []
  // made merge answer "worktree not found" for a worktree that is registered
  // and on disk — a conductor reading that recreates it.
  test('merge refuses by naming the system, never by inventing the worktree away', async () => {
    await dieOnEveryGitCall();
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'SYSTEM_UNREACHABLE', JSON.stringify(r));
    assert.match(r.reason, new RegExp(remote.id), 'the refusal identifies the system');
    assert.ok(!/not found/i.test(r.reason), `an absence must not be invented: ${r.reason}`);
  });

  // PINS: the same through the MCP tool a conductor drives — the invented
  // absence was what that surface actually printed.
  test('merge_worktree renders the named refusal rather than a not-found', async () => {
    await dieOnEveryGitCall();
    const r = await callTool(baseUrl, 'merge_worktree', { project: 'app', worktree: wt.worktreeName });
    assert.match(r.text, /SYSTEM_UNREACHABLE/, r.text);
    assert.ok(!/not found under project/.test(r.text), `invented absence: ${r.text}`);
  });

  // PINS: a death DURING `git merge` says the merge MAY HAVE COMPLETED. cc
  // cannot know — the command was really running when the transport dropped,
  // and it was verified live that the orphaned merge can finish afterwards, so
  // §6 R9's "git steps are individually atomic" is false for `git merge`. A
  // refusal that silently implies "nothing happened" is the same silent-wrong-
  // answer class this phase exists to kill (the D10 rule applied to a merge).
  test('a death inside git merge reports that the merge may have completed', async () => {
    await goFlaky({ dieOn: '--no-ff' });
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'SYSTEM_UNREACHABLE', JSON.stringify(r));
    assert.equal(r.mayHaveCompleted, true,
      'the caller must be told the merge may have landed on the system');
    assert.match(r.reason, new RegExp(remote.id));
  });

  // PINS: the uncertainty is ABSENT — not false — when the death happened
  // before the merge was ever issued, so its presence always means something.
  test('a death before the merge is issued carries no such uncertainty', async () => {
    await dieOnEveryGitCall();
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal('mayHaveCompleted' in r, false, JSON.stringify(r));
  });

  // PINS: a parent left MID-MERGE is reported as exactly that, with the repair.
  // It used to report PARENT_DIRTY ("commit or stash them"), which describes a
  // different state and prescribes a repair that does not apply.
  test('a parent left mid-merge is named, not called dirty', async () => {
    // The real leftover state: MERGE_HEAD set, index staged, nothing committed.
    await git(tree, 'merge', '--no-commit', '--no-ff', wt.branch).catch(() => {});
    assert.equal(await exists(path.join(tree, '.git', 'MERGE_HEAD')), true, 'fixture is really mid-merge');

    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'PARENT_MID_MERGE', JSON.stringify(r));
    assert.match(r.reason, /merge --abort|git commit/,
      'the refusal names a repair that applies to a half-finished merge');
  });

  // ── The POISONED TAIL: classification must not read the corpse ────────
  //
  // A transport failure's message deliberately embeds the dying provider's own
  // stderr tail, so the refusal can quote why it died. Classifying by substring
  // over that text then reads the CORPSE as the diagnosis: a provider that dies
  // of — or merely logs — an errno is misread as the far side answering "I
  // could not start that command", and the whole throw is skipped.
  //
  // This is the normal case, not a freak one: the reference provider's own
  // fatal() writes to stderr before exiting, and any uncaught Node exception
  // prints `Error: ENOENT: …`. So the two sources are separated at the
  // ExecResult seam instead, and the transport one throws whatever its text says.
  const POISON = 'Error: spawn git ENOENT (provider crash log)';

  // PINS: a transport death whose stderr contains an errno string still throws.
  // Classified as a local FS answer it came back as `code: 1` — git having run
  // and said no — and surfaced as a claim about the TREE ("unable to resolve
  // HEAD"), naming no repair for a system that is gone.
  test('a transport death with an errno in its stderr still refuses by system', async () => {
    await goFlaky({ budget: 0, dieStderr: POISON });
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'SYSTEM_UNREACHABLE', JSON.stringify(r));
    assert.match(r.reason, new RegExp(remote.id));
    assert.ok(!/unable to resolve HEAD/.test(r.reason),
      `the provider's dying stderr must not be read as a fact about the tree: ${r.reason}`);
  });

  // PINS: the same death with a CLEAN tail behaves identically — the pair is
  // what shows the classification no longer depends on the corpse's text.
  test('the same death with a clean stderr refuses identically', async () => {
    await goFlaky({ budget: 0 });
    const clean = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(clean.code, 'SYSTEM_UNREACHABLE', JSON.stringify(clean));
  });

  // PINS: it does not decay on the SECOND call. Once the tail is captured the
  // backoff refusal embeds it too, so a misclassification would spread from one
  // git call to every later one in the same operation — the guards would go
  // back to seeing `code: 1` answers instead of throws.
  test('a poisoned tail does not leak into the backoff refusal either', async () => {
    await goFlaky({ budget: 0, dieStderr: POISON });
    await mergeWorktreeIntoParent('app', wt.worktreeName);
    const second = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(second.code, 'SYSTEM_UNREACHABLE', JSON.stringify(second));
    await assert.rejects(
      () => removeWorktree('app', wt.worktreeName),
      (e) => new RegExp(remote.id).test(e.message),
      'and a guard on a later call still sees a throw, not an answer',
    );
    assert.equal(await exists(wt.worktreePath), true, 'so the worktree is not deleted');
  });

  // PINS: a COMMAND-level failure keeps FS classification — a cwd that really
  // does not exist on the system is a real, local, actionable answer about that
  // command, and calling it unreachability would point at the wrong machine.
  // This is the half of the discriminator that must NOT change.
  test('a command that could not start on a live system is still a git answer', async () => {
    const gone = path.join(remote.root, 'never-existed');
    const r = await runGit(await systemById(remote.id, 'test'), gone, ['status', '--porcelain']);
    assert.equal(r.code, 1, 'a live system answering "I could not start that" is not a refusal');
    assert.match(r.stderr, /ENOENT/);
  });

  // ── Fix 9: a failed check must read as UNKNOWN, never as PASSED ───────

  // PINS: `git worktree remove --force` never runs on a worktree whose
  // dirtiness could not be measured. `if (dirty.ok && lines.length)` read a
  // FAILED check as clean and deleted the tree.
  test('removeWorktree refuses when the dirty check could not run', async () => {
    await dieOnEveryGitCall();
    await assert.rejects(
      () => removeWorktree('app', wt.worktreeName),
      (e) => new RegExp(remote.id).test(e.message),
      'the refusal names the system',
    );
    assert.equal(await exists(wt.worktreePath), true, 'the worktree was not deleted');
    assert.equal(await exists(worktreeStoreDir('app', wt.worktreeName)), true,
      'and it is still registered');
  });

  // PINS: the same guard on the MCP surface, which has its own precheck.
  test('delete_worktree refuses when the dirty check could not run', async () => {
    await dieOnEveryGitCall();
    const r = await callTool(baseUrl, 'delete_worktree', { project: 'app', worktree: wt.worktreeName });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, new RegExp(remote.id), r.text);
    assert.equal(await exists(wt.worktreePath), true, 'the worktree survives an unmeasurable check');
  });

  // PINS: force=true is still an override of a KNOWN-dirty tree, not a way to
  // paper over a check that never ran — but it must still work when the system
  // is healthy, or the escape hatch is gone.
  test('force still deletes a healthy worktree', async () => {
    const r = await removeWorktree('app', wt.worktreeName, { force: true });
    assert.equal(r.worktreeName, wt.worktreeName);
    assert.equal(await exists(worktreeStoreDir('app', wt.worktreeName)), false);
  });

  // PINS: merge's parent-dirty guard refuses on an unmeasurable status rather
  // than skipping itself. `if (dirty.code === 0 && …)` let a failed `git status`
  // fall straight through to the merge.
  test('merge refuses when the parent status could not be read', async () => {
    await dieOnEveryGitCall();
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, false);
    assert.ok(r.code !== 'PARENT_DIRTY', 'an unread status is not a clean one, nor a dirty one');
    assert.equal(r.code, 'SYSTEM_UNREACHABLE', JSON.stringify(r));
  });

  // PINS: merge's step-4 guard — the worktree's OWN tree — refuses on an
  // unmeasurable status like its three siblings. `wtDirty.ok && lines.length`
  // read a failed check as clean, so with the default allowDirty:false a merge
  // proceeded and silently did not land uncommitted work, which is the exact
  // thing step 4 exists to prevent.
  test('merge refuses when the WORKTREE status could not be read', async () => {
    // A GIT-level failure on a LIVE system, which is the case the transport
    // throw does not cover: `git status` answered non-zero (the output fence
    // firing on a huge status is the realistic trigger) while everything else
    // works. The double is scoped to that one argv so every earlier step still
    // really runs — otherwise this would pass on an earlier guard.
    await withFailingStatus(wt.worktreePath, async () => {
      const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, 'WORKTREE_STATUS_UNKNOWN', JSON.stringify(r));
    });
  });

  // PINS: the same guard still MERGES when the status reads clean — the refusal
  // is about the check failing, not about the guard being unconditional.
  test('merge still proceeds when the worktree status reads clean', async () => {
    const r = await mergeWorktreeIntoParent('app', wt.worktreeName);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  // PINS: the read surface obeys the same rule — a `git status` that did not
  // answer must not render as "nothing is dirty", which is a positive claim
  // about the tree.
  test('project_status does not render an unreadable tree as clean', async () => {
    await withFailingStatus(wt.worktreePath, async () => {
      const r = await callTool(baseUrl, 'project_status', {
        project: 'app', worktree: wt.worktreeName,
      });
      // project_status renders text, so the claim to refute is the heading a
      // clean tree prints — `DIRTY (0)` — not a JSON field.
      assert.ok(!/DIRTY \(0\)/.test(r.text),
        `a status that did not answer rendered as "nothing is dirty": ${r.text}`);
      assert.match(r.text, /DIRTY \(unknown/, r.text);
    });
  });

  // PINS: syncWorktree names the system instead of blaming the base branch. A
  // dead `rev-list` nulled ahead/behind, which reads as "base branch may have
  // been deleted or renamed" — a repair aimed at the wrong thing entirely.
  test('syncWorktree names the system, not a branch it never checked', async () => {
    await dieOnEveryGitCall();
    const r = await syncWorktree('app', wt.worktreeName);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, new RegExp(remote.id), JSON.stringify(r));
    assert.ok(!/deleted or renamed/.test(r.reason),
      `must not blame the base branch for a transport failure: ${r.reason}`);
  });

  // PINS: adoptProject does not assert TARGET_NOT_FOUND about a tree it never
  // got to ask about — a fact it has no basis for.
  test('adoptProject does not claim a target is missing when it could not look', async () => {
    const other = await seedRepo(path.join(remote.root, 'other'));
    await dieOnEveryGitCall();
    const r = await adoptProject('other', other, { system: remote.id });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.code !== 'TARGET_NOT_FOUND',
      `the target exists; cc simply could not look: ${JSON.stringify(r)}`);
    assert.match(r.reason, new RegExp(remote.id), JSON.stringify(r));
  });

  // ── Fix 10: registrations are store-derived and survive ───────────────

  // PINS: worktree REGISTRATIONS list without a System, which is the contract
  // the code comments beside them already state. `listWorktrees` gated on
  // `isGitRepo`, so a degraded row silently showed no worktrees at all.
  test('listWorktrees still lists registrations when git cannot answer', async () => {
    await dieOnEveryGitCall();
    const got = await listWorktrees('app');
    assert.deepEqual(got.map(w => w.worktreeName), [wt.worktreeName],
      'the registration is cc\'s own record and needs no system to read');
  });

  // PINS: the same through the listing the sidebar renders — and its git-
  // measured divergence goes UNKNOWN rather than being invented.
  test('GET /api/projects keeps the worktree on a degraded row', async () => {
    await dieOnEveryGitCall();
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = r.body.find(p => p.name === 'app');
    assert.ok(row, 'the project row survives');
    assert.deepEqual(row.worktrees.map(w => w.worktreeName), [wt.worktreeName]);
    assert.deepEqual(row.worktrees[0].mergeStatus, { ahead: null, behind: null },
      'divergence is unknown, not measured');
  });

  // PINS: and the MCP listing face agrees — a conductor must not read a
  // degraded project as having no worktrees.
  test('list_projects keeps the worktree on a degraded row', async () => {
    await dieOnEveryGitCall();
    const r = await callTool(baseUrl, 'list_projects', {});
    assert.match(r.text, new RegExp(wt.worktreeName), r.text);
  });

  // PINS: a death in the NARROW window between the row's two git probes still
  // sets the row's reason. `isGitRepo` succeeded, `hasUnbornHead` did not, and
  // the catch returned `false` — a git fact invented for a project cc could no
  // longer measure, on a row carrying no explanation for it.
  test('a death between the row\'s two git probes still explains the row', async () => {
    const sys = await systemById(remote.id, 'test');
    const proto = liveSystemProto(sys);
    const orig = proto.exec;
    let seenRepoProbe = false;
    proto.exec = async function (spec, opts) {
      const argv = spec?.argv ?? [];
      if (argv.includes('--git-dir')) { seenRepoProbe = true; return orig.call(this, spec, opts); }
      // Everything after the repo probe is a dead transport.
      if (seenRepoProbe && argv[0] === 'git') {
        return {
          code: 1, stdout: '', stderr: '', output: '', timedOut: false, truncated: false,
          durationMs: 1, spawnError: 'provider exited (code 9)', transportFailure: true,
        };
      }
      return orig.call(this, spec, opts);
    };
    try {
      const r = await api(baseUrl, 'GET', '/api/projects');
      const row = r.body.find(p => p.name === 'app');
      assert.ok(row, 'the row survives');
      assert.ok(row.systemUnreachable, `a row missing facts must say why: ${JSON.stringify(row)}`);
      assert.match(row.systemUnreachable, new RegExp(remote.id));
    } finally { proto.exec = orig; }
  });

  // PINS: one dying project does not take the listing down for the others —
  // P2's contract, now against a death DURING the listing rather than at
  // resolution.
  test('a mid-listing death degrades one row and leaves the rest measured', async () => {
    const localTree = await seedRepo(path.join(remote.root, 'ignored'));
    void localTree;
    await api(baseUrl, 'POST', '/api/projects', { name: 'localone' });
    await dieOnEveryGitCall();
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map(p => p.name).sort(), ['app', 'localone']);
    const loc = r.body.find(p => p.name === 'localone');
    assert.equal(loc.isGitRepo, true, 'the healthy project is still measured');
    const app = r.body.find(p => p.name === 'app');
    assert.equal('isGitRepo' in app && app.isGitRepo === true, false,
      'the dying project invents no git fact');
  });
});
