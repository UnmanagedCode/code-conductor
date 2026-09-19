// TWO PLACES, ONE CLAUDE CLI TRANSCRIPT DIRECTORY.
//
// The guard compares whole transcript DIRECTORIES —
// `<transcriptRoot(place)>/<encodeCwd(cwd)>` — not encoded cwds. It cannot key
// on a cc-owned name under the store: `sessionRootKey`, and the
// `sessionRootKeyCollision` lookup built over it, no longer exist and must not
// be reintroduced. That lookup answered null for the local system outright,
// because a local place has no session root to collide on — so it could never
// have carried this guard.
//
// THE ROOT IS PART OF THE KEY. Each (system, remoteId) reads its own CLI config
// directory, so two boxes at `/root/app3` are two directories and register
// freely; two places on ONE target at one path are one directory and do not.
//
// `encodeCwd` COLLAPSES `_`, `.` AND `/` TO `-`, so within a single root
// "collides" is strictly wider than "is the same path", and half these cases
// are about that half.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import {
  adoptProject, createProject, encodeCwd, listProjects, localWorktreesRoot,
  normalizeSystemPath, projectsRoot, transcriptRoot,
} from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import {
  registeredPlaces, transcriptCollisionReason, transcriptCwdCollision,
} from '../src/systems/transcriptKey.ts';

describe('the transcript-directory collision guard', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  const place = (over) => ({ project: 'cand', worktree: null, system: 'local', remoteId: null, cwd: '/srv/app', ...over });

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
  // T3 PINS THE INVERSION: a local place and a remote place at one path are no
  // longer one directory. The remote reads its own CLI config directory, so
  // `/srv/app` locally and `/srv/app` on `box` are two roots — which is the
  // whole of card 2026-0447 and the configuration the owner wants registrable.
  test('T3: a local place and a remote place at one path do NOT collide', async () => {
    assert.equal(await transcriptCwdCollision(place({ system: 'local' }), [
      { project: 'held', worktree: null, system: 'box', remoteId: null, cwd: '/srv/app' },
    ]), null);
  });

  // T4 PINS THE INVERSION AND ITS LIMIT. Two different systems at one path are
  // two directories now. Two places on the SAME target at one path still
  // collide — that is genuinely one tree, one config dir, one directory — and
  // the two remote targets of ONE system are separate too, because the config
  // directory is keyed on (system, remoteId).
  test('T4: two systems at one path do NOT collide', async () => {
    assert.equal(await transcriptCwdCollision(place({ system: 'boxA' }), [
      { project: 'held', worktree: null, system: 'boxB', remoteId: null, cwd: '/srv/app' },
    ]), null);
  });

  test('T4b: two targets of ONE system at one path do NOT collide', async () => {
    assert.equal(await transcriptCwdCollision(place({ system: 'box', remoteId: 'a' }), [
      { project: 'held', worktree: null, system: 'box', remoteId: 'b', cwd: '/srv/app' },
    ]), null);
  });

  test('T4c: two places on ONE target at one path DO collide', async () => {
    const hit = await transcriptCwdCollision(place({ system: 'box', remoteId: 'a' }), [
      { project: 'held', worktree: null, system: 'box', remoteId: 'a', cwd: '/srv/app' },
    ]);
    assert.equal(hit?.project, 'held');
    assert.equal(hit.samePath, true);
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

  // T6b PINS THE NORMALISATION HOLE, which was a real guard bypass: the stored
  // `systemPath` was trimmed but never normalised, so `/srv/app/` and `/srv/app`
  // — one directory — encoded differently and did NOT collide. Two projects
  // could take one transcript directory.
  test('T6b: two spellings of one directory collide, and report samePath', async () => {
    for (const spelling of ['/srv/app/', '/srv/./app', '/srv/x/../app']) {
      const hit = await transcriptCwdCollision(place({ cwd: spelling }), [
        { project: 'held', worktree: null, system: 'local', cwd: '/srv/app' },
      ]);
      assert.equal(hit?.project, 'held', spelling);
      // AND `samePath`, not the encode-only branch: they ARE one directory, and
      // the encode-only refusal's "the two directories stay separate" would be
      // false — sending a user to the remedy for the wrong shape.
      assert.equal(hit.samePath, true, spelling);
    }
  });

  // T6c PINS: `samePath` is derived from the NORMALISED comparison even when the
  // stored strings differ, and a genuinely encode-only pair still reports false.
  // Both directions, because a predicate that always answered `true` would pass
  // the first half alone.
  test('T6c: samePath follows the normalised paths, in both directions', async () => {
    const one = await transcriptCwdCollision(place({ cwd: '/srv/app' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/app/' },
    ]);
    assert.equal(one.samePath, true, 'one directory, two spellings');
    const two = await transcriptCwdCollision(place({ cwd: '/srv/a_b' }), [
      { project: 'held', worktree: null, system: 'local', cwd: '/srv/a.b' },
    ]);
    assert.equal(two.samePath, false, 'genuinely two directories');
  });

  // T6d PINS THE WRITE PATH: a systemPath is normalised BEFORE it is stored, so
  // the record, the guard and the adopt duplicate check all see one spelling.
  test('T6d: validatePlacementInput normalises what it stores', () => {
    assert.equal(normalizeSystemPath('/srv/app/'), '/srv/app');
    assert.equal(normalizeSystemPath('/srv/./app'), '/srv/app');
    assert.equal(normalizeSystemPath('/srv/x/../app'), '/srv/app');
    assert.equal(normalizeSystemPath('/srv/app'), '/srv/app');
    // The one path where stripping a trailing slash is wrong.
    assert.equal(normalizeSystemPath('/'), '/');
  });

  // T6f PINS THE CALL SITE T6e MISSED, and the miss is the point: T6e adopts,
  // and `adoptProject` normalises through `system.realpath` before it ever gets
  // there — so `validatePlacementInput`'s own `normalizeSystemPath(p)` was never
  // reached, and replacing it with a bare `p` left T6e (and the whole suite)
  // green. `createProject` is the ONLY caller of that function, so this is the
  // path that has to be driven.
  //
  // THE MUTATION THIS MUST DIE UNDER: `systemPath: normalizeSystemPath(p)` → `p`
  // in validatePlacementInput. Both assertions below fail under it — the record
  // keeps the caller's spelling, and the guard then compares that spelling.
  test('T6f: createProject normalises the systemPath it stores, and the guard reads it', async () => {
    const remote = await bindRemoteSystem();
    const box = await fs.realpath(remote.root);

    // A trailing slash and an interior `.`: the two shapes `normalize` folds,
    // and both are one directory with the un-suffixed spelling.
    assert.equal((await createProject('slashed', { system: remote.id, systemPath: `${box}/app/` })).name, 'slashed');
    assert.equal((await createProject('dotted', { system: remote.id, systemPath: `${box}/./sub` })).name, 'dotted');

    const rows = await listProjects();
    assert.equal(rows.find(r => r.name === 'slashed')?.path, `${box}/app`,
      "the caller's trailing slash reached the record");
    assert.equal(rows.find(r => r.name === 'dotted')?.path, `${box}/sub`,
      "the caller's `.` segment reached the record");

    // AND THE GUARD COMPARES THAT SPELLING: a candidate at the normalised path
    // collides against the registered places, as ONE directory rather than as
    // two that merely encode alike.
    const hit = await transcriptCwdCollision(
      { project: 'other', worktree: null, system: remote.id, cwd: `${box}/app` });
    assert.equal(hit?.project, 'slashed');
    assert.equal(hit.samePath, true);
  });

  // T6e PINS THE ADOPT PATH's stored spelling. NOT the call site it was written
  // for — mutation showed `adoptProject` normalises through `system.realpath`
  // and never reaches `validatePlacementInput`, so T6f above is what closes
  // that. This one still earns its place: it is the only assertion that an
  // adopted remote row's stored path is normalised, whatever normalises it.
  test('T6e: a systemPath is normalised before it is stored', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('withslash', `${tree}/`, { system: remote.id })).ok, true);

    const stored = (await listProjects()).find(p => p.name === 'withslash');
    assert.ok(stored, 'the project was not registered');
    assert.equal(stored.path, tree, 'the trailing slash reached the record');

    // AND THE GUARD READS THAT SPELLING: a candidate at the un-slashed path
    // collides against the REGISTERED places, which is the consequence of
    // storing one spelling rather than the caller's.
    const hit = await transcriptCwdCollision(
      { project: 'other', worktree: null, system: remote.id, cwd: tree });
    assert.equal(hit?.project, 'withslash');
    assert.equal(hit.samePath, true);
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
  test('T9: the refusal names the other placement only when it differs', () => {
    const across = transcriptCollisionReason('project \'cand\'', place({ system: 'local' }),
      { project: 'held', worktree: null, system: 'box', remoteId: null, cwd: '/srv/app', samePath: true });
    assert.match(across, /on system 'box'/);

    // WHICH TARGET, not just which system: two targets of one system are two
    // transcript directories now, so "on system 'box'" would name the pair
    // ambiguously where the remote ids are what differ.
    const acrossTargets = transcriptCollisionReason('project \'cand\'', place({ system: 'box', remoteId: 'a' }),
      { project: 'held', worktree: null, system: 'box', remoteId: 'b', cwd: '/srv/app', samePath: true });
    assert.match(acrossTargets, /remote 'b' of system 'box'/);

    const within = transcriptCollisionReason('project \'cand\'', place({ system: 'local' }),
      { project: 'held', worktree: null, system: 'local', remoteId: null, cwd: '/srv/app', samePath: true });
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

  // T11 PINS THE INVERSION END TO END, through the real adopt path: the
  // configuration card 2026-0447 was filed about is now registrable, and the
  // two projects get two transcript directories rather than sharing one.
  test('T11: adopting a remote project onto a local project\'s path is ALLOWED', async () => {
    // OUT-OF-ROOT, so this is an ordinary adopt on both sides.
    const shared = await seedRepo(path.join(await mkdtemp('cc-shared-'), 'app'));
    assert.equal((await adoptProject('shared', shared)).ok, true);

    const remote = await bindRemoteSystem();
    // The reference provider IS this machine, so the SAME path is reachable on
    // both — which is exactly the shape the fix exists for.
    const r = await adoptProject('other', shared, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));

    // And they are genuinely two directories, not merely two allowed records.
    assert.notEqual(
      transcriptRoot({ system: 'local', remoteId: null, cwd: shared }),
      transcriptRoot({ system: remote.id, remoteId: null, cwd: shared }));
  });

  // T13 PINS AC10 in the shape NESTING NEWLY MAKES REACHABLE: `<root>/A/b` and
  // `<root>/A-b` are two directories, and the CLI collapses `/` and `-` alike —
  // so they encode to one transcript directory. A container directory under the
  // projects root is exactly how a user produces that pair.
  test('T13: registering <root>/A/b is refused when <root>/A-b is registered', async () => {
    const flat = await seedRepo(path.join(projectsRoot(), 'A-b'));
    assert.equal((await adoptProject('flat', flat)).ok, true);
    const nested = await seedRepo(path.join(projectsRoot(), 'A', 'b'));
    assert.notEqual(nested, flat, 'premise: two different directories');
    assert.equal(encodeCwd(nested), encodeCwd(flat), 'premise: they encode alike');

    const r = await adoptProject('nested', nested);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'TRANSCRIPT_DIR_COLLISION');
    assert.match(r.reason, /'flat'/);
  });

  // T14 PINS: the refusal fires AT REGISTRATION, not at spawn. The one guarded
  // writer is where it lives, so a surface that reaches registerProject by any
  // route inherits it — and nothing half-registered is left behind.
  test('T14: the refusal fires at registration, not at spawn', async () => {
    const flat = await seedRepo(path.join(projectsRoot(), 'A-b'));
    assert.equal((await adoptProject('flat', flat)).ok, true);
    await seedRepo(path.join(projectsRoot(), 'A', 'b'));

    const { registerProject, readProjectRecord } = await import('../src/projects.ts');
    await assert.rejects(
      () => registerProject('nested', { kind: 'local', path: path.join(projectsRoot(), 'A', 'b') }),
      (e) => { assert.equal(e.statusCode, 409); assert.equal(e.code, 'TRANSCRIPT_DIR_COLLISION'); return true; },
    );
    assert.equal(await readProjectRecord('nested'), null, 'and nothing was registered');
  });

  // T12 PINS: createWorktree asks the guard BEFORE touching git state, and the
  // refusal names the worktree as the caller would say it.
  test('T12: a worktree whose path is already held is refused before git runs', async () => {
    assert.equal((await createProject('beta')).name, 'beta');
    await seedRepo(path.join(projectsRoot(), 'beta'));
    // THE HOLDER IS ON CC'S OWN MACHINE, and it holds the worktree's directory
    // by ALIASING rather than by being it: local adoption refuses cc's own
    // worktree area outright, so the pair is `<root>/.worktrees/beta/w1` and its
    // sibling `<root>/-worktrees-beta-w1`, two directories that encode to one
    // because encodeCwd collapses `/` and `.` alike. A holder on another machine
    // would not serve — it reads its own CLI config directory, so it names a
    // different directory however its path is spelled.
    const wtPath = path.join(localWorktreesRoot(), 'beta', 'w1');
    const taken = path.join(projectsRoot(), '-worktrees-beta-w1');
    await seedRepo(taken);
    assert.notEqual(taken, wtPath, 'premise: two different directories');
    assert.equal(encodeCwd(taken), encodeCwd(wtPath), 'premise: they encode alike');
    assert.equal((await adoptProject('holder', taken)).ok, true);

    await assert.rejects(() => createWorktree('beta', { name: 'w1' }), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'TRANSCRIPT_DIR_COLLISION');
      assert.match(e.message, /worktree 'w1' of project 'beta'/);
      assert.match(e.message, /'holder'/);
      return true;
    });
    // AND NOTHING WAS CREATED: the guard runs before any git state is touched.
    const branches = await fs.readdir(path.join(projectsRoot(), 'beta', '.git', 'refs', 'heads')).catch(() => []);
    assert.deepEqual(branches.filter(b => b.includes('w1')), [],
      'the refused worktree created a branch');
  });
});
