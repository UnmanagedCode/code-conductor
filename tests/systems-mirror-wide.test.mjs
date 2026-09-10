// A MIRROR ROOT WIDER THAN THE PROJECT, after the FUSE-union geometry.
//
// This file replaces two whose subject was deleted with the file bridge, and it
// carries their surviving claims rather than dropping them:
//
//   * `systems-mirror-instance.test.mjs` asked whether a live session works "one
//     level inside the image" — the CLI's cwd was `imageRoot + offset` under a
//     wide advertisement. There is no image and no offset; the surviving claim
//     is that a wide advertisement does not move the session, which is asserted
//     below and again in systems-mirror-geometry-cold-resume.
//   * `systems-mirror-bridge.test.mjs` asked whether an out-of-project path was
//     pulled, edited and pushed back over the bridge, and whether two system
//     paths could collide on one local path. Both questions presuppose a local
//     image; the surviving claim is that the wider slice is REACHABLE, which is
//     now decided by the union's tier table rather than by a path map.
//     fileBridge's two carried semantics — mode preservation and sticky
//     divergence — are recorded in docs/architecture.md as S3's specification.
//
// WHAT IS ACTUALLY NEW HERE: `mirrorRoot` is the boundary of the union's REMOTE
// tier. Widening it moves what is served from the system rather than what is
// copied to cc, and the project keeps its own narrower entry inside it.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { buildTierTable, resolveTierEntry } from '../src/systems/fuse/tierTable.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');

const tierOf = (entries, p) => {
  let best = null;
  for (const e of entries) {
    if ((p === e.prefix || p.startsWith(e.prefix.endsWith('/') ? e.prefix : e.prefix + '/'))
      && (best === null || e.prefix.length > best.prefix.length)) best = e;
  }
  return best?.tier ?? null;
};

describe('a mirror root wider than the project', () => {
  let ctx, baseUrl, instances, home, n = 0;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
  after(async () => { if (ctx) await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // PINS: a wide advertisement does not move the session, and composes no local
  // image for it to be moved into. The old behaviour — cwd = imageRoot + offset,
  // with the project one level inside — is exactly what criterion 8 removed.
  test('the session still runs at the project path, and nothing is composed', async () => {
    const id = `wide${++n}`;
    const box = await fs.realpath(await mkdtemp('cc-wide-'));
    const tree = await seedRepo(path.join(box, 'nest', 'app'));
    await fs.writeFile(path.join(box, 'OUT-OF-PROJECT.txt'), 'outside\n');
    const mirrorFile = path.join(box, '.mirror');
    await fs.writeFile(mirrorFile, box);          // the WIDE root
    await addSystem({ id, label: id, launch: ['node', FIXTURE, '--mirror-file', mirrorFile] });
    assert.equal((await adoptProject('app', tree, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');

    assert.equal(inst.cwd, tree, 'a wide mirror root moved the CLI off the project');
    assert.equal(inst._mirrorScope.mirrorRoot, box, 'the wide root was not pinned for the session');
    assert.equal(await fs.stat(path.join(orchStoreRoot(), 'systems', id, 'sessions'))
      .then(() => true, () => false), false, 'a local image was composed');
    // The shell still runs at the project, not at the mirror root — widening
    // decides what is REACHABLE, never where a command starts.
    assert.equal(inst._redirect.systemPath, tree);
  });

  // A13 — PINS criterion 4's third clause on the channel it is reported
  // through: an advertised exclude OUTSIDE the mirror root is INERT — the spawn
  // succeeds — and it is REPORTED ONCE on the session's own stream, which is
  // where the rest of this subsystem's non-fatal news goes. Turning `inert` into
  // a refusal breaks the spawn; dropping the emission leaves an operator who
  // wrote a no-op exclude with no way to learn it.
  test('an exclude outside the mirror root is inert, and reported once on the session stream', async () => {
    const id = `inert${++n}`;
    const box = await fs.realpath(await mkdtemp('cc-inert-'));
    const tree = await seedRepo(path.join(box, 'nest', 'app'));
    const mirrorFile = path.join(box, '.mirror');
    await fs.writeFile(mirrorFile, path.join(box, 'nest'));   // narrower than `box`
    await addSystem({ id, label: id, launch: ['node', FIXTURE,
      '--mirror-file', mirrorFile, '--advertise-exclude', '/var/lib/elsewhere'] });
    assert.equal((await adoptProject('app', tree, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');

    const lines = inst.ring.toArray()
      .filter(ev => ev.kind === 'system' && ev.subtype === 'stderr')
      .map(ev => ev.data?.line ?? '')
      .filter(l => l.includes('/var/lib/elsewhere'));
    assert.equal(lines.length, 1, `expected exactly one inert report, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /outside its mirror root/);
    assert.match(lines[0], /no effect/);
    // …and it really was inert: the exclude is still pinned for the session, and
    // the session came up.
    assert.deepEqual(inst._mirrorScope.exclude, ['/var/lib/elsewhere']);
  });

  // PINS: the wider slice is reachable because the TIER TABLE says so, and the
  // project keeps its own narrower entry inside it. Both are `project` tier —
  // remote only, no host fallback — so a path between the two is served from the
  // system rather than quietly from the orchestrator.
  test('the advertised root becomes the remote tier boundary, with the project inside it', () => {
    const entries = buildTierTable({
      localRoots: [], claudeCommand: '', execPath: '/usr/bin/node',
      selfProjectDir: '/repo', projectsRoot: '/projects', homeDir: '/home/u',
      runDir: '/projects/.code-conductor/systems/fuse/run/i1',
      systemPath: '/box/nest/app', mirrorRoot: '/box', exclude: [],
    });
    assert.equal(tierOf(entries, '/box/nest/app/src/main.js'), 'project');
    assert.equal(tierOf(entries, '/box/OUT-OF-PROJECT.txt'), 'project',
      'a path inside the advertised root but outside the project is not served from the system');
    // A NARROW advertisement is the control: the same out-of-project path then
    // belongs to no tier at all.
    const narrow = buildTierTable({
      localRoots: [], claudeCommand: '', execPath: '/usr/bin/node',
      selfProjectDir: '/repo', projectsRoot: '/projects', homeDir: '/home/u',
      runDir: '/projects/.code-conductor/systems/fuse/run/i1',
      systemPath: '/box/nest/app', mirrorRoot: '/box/nest/app', exclude: [],
    });
    assert.equal(tierOf(narrow, '/box/nest/app/src/main.js'), 'project');
    assert.equal(tierOf(narrow, '/box/OUT-OF-PROJECT.txt'), null);
  });

  // PINS: THE INPUT TO CARD 2026-0388'S REGRESSION. Under `mirrorRoot: '/'`
  // `buildTierTable` emits a `project /` pin, so every UNPINNED INTERMEDIATE
  // DIRECTORY — /bin, /usr/lib, /etc, /root — resolves `project` instead of
  // being derived as a synthetic ancestor, while the exact host pins inside them
  // keep their own tier. That collapse is what left an unmarked `chroot` unable
  // to resolve /bin, and it is why no pin can fix it: the parent of every pinned
  // library is project too.
  //
  // Kept as a TABLE case with no mount so the policy fix cannot be read as
  // addressing a table that no longer produces the case. Read through
  // `resolveTierEntry` — the function the daemon's own pins file is rendered
  // from — rather than this file's local `tierOf`, so the two cannot diverge.
  test('a wide advertisement swallows every unpinned intermediate directory', () => {
    const input = {
      localRoots: [], claudeCommand: '', execPath: '/usr/bin/node',
      selfProjectDir: '/repo', projectsRoot: '/projects', homeDir: '/home/u',
      runDir: '/projects/.code-conductor/systems/fuse/run/i1',
      systemPath: '/box/nest/app', exclude: [],
    };
    const wide = buildTierTable({ ...input, mirrorRoot: '/' });
    const at = (entries, p) => resolveTierEntry(entries, p)?.tier ?? null;

    for (const p of ['/', '/bin', '/usr', '/usr/lib', '/etc', '/root'])
      assert.equal(at(wide, p), 'project',
        `${p} is not project tier under a wide root — the regression's input is gone`);
    // …while the exact host pins INSIDE those directories keep their own tier,
    // which is why the failure is multiply determined rather than one bad pin.
    assert.equal(at(wide, '/bin/sh'), 'host');
    assert.equal(at(wide, '/etc/hosts'), 'host');

    // THE NARROW CONTROL: the same intermediate paths belong to no tier at all,
    // so the daemon derives them as synthetic ancestors and an unmarked caller
    // is never asked the project question there.
    const narrowRoot = buildTierTable({ ...input, mirrorRoot: '/box/nest/app' });
    for (const p of ['/bin', '/usr/lib', '/etc', '/root'])
      assert.equal(at(narrowRoot, p), null,
        `${p} already answers a tier under the DEFAULT root — the control is vacuous`);
  });
});
