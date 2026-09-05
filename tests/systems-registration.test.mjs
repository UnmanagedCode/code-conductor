// REGISTERING A REACHABLE SYSTEM — the row that stops being a name and becomes
// a connection.
//
// Through P3 a registry row was declaration only: `{id, label}`, with nothing
// on the surface that could reach a system. A project bound to one therefore
// could not work, which is the whole of what P4 has to change. The row gains
// `launch` — the provider command, as argv — and with it two obligations that
// only exist because the row now claims something testable:
//
//   * cc PROVES the claim before persisting it (R9's registration case). A
//     command that does not complete the handshake is refused with the
//     provider's own error, and nothing is written: a saved row that names an
//     unreachable system is a trap the user finds later, on a project.
//   * cc proves its own side can host the system's local session directories —
//     no ancestor of them may be a git repository, because the CLI's startup
//     probe walks UP and would report cc's store's repo as the project's.
//
// The reference provider is this machine reached over the wire protocol, so
// "reachable" here is a real handshake against a real provider process, not a
// stub that agrees.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { addSystem, updateSystem, removeSystem, getSystem, getSystems } from '../src/appSettings.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { disposeSystemHandles, systemById, LOCAL_SYSTEM_ID } from '../src/systems/registry.ts';
import { sessionRootsDir } from '../src/systems/sessionRoot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE_PROVIDER = path.join(__dirname, '..', 'src', 'systems', 'referenceProvider.ts');

// The launch argv for a system that IS reachable: the reference provider, which
// is the local machine spoken over the protocol.
export function referenceLaunch(...flags) {
  return ['node', REFERENCE_PROVIDER, ...flags];
}

const settingsFile = () => path.join(orchStoreRoot(), 'settings.json');
async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

describe('a registry row that can reach its system', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS: a launch that completes the handshake is persisted as argv on the row.
  test('a reachable provider command is verified and stored as argv', async () => {
    const rec = await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    assert.deepEqual(rec.launch, referenceLaunch());
    assert.deepEqual(getSystem('refbox').launch, referenceLaunch());
    const stored = (await readSettings()).systems.registry;
    assert.deepEqual(stored, [{ id: 'refbox', label: 'Reference', launch: referenceLaunch() }],
      'the command is on disk, so the row still reaches its system after a restart');
  });

  // PINS: a launch that cannot hand back a handshake is REFUSED and NOT
  // persisted — the row does not exist afterwards.
  test('an unreachable provider command is refused, quoting the failure, and saves nothing', async () => {
    await assert.rejects(
      () => addSystem({ id: 'deadbox', label: 'Dead', launch: ['node', '-e', 'process.exit(3)'] }),
      (e) => e.statusCode === 502 && /deadbox/.test(e.message) && /could not be reached/.test(e.message),
    );
    assert.equal(getSystem('deadbox'), null, 'the refused row is not in the registry');
    assert.equal(await readSettings(), null, 'and nothing was written to the store');
  });

  // PINS: the refusal carries the provider's own diagnosis rather than a
  // generic "unreachable" — the user has to know WHICH thing failed.
  test('the refusal quotes the provider verbatim', async () => {
    let err = null;
    try {
      await addSystem({
        id: 'noisy', label: 'Noisy',
        launch: ['node', '-e', 'process.stderr.write("no docker socket here"); process.exit(1)'],
      });
    } catch (e) { err = e; }
    assert.ok(err, 'a provider that dies during the handshake is a refusal');
    assert.match(err.message, /no docker socket here/);
  });

  // PINS: a row is allowed to carry no provider command (P2's registration-only
  // shape survives), and resolving a system through such a row refuses BY NAME
  // rather than falling back to local.
  test('a row with no launch stays legal, and refuses by name at resolution', async () => {
    await addSystem({ id: 'namedonly', label: 'Named only' });
    assert.equal('launch' in getSystem('namedonly'), false);
    await assert.rejects(
      () => systemById('namedonly', null, `project 'p'`),
      (e) => e.statusCode === 501 && /no provider command/.test(e.message),
    );
  });

  // PINS: an id with no row at all is a DIFFERENT refusal from a row with no
  // command — the two need different repairs.
  test('an unregistered id refuses distinctly from a command-less row', async () => {
    await assert.rejects(
      () => systemById('ghost', null, `project 'p'`),
      (e) => e.statusCode === 501 && /not in the system registry/.test(e.message),
    );
  });

  // PINS: resolution hands back a live handle that really speaks the protocol.
  test('a reachable row resolves to a working System handle', async () => {
    await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    const sys = await systemById('refbox', null, `project 'p'`);
    assert.equal(sys.id, 'refbox');
    const r = await sys.exec({ argv: ['printf', 'hello'] }, { cwd: home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'hello');
  });

  // PINS: the handle is one connection per id — resolving twice does not start
  // a second provider process claiming to be the same machine.
  test('two resolutions of one id share one handle', async () => {
    await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    const a = await systemById('refbox', null, 'x');
    const b = await systemById('refbox', null, 'y');
    assert.equal(a, b);
  });

  // PINS: changing the provider command re-probes it and replaces the handle,
  // so the old process cannot keep serving the new configuration.
  test('editing the launch re-verifies it and replaces the live handle', async () => {
    await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    const before = await systemById('refbox', null, 'x');
    await assert.rejects(
      () => updateSystem('refbox', { launch: ['node', '-e', 'process.exit(4)'] }),
      (e) => e.statusCode === 502,
    );
    assert.deepEqual(getSystem('refbox').launch, referenceLaunch(), 'a refused edit changes nothing');

    await updateSystem('refbox', { launch: referenceLaunch('--name', 'renamed') });
    const after = await systemById('refbox', null, 'x');
    assert.notEqual(after, before, 'the handle built from the old command is gone');
    assert.equal((await after.exec({ argv: ['printf', 'ok'] }, { cwd: home })).stdout, 'ok');
  });

  // PINS: a relabel does not re-probe — a system that is down must still be
  // renameable.
  test('a label-only edit does not touch the provider', async () => {
    // Seeded before this fixture's first appSettings call (the cache is keyed
    // by settings path and is cold exactly once per fresh projects root), so
    // the row carries a command no probe could ever pass. A relabel that
    // re-probed would fail and the rename would be lost.
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    await fs.writeFile(settingsFile(), JSON.stringify({
      systems: { registry: [{ id: 'downbox', label: 'Down', launch: ['definitely-not-a-binary'] }] },
    }));
    const rec = await updateSystem('downbox', { label: 'Renamed' });
    assert.equal(rec.label, 'Renamed');
    assert.deepEqual(rec.launch, ['definitely-not-a-binary'], 'the command is kept, not re-verified');
  });

  // PINS: launch shape validation is a 400, distinct from unreachability's 502.
  test('a malformed launch is a 400, before anything is spawned', async () => {
    for (const bad of [[], ['ok', 42], [''], 'node script.js']) {
      await assert.rejects(
        () => addSystem({ id: 'x', label: 'X', launch: bad }),
        (e) => e.statusCode === 400 && /launch must be/.test(e.message),
        `rejected: ${JSON.stringify(bad)}`,
      );
    }
  });

  // PINS: `local` is in-process and takes no provider command.
  test('the managed local row has no launch and refuses to be given one', async () => {
    assert.equal('launch' in getSystem(LOCAL_SYSTEM_ID), false);
    await assert.rejects(
      () => updateSystem(LOCAL_SYSTEM_ID, { launch: referenceLaunch() }),
      (e) => e.statusCode === 400 && /built in/.test(e.message),
    );
  });

  // PINS: removing a row shuts its provider down — the next resolution of that
  // id must not be answered by a process belonging to a row that is gone.
  test('removing a row drops its handle', async () => {
    await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    const before = await systemById('refbox', null, 'x');
    await removeSystem('refbox');
    assert.equal(getSystems().some(s => s.id === 'refbox'), false);
    await assert.rejects(() => systemById('refbox', null, 'x'), (e) => e.statusCode === 501);
    await addSystem({ id: 'refbox', label: 'Again', launch: referenceLaunch() });
    assert.notEqual(await systemById('refbox', null, 'x'), before);
  });
});

describe('the session-root placement check', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS: registration is refused when an ancestor of where this system's local
  // session directories would live is a git repository.
  test('a store inside a git repo refuses the registration, naming the repo', async () => {
    // The store lives under the projects root; make the projects root a repo.
    const root = process.env.PROJECTS_ROOT;
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await assert.rejects(
      () => addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() }),
      (e) => e.statusCode === 400 && e.message.includes(root) && /git repository/.test(e.message),
    );
    assert.equal(getSystem('refbox'), null, 'and the row is not saved');
  });

  // PINS: the check tests EXISTENCE of `.git`, not its kind — inside a git
  // worktree `.git` is a file, and the CLI's upward probe stops at it just the
  // same.
  test('a `.git` FILE (a worktree checkout) refuses too', async () => {
    const root = process.env.PROJECTS_ROOT;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/w\n');
    await assert.rejects(
      () => addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() }),
      (e) => e.statusCode === 400 && /git repository/.test(e.message),
    );
  });

  // PINS: the check is scoped to the session-roots path — a repo that is NOT an
  // ancestor of it (a project inside the projects root, which is the normal
  // case) does not refuse.
  test('a git repo that is not an ancestor does not refuse', async () => {
    await fs.mkdir(path.join(process.env.PROJECTS_ROOT, 'someproject', '.git'), { recursive: true });
    const rec = await addSystem({ id: 'refbox', label: 'Reference', launch: referenceLaunch() });
    assert.equal(rec.id, 'refbox');
  });

  // PINS: the path the check defends is the one a session root would use.
  test('session roots are keyed per system under cc\'s own store', () => {
    assert.equal(sessionRootsDir('prod-box'), path.join(orchStoreRoot(), 'systems', 'prod-box', 'sessions'));
    assert.notEqual(sessionRootsDir('a'), sessionRootsDir('b'),
      'two systems hosting a project at the same path cannot collide on one local directory');
  });
});
