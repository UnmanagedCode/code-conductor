// CHANGING A PROJECT'S TARGET, and what has to be clear before it may happen.
//
// `remoteId` is mutable, through exactly one function. It refuses while the
// project has live sessions or registered worktrees, and it names what must be
// cleared rather than discarding anything the user did not ask about.
//
// The two halves of that guard are NOT equally strong, and this file pins them
// as what they are:
//
//   * WORKTREES are an INVARIANT — read inside the function, so no caller can
//     affect it. That is what carries the property that a worktree can only ever
//     re-derive to the target it was created against, since `WorktreeMeta`
//     deliberately stores no target of its own.
//   * LIVE INSTANCES are a CALLER CONTRACT — src/instances.ts imports
//     src/projects.ts, so the reverse import would close a cycle and the manager
//     must be injected. A required, non-defaultable getter raises the bar; a
//     caller that supplies `() => []` still defeats it.
//
// So the worktree half is tested by calling the function DIRECTLY, not through
// a route: a route-level test would pass even if the guard lived in the route.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import {
  adoptProject, createProject, listProjects, projectStoreDir, resolveProjectDir, setProjectRemote,
  orchStoreRoot,
} from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles, projectPlacement } from '../src/systems/registry.ts';
import { systemById } from '../src/systems/registry.ts';
import { getOrCompute, projectCacheKey, _resetForTest } from '../src/projectsCache.ts';

const NO_INSTANCES = { liveInstanceIds: () => [] };

async function readRecord(name) {
  try { return JSON.parse(await fs.readFile(path.join(projectStoreDir(name), 'project.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const exists = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };

describe('changing a project target', () => {
  let home, sandbox, remote;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    // A real TTL, so a cached entry is genuinely served from cache and the
    // invalidation below is what makes the next read recompute.
    _resetForTest(60_000);
    sandbox = await fs.realpath(await mkdtemp('cc-remote-'));
    // Both targets over one sandbox, so a change of target is not also a change
    // of reachability — the question here is the RECORD and what is invalidated.
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`] });
  });
  afterEach(async () => { _resetForTest(0); disposeSystemHandles(); await rmrf(home); });

  const seed = async (name = 'app', remoteId = 'a') => {
    await createProject(name, { system: remote.id, remoteId, systemPath: path.join(sandbox, name) });
    return path.join(sandbox, name);
  };

  // NOTE: there is no local session root to compose any more; a refused change
  // is asserted on the RECORD it did not write, which is the only artefact.
  // (was: a real session root, composed the way a spawn composes one) —
  // a root that was never created would be vacuous — the whole question is
  // whether an existing one survives.

  // ── The happy change ─────────────────────────────────────────────────

  // PINS: a permitted change rewrites the record and every later resolution
  // follows it to the new target — measured on the far side, since a change
  // that only altered the record would still read as success.
  test('a permitted change re-points the project and resolution follows', async () => {
    await seed();
    const result = await setProjectRemote('app', 'b', NO_INSTANCES);
    assert.deepEqual(
      { system: result.system, remoteId: result.remoteId },
      { system: remote.id, remoteId: 'b' },
    );
    assert.equal((await readRecord('app')).location.remoteId, 'b');
    assert.equal((await projectPlacement('app')).remoteId, 'b');

    const resolved = await resolveProjectDir('app');
    assert.equal(resolved.system.remoteId, 'b');
    const ran = await resolved.system.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: resolved.path });
    assert.equal(ran.stdout.trim(), 'b', 'commands now really run on the new target');
  });

  // PINS: clearing the target is the same operation — a project falls back to
  // the provider's own default rather than needing to be re-registered.
  test('a target can be cleared back to the provider default', async () => {
    await seed();
    const result = await setProjectRemote('app', null, NO_INSTANCES);
    assert.equal(result.remoteId, null);
    assert.equal('remoteId' in (await readRecord('app')), false, 'and the empty field is dropped');
  });

  // ── The guard ────────────────────────────────────────────────────────

  // PINS: the change is refused while a session is live, and the refusal NAMES
  // the sessions to clear rather than killing them.
  test('a live session refuses the change, naming it', async () => {
    await seed();
    const before = await readRecord('app');
    await assert.rejects(
      () => setProjectRemote('app', 'b', { liveInstanceIds: () => ['inst-7', 'inst-9'] }),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.equal(e.code, 'PROJECT_PLACEMENT_IN_USE');
        assert.deepEqual(e.instances, ['inst-7', 'inst-9']);
        assert.deepEqual(e.worktrees, []);
        return true;
      },
    );
    assert.deepEqual(await readRecord('app'), before, 'a refused change writes nothing');
  });

  // PINS: THE INVARIANT HALF. A registered worktree refuses the change, and it
  // does so inside setProjectRemote itself — called directly, with no route in
  // sight — because that is what makes "a worktree can only re-derive to the
  // target it was created against" true rather than merely arranged.
  test('a registered worktree refuses the change, called directly', async () => {
    const tree = await seedRepo(path.join(sandbox, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id, remoteId: 'a' })).ok, true);
    const wt = await createWorktree('app', { name: 'feature' });
    const before = await readRecord('app');
    // Real roots for the project AND its worktree: the removal a permitted
    // change performs is one call plus a loop over the registered worktrees, so
    // both have to be shown surviving.

    await assert.rejects(
      () => setProjectRemote('app', 'b', NO_INSTANCES),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.equal(e.code, 'PROJECT_PLACEMENT_IN_USE');
        assert.deepEqual(e.worktrees, [wt.worktreeName]);
        assert.deepEqual(e.instances, []);
        return true;
      },
    );
    assert.deepEqual(await readRecord('app'), before);
    assert.equal((await projectPlacement('app')).remoteId, 'a', 'the worktree still re-derives to its own target');
    // A REFUSAL LEAVES THE SESSION ROOT AND MANIFEST INTACT. Removing a session
    // root is destructive, and the 409 fires precisely BECAUSE live sessions and
    // registered worktrees exist — the state where destroying one does the most
    // damage. Nothing else in this file would notice the removal being reordered
    // above the guard.
  });

  // ── Verify before persist ────────────────────────────────────────────

  // PINS: a target the provider does not serve is refused with NOTHING written
  // — the same "verify before persist" shape addSystem already has.
  test('an unknown target refuses REMOTE_NOT_FOUND and writes nothing', async () => {
    const tree = await seed();
    const before = await readRecord('app');

    await assert.rejects(
      () => setProjectRemote('app', 'typo', NO_INSTANCES),
      (e) => e.statusCode === 502 && e.code === 'REMOTE_NOT_FOUND',
    );
    assert.deepEqual(await readRecord('app'), before);
    // The SECOND refusal position, and a distinct ordering: this one is raised
    // by the verify-before-persist check, which sits between the guard and the
    // removal. A removal reordered above only the verify would clear the 409
    // test above and still be caught here.
  });

  // PINS: a provider with no `remotes` capability refuses by name at set time,
  // not at the next spawn.
  test('a system that serves no targets refuses SYSTEM_NO_REMOTES', async () => {
    const bare = await bindRemoteSystem({ id: 'bare' });
    await createProject('plain', { system: bare.id, systemPath: path.join(bare.root, 'plain') });
    const before = await readRecord('plain');
    await assert.rejects(
      () => setProjectRemote('plain', 'a', NO_INSTANCES),
      (e) => e.statusCode === 501 && e.code === 'SYSTEM_NO_REMOTES',
    );
    // The WHOLE record, as every other refusal here reads it: asserting only
    // that `remoteId` is still absent would pass a refusal that had cleared the
    // systemPath on its way out.
    assert.deepEqual(await readRecord('plain'), before);
  });

  // PINS: a LOCAL project has no target to name, so the operation is refused
  // rather than silently recording a field placementOf would then ignore.
  test('a local project cannot be given a target', async () => {
    await createProject('here');
    const before = await readRecord('here');
    await assert.rejects(
      () => setProjectRemote('here', 'a', NO_INSTANCES),
      (e) => e.statusCode === 400,
    );
    assert.deepEqual(await readRecord('here'), before,
      'the refusal wrote nothing — no target was silently recorded');
    assert.equal(before.location.kind, 'local');
  });

  // ── What a permitted change invalidates ──────────────────────────────

  // PINS: A PERMITTED CHANGE LEAVES NOTHING LOCAL BEHIND, because there is
  // nothing local to leave. A session root or manifest left behind would hold
  // the OLD target's CLAUDE.md and cached content at local paths a write-back
  // would then push to the NEW target, a clobber invisible from either side.
  // Under the
  // union there is no cc-owned copy of the old target's bytes at all, so the
  // clobber is unreachable rather than cleaned up.
  test('a permitted change leaves no cc-owned copy of the old target', async () => {
    const tree = await seedRepo(path.join(sandbox, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id, remoteId: 'a' })).ok, true);
    const sessionsDir = path.join(orchStoreRoot(), 'systems', remote.id, 'sessions');
    assert.equal(await exists(sessionsDir), false, 'a session root existed before the change');

    await setProjectRemote('app', 'b', NO_INSTANCES);

    assert.equal(await exists(sessionsDir), false, 'the change created one');
    assert.equal((await listProjects()).find(p => p.name === 'app')?.remoteId, 'b', 'the change did not take');
  });

  // PINS: the git-facts cache is invalidated, so the next read measures the new
  // target rather than serving facts about the machine the project left.
  test('a permitted change invalidates the cached git facts', async () => {
    await seed();
    const key = projectCacheKey(remote.id, 'app');
    assert.equal(await getOrCompute(key, async () => 'from-a'), 'from-a');
    assert.equal(await getOrCompute(key, async () => 'never'), 'from-a', 'the fixture really cached');

    await setProjectRemote('app', 'b', NO_INSTANCES);
    assert.equal(await getOrCompute(key, async () => 'from-b'), 'from-b');
  });

  // PINS: setting the target it already has is not an error. Re-running a
  // conductor's own instruction must not be a failure it has to interpret.
  test('setting the same target again is a no-op success', async () => {
    await seed();
    const result = await setProjectRemote('app', 'a', NO_INSTANCES);
    assert.equal(result.remoteId, 'a');
    assert.equal((await readRecord('app')).location.remoteId, 'a');
  });
});
