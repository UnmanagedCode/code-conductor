// THE RECORD, once `remoteId` joins the tuple that identifies a project.
//
// A path names a tree only together with the machine it is on — and now, when
// one endpoint serves many machines, together with WHICH one. So the identity
// every creation path compares on is (system, remoteId, path), and this file
// pins that at the record and at each surface that reads or writes it.
//
// The fixture keeps two targets behind ONE registered system, which is the
// shape this file exists for: ten containers, one docker provider, one row
// in Settings.
//
// Both targets are rooted at the SAME sandbox, deliberately. Root scoping is
// what proves routing elsewhere; here it would only get in the way, because the
// question this file asks is whether the IDENTITY tuple discriminates — and a
// path reachable from exactly one target would answer that by accident. With
// one path reachable from both, only the remoteId can tell the two apart, and
// `CC_REMOTE` still says which one actually served a command.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import {
  createProject, deleteProject, adoptProject, getProject, listProjects,
  readProjectRecord, writeProjectMeta, resolveProjectDir, projectStoreDir, transcriptRoot,
} from '../src/projects.ts';
import {
  CONDUCT_PROJECT_NAME, LOCAL_SYSTEM_ID, disposeSystemHandles, placementOf, projectPlacement,
} from '../src/systems/registry.ts';

async function readRecord(name) {
  try { return JSON.parse(await fs.readFile(path.join(projectStoreDir(name), 'project.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

describe('remoteId in the project record', () => {
  let home, remote, sandbox, rootA, rootB;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    sandbox = await fs.realpath(await mkdtemp('cc-remote-'));
    rootA = path.join(sandbox, 'a');
    rootB = path.join(sandbox, 'b');
    await fs.mkdir(rootA);
    await fs.mkdir(rootB);
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`] });
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // ── The record ───────────────────────────────────────────────────────

  // PINS: `remoteId` round-trips through the record, AND survives a later write
  // that is about something else entirely. writeProjectRecord merges over what
  // the reader returns, so a location the reader forgot would be silently
  // DELETED by the next workspace change — and with it gone, the project is
  // UNREGISTERED.
  test('the record round-trips remoteId and survives an unrelated write', async () => {
    await createProject('app', { system: remote.id, remoteId: 'a', systemPath: path.join(rootA, 'app') });
    assert.equal((await readRecord('app')).location.remoteId, 'a');
    assert.equal((await readProjectRecord('app')).location.remoteId, 'a');

    await writeProjectMeta('app', { workspace: 'CTF' });
    const after = await readRecord('app');
    assert.equal(after.workspace, 'CTF');
    assert.equal(after.location.remoteId, 'a', 'an unrelated write must not drop the placement');
    assert.equal(after.location.system, remote.id);
  });

  // PINS: absence of `remoteId` is the provider's own default target — the same
  // shape as absence of `system` meaning local, and forced by the same
  // field-dropping writer.
  test('a remote project with no remoteId records none', async () => {
    const bare = await bindRemoteSystem({ id: 'bare' });
    await createProject('plain', { system: bare.id, systemPath: path.join(bare.root, 'plain') });
    assert.equal((await readRecord('plain')).location.remoteId, null);
    assert.equal((await projectPlacement('plain')).remoteId, null);
  });

  // PINS: a LOCAL location forces remoteId null — cc's own machine is one
  // machine, so a target named on it names nothing.
  test('placementOf forces remoteId null for a local project', () => {
    assert.deepEqual(
      placementOf('p', { kind: 'local', path: '/app' }),
      { system: LOCAL_SYSTEM_ID, remoteId: null, path: '/app' },
    );
  });

  // PINS: the `.conduct` pin is UNCONDITIONAL on the MACHINE — a record naming
  // a system and a target for it is ignored rather than honoured.
  test('.conduct stays local with remoteId null even if its record names one', () => {
    assert.deepEqual(
      placementOf(CONDUCT_PROJECT_NAME, { kind: 'remote', system: 'prod-box', remoteId: 'a', path: '/app' }),
      { system: LOCAL_SYSTEM_ID, remoteId: null, path: '/app' },
    );
  });

  // ── Validation ───────────────────────────────────────────────────────

  // PINS: a remoteId is NOT a slug — container names, hostnames and VM ids
  // legitimately carry `_` and `.`. What is refused is what cannot survive a
  // wire field: emptiness, whitespace, control characters, and absurd length.
  test('remoteId validation admits container-shaped ids and refuses unusable ones', async () => {
    const at = (p) => path.join(rootA, p);
    await createProject('ok1', { system: remote.id, remoteId: 'a', systemPath: at('ok1') });
    assert.equal((await projectPlacement('ok1')).remoteId, 'a');

    for (const bad of ['has space', 'tab\there', 'nul\0byte', 'x'.repeat(129)]) {
      await assert.rejects(
        () => createProject(`bad-${Math.random().toString(36).slice(2)}`, {
          system: remote.id, remoteId: bad, systemPath: at('bad'),
        }),
        (e) => e.statusCode === 400,
        `remoteId ${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  // PINS: a remoteId with no system is refused — a target on cc's own machine
  // is not a thing, exactly as a systemPath with no system is not.
  test('a remoteId without a system is a 400', async () => {
    await assert.rejects(
      () => createProject('nope', { remoteId: 'a' }),
      (e) => e.statusCode === 400 && /remoteId/.test(e.message),
    );
  });

  // ── The identity tuple ───────────────────────────────────────────────

  // PINS: two projects on ONE system at different targets are two projects, and
  // resolution keeps them apart. Without remoteId on the record the second
  // would resolve onto the first's target and report success.
  test('two projects on one system at different remotes resolve to their own target', async () => {
    await createProject('alpha', { system: remote.id, remoteId: 'a', systemPath: path.join(rootA, 'alpha') });
    await createProject('beta', { system: remote.id, remoteId: 'b', systemPath: path.join(rootB, 'beta') });

    const a = await resolveProjectDir('alpha');
    const b = await resolveProjectDir('beta');
    assert.equal(a.system.id, remote.id);
    assert.equal(b.system.id, remote.id);
    assert.equal(a.system.remoteId, 'a');
    assert.equal(b.system.remoteId, 'b');
    assert.notEqual(a.system, b.system, 'each project holds a handle bound to its own target');

    // Measured on the far side: which target actually served the command.
    const ranA = await a.system.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: a.path });
    const ranB = await b.system.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: b.path });
    assert.equal(ranA.stdout.trim(), 'a');
    assert.equal(ranB.stdout.trim(), 'b');
  });

  // PINS: adopt's duplicate test compares the FULL triple — a path already
  // adopted on THIS target is TARGET_ALREADY_MANAGED, and that is a different
  // refusal from the transcript one below, with a different reason.
  test('adopt refuses the same path on the same target as TARGET_ALREADY_MANAGED', async () => {
    const shared = await seedRepo(path.join(sandbox, 'shared'));

    const first = await adoptProject('one', shared, { system: remote.id, remoteId: 'a' });
    assert.equal(first.ok, true);
    assert.equal(first.remoteId, 'a');

    const same = await adoptProject('three', shared, { system: remote.id, remoteId: 'a' });
    assert.equal(same.ok, false);
    assert.equal(same.code, 'TARGET_ALREADY_MANAGED');
    assert.match(same.reason, /'one'/);
  });

  // PINS A CONSEQUENCE OF THE FUSE GEOMETRY, and it is a NARROWING: the same
  // absolute path on two targets of one system is two different trees, and
  // adopting both is now ALLOWED: each target gets a CLI config directory of
  // its own, keyed on (system, remoteId), so the transcript directory the CLI
  // derives from that one cwd sits under a different root on each.
  //
  // This is the inversion card 2026-0447 makes. The refusal it replaces was
  // honest about a real harm, but it refused the configuration the operator
  // wanted rather than fixing it.
  test('adopt ALLOWS the same path on ANOTHER target, with separate transcript directories', async () => {
    const shared = await seedRepo(path.join(sandbox, 'shared'));
    assert.equal((await adoptProject('one', shared, { system: remote.id, remoteId: 'a' })).ok, true);

    const otherTarget = await adoptProject('two', shared, { system: remote.id, remoteId: 'b' });
    assert.equal(otherTarget.ok, true, JSON.stringify(otherTarget));

    // Separate directories, not merely separate records — the records are what
    // the old refusal already allowed to differ.
    assert.notEqual(
      transcriptRoot({ system: remote.id, remoteId: 'a', cwd: shared }),
      transcriptRoot({ system: remote.id, remoteId: 'b', cwd: shared }));
  });

  // PINS: the mechanism the "a worktree can only re-derive to the target it was
  // created against" invariant actually rests on — a name that is already held
  // cannot be re-pointed by a creation path, whatever remoteId it names.
  test('create and adopt on a held name refuse PROJECT_EXISTS and change nothing', async () => {
    await createProject('app', { system: remote.id, remoteId: 'a', systemPath: path.join(rootA, 'app') });
    const before = await readRecord('app');

    await assert.rejects(
      () => createProject('app', { system: remote.id, remoteId: 'b', systemPath: path.join(rootB, 'app') }),
      (e) => e.statusCode === 409,
    );
    assert.deepEqual(await readRecord('app'), before, 'a refused create re-points nothing');

    const repo = await seedRepo(path.join(sandbox, 'other'));
    const adopted = await adoptProject('app', repo, { system: remote.id, remoteId: 'b' });
    assert.equal(adopted.ok, false);
    assert.equal(adopted.code, 'PROJECT_EXISTS');
    assert.deepEqual(await readRecord('app'), before, 'a refused adopt re-points nothing');
  });

  // ── The surfaces that carry it ───────────────────────────────────────

  // PINS: every project-shaped payload carries remoteId, so a caller can tell
  // two targets of one system apart without re-reading the record.
  test('create, list, get and delete all carry remoteId', async () => {
    const tree = path.join(rootA, 'app');
    const created = await createProject('app', { system: remote.id, remoteId: 'a', systemPath: tree });
    assert.equal(created.remoteId, 'a');

    const row = (await listProjects()).find(p => p.name === 'app');
    assert.deepEqual(
      { system: row.system, remoteId: row.remoteId, path: row.path },
      { system: remote.id, remoteId: 'a', path: tree },
    );

    assert.equal((await getProject('app')).system.remoteId, 'a');

    const deleted = await deleteProject('app');
    assert.equal(deleted.remoteId, 'a', 'the unregister result names the target it was left on');
    assert.equal(await readRecord('app'), null);
  });

  // PINS: a LOCAL project's row reports remoteId null rather than omitting the
  // key — the listing's shape does not depend on where a project lives.
  test('a local project lists with remoteId null', async () => {
    await createProject('here');
    const row = (await listProjects()).find(p => p.name === 'here');
    assert.equal(row.system, LOCAL_SYSTEM_ID);
    assert.equal(row.remoteId, null);
  });
});
