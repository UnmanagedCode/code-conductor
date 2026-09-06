// TWO PLACES, ONE CLAUDE CLI TRANSCRIPT DIRECTORY.
//
// The guard's JOB survived the geometry; the KEY it compares changed. It used to
// compare `encodeCwd(sessionRootKey(project, worktree))` — a cc-owned name under
// the store — and answered null for the local system, because a local place had
// no session root to collide on. It now compares `encodeCwd(<the CLI's cwd>)`,
// which is the place's real path on whatever machine it lives on, ACROSS EVERY
// SYSTEM.
//
// THE WIDENING IS FORCED, not tidy-minded. While a remote cwd lived under cc's
// store it was disjoint from every local project path by construction, so a
// local place could never collide with a remote one. Now a local project at
// `/srv/app` and a remote project at `/srv/app` on `box` produce the same
// directory — and `~/.claude` is host-pinned, so both land on the host's real
// disk and their sessions interleave there.
//
// `encodeCwd` COLLAPSES `_` AND `.` TO `-`, so "collides" is strictly wider than
// "is the same path", and half these cases are about that half.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, createProject, encodeCwd, projectsRoot } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import {
  registeredPlaces, transcriptCollisionReason, transcriptCwdCollision,
} from '../src/systems/transcriptKey.ts';

describe('the transcript-directory collision guard', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  const place = (over) => ({ project: 'cand', worktree: null, system: 'local', cwd: '/srv/app', ...over });

  // ── the predicate, over an injected place list ──────────────────────
  // Injected rather than registered, so the comparison itself is testable
  // without a filesystem behind every case.

  // T1 PINS: a byte-equal cwd collides, and the hit says `samePath`.
  test('T1: an identical cwd collides and reports samePath', async () => {
    const hit = await transcriptCwdCollision(place(), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
    ]);
    assert.equal(hit?.project, 'held');
    assert.equal(hit.samePath, true);
  });

  // T2 PINS THE WIDER HALF: cwds that are DIFFERENT paths but encode alike
  // still collide, and the hit says they are not the same path. A byte
  // comparison passes this case and is wrong.
  test('T2: cwds that merely encode alike collide, and samePath is false', async () => {
    assert.equal(encodeCwd('/srv/a_b'), encodeCwd('/srv/a.b'), 'the fixture is not exercising the collapse');
    const hit = await transcriptCwdCollision(place({ cwd: '/srv/a_b' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/a.b' },
    ]);
    assert.equal(hit?.project, 'held');
    assert.equal(hit.samePath, false);
  });

  // T3 PINS THE WIDENING: a LOCAL place and a REMOTE place at one path collide.
  // The old guard returned null for the local system and never compared them.
  test('T3: a local place and a remote place at one path collide', async () => {
    const hit = await transcriptCwdCollision(place({ system: 'local' }), [
      { project: 'held', worktree: null, system: 'box', cwd: '/srv/app' },
    ]);
    assert.equal(hit?.project, 'held');
    assert.equal(hit.system, 'box');
  });

  // T4 PINS: two DIFFERENT systems at one path collide too — the transcript
  // directory is keyed on the cwd alone, and the system is not part of it.
  test('T4: two systems at one path collide', async () => {
    const hit = await transcriptCwdCollision(place({ system: 'boxA' }), [
      { project: 'held', worktree: null, system: 'boxB', cwd: '/srv/app' },
    ]);
    assert.equal(hit?.system, 'boxB');
  });

  // T5 PINS: a genuinely different path does NOT collide. The control that
  // keeps every case above from passing on an always-true predicate.
  test('T5: an unrelated path does not collide', async () => {
    assert.equal(await transcriptCwdCollision(place({ cwd: '/srv/other' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
    ]), null);
  });

  // T6 PINS: a prefix-SHARING sibling is not a collision. `/srv/app-backup`
  // shares a prefix with `/srv/app` and encodes differently.
  test('T6: a prefix-sharing sibling does not collide', async () => {
    assert.equal(await transcriptCwdCollision(place({ cwd: '/srv/app-backup' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
    ]), null);
  });

  // T7 PINS: THE CANDIDATE'S OWN IDENTITY IS NOT A COLLISION. Re-registering a
  // place that is already registered is a duplicate-create, which the creation
  // paths diagnose far better than this guard could.
  test('T7: a place does not collide with itself', async () => {
    assert.equal(await transcriptCwdCollision(place({ project: 'held' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
    ]), null);
    // …but a WORKTREE of the same project at that path is not the same place.
    const hit = await transcriptCwdCollision(place({ project: 'held', worktree: 'wt' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
    ]);
    assert.equal(hit?.worktree, null);
  });

  // ── the refusal sentence ────────────────────────────────────────────

  // T8 PINS: BOTH HALVES of the sentence branch on `samePath`. In the
  // encode-only branch the two places are genuinely different directories, so
  // the flat one-directory harm would be a plain falsehood two clauses after
  // saying the paths differ.
  test('T8: the refusal says which kind of collision it is', () => {
    const same = transcriptCollisionReason('project \'cand\'', place(),
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app', samePath: true });
    assert.match(same, /already project 'held'/);
    assert.match(same, /interleave/);
    assert.doesNotMatch(same, /collapses/);

    const encoded = transcriptCollisionReason('project \'cand\'', place({ cwd: '/srv/a_b' }),
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/a.b', samePath: false });
    assert.match(encoded, /collapses/);
    assert.match(encoded, /stay separate/);
    assert.match(encoded, /'_' and '\.' both become '-'/);
  });

  // T9 PINS: the holder's SYSTEM is named when it differs, and not when it does
  // not. "on system 'local'" in the ordinary all-local case is noise; across
  // systems it is the whole explanation for why two unrelated-looking paths are
  // not.
  test('T9: the refusal names the other system only when it differs', () => {
    const across = transcriptCollisionReason('project \'cand\'', place({ system: 'local' }),
      { project: 'held', worktree: null, system: 'box', cwd: '/srv/app', samePath: true });
    assert.match(across, /on system 'box'/);

    const within = transcriptCollisionReason('project \'cand\'', place({ system: 'local' }),
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app', samePath: true });
    assert.doesNotMatch(within, /on system/);
  });

  // ── the guard at the creation paths ─────────────────────────────────

  // T10 PINS: `registeredPlaces` enumerates projects AND their worktrees, with
  // each worktree's cwd derived by the same rule createWorktree uses — so the
  // guard cannot disagree with the thing it guards.
  test('T10: registeredPlaces covers projects and their worktrees', async () => {
    assert.equal((await createProject('alpha')).name, 'alpha');
    // A worktree branches off HEAD, so the project needs a commit first.
    await seedRepo(path.join(projectsRoot(), 'alpha'));
    const wt = await createWorktree('alpha', { name: 'w1' });

    const places = await registeredPlaces();
    const proj = places.find(p => p.project === 'alpha' && p.worktree === null);
    const worktree = places.find(p => p.project === 'alpha' && p.worktree === wt.worktreeName);
    assert.ok(proj, 'the project is not enumerated');
    assert.ok(worktree, 'its worktree is not enumerated');
    assert.equal(proj.cwd, path.join(projectsRoot(), 'alpha'));
    assert.equal(worktree.cwd, wt.worktreePath, "the derived worktree cwd is not the one createWorktree used");
  });

  // T11 PINS THE WIDENING END TO END, at the path a user takes: adopting a
  // REMOTE project at the same path a LOCAL project already occupies is refused.
  // This is the case the old guard could not see at all.
  test('T11: adopting a remote project onto a local project\'s path is refused', async () => {
    // OUT-OF-ROOT, so this is an ordinary adopt on both sides.
    const shared = await seedRepo(path.join(await mkdtemp('cc-shared-'), 'app'));
    assert.equal((await adoptProject('shared', shared)).ok, true);

    const remote = await bindRemoteSystem();
    // The reference provider IS this machine, so the SAME path is reachable on
    // both — which is exactly the shape the widening exists for.
    const r = await adoptProject('other', shared, { system: remote.id });
    assert.equal(r.ok, false, 'a remote project took a local project\'s transcript directory');
    assert.equal(r.code, 'TRANSCRIPT_DIR_COLLISION');
    assert.match(r.reason, /'shared'/);
  });

  // T12 PINS: createWorktree asks the guard BEFORE touching git state, and the
  // refusal names the worktree as the caller would say it.
  test('T12: a worktree whose path is already held is refused before git runs', async () => {
    assert.equal((await createProject('beta')).name, 'beta');
    await seedRepo(path.join(projectsRoot(), 'beta'));
    // A PROJECT whose own directory is the one the worktree would take: the
    // worktree directory name is `<project>_worktree_<slug>`, and a project may
    // legally be named that.
    assert.equal((await createProject('beta_worktree_w1')).name, 'beta_worktree_w1');

    await assert.rejects(() => createWorktree('beta', { name: 'w1' }), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'TRANSCRIPT_DIR_COLLISION');
      assert.match(e.message, /worktree 'w1' of project 'beta'/);
      assert.match(e.message, /'beta_worktree_w1'/);
      return true;
    });
    // AND NOTHING WAS CREATED: the guard runs before any git state is touched.
    const branches = await fs.readdir(path.join(projectsRoot(), 'beta', '.git', 'refs', 'heads')).catch(() => []);
    assert.deepEqual(branches.filter(b => b.includes('w1')), [],
      'the refused worktree created a branch');
  });
});
