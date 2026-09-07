// CRITERION 5'S OWN PIN, AND IT DOES NOT MOUNT.
//
// A re-advertised mirror geometry is session-fatal, and the refusal that says
// so (`501 MIRROR_ADVERTISEMENT_CHANGED`, src/instances.ts) rests today on
// tests/systems-mirror-geometry-follow.test.mjs — the ONLY file in `npm test`
// that mounts for real. Open card 2026-0370 records a 2-in-5 contention flake
// there whose tell is a varying arm pair: `gate:systems` runs two whole-suite
// rows concurrently, both mount, and they contend. THE FAILURE LANDS UPSTREAM
// OF THE GEOMETRY ASSERTION — the arm dies in its fixture before it ever
// reaches the refusal — and a 2-in-5 arm is not evidence for a gate criterion.
//
// THE REFUSAL NEEDS NO MOUNT. `Instance.launch` runs the comparison BEFORE
// `assertFuseAvailable`, `prepare()` and `spawn()`, and `attachFuse` is gated
// on `!inst._launcher.inProcess` — so `bootServer()`'s in-process launcher
// exercises the whole comparison with no daemon, no sudo, no `/dev/fuse` and no
// contention with 2026-0370.
//
// THE MOUNTING ARMS STAY as the integration coverage. A green pair here beside
// a flaking arm there is also the diagnostic that 2026-0370 is contention and
// not the refusal. 2026-0370 IS NOT FIXED HERE.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');

describe('criterion 5 — a re-advertised geometry is session-fatal, without mounting', () => {
  let ctx, baseUrl, instances, home;
  let n = 0;

  before(async () => {
    // NO `realProcess`, and that is the whole point of this file: the
    // in-process launcher means `attachFuse` never runs.
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // One system, one project, one box, per arm. `mirror` and `exclude` are both
  // held in FILES the provider reads once at startup, so a restart — and only
  // a restart — can change either.
  async function fixture({ mirror = '', exclude = [] } = {}) {
    const id = `advert${++n}`;
    const project = `pinapp${n}`;
    const box = await mkdtemp('cc-0356-c5-');
    const projPath = path.join(box, 'proj');
    await seedRepo(projPath);

    const mirrorFile = path.join(box, '.mirror');
    const excludeFile = path.join(box, '.exclude');
    const pidFile = path.join(box, '.pid');
    await fs.writeFile(mirrorFile, mirror === '' ? '' : path.join(box, mirror));
    await fs.writeFile(excludeFile, exclude.map(rel => path.join(box, rel)).join('\n'));
    await addSystem({
      id, label: id,
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile,
        '--exclude-file', excludeFile, '--pid-file', pidFile],
    });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    // THE PREMISE THIS FILE RESTS ON, asserted rather than assumed: no mount
    // was made, so a red arm here cannot be a mount problem.
    assert.equal(inst._fuse ?? null, null, 'this arm mounted — the whole no-contention claim is void');
    assert.ok(inst._mirrorScope, 'the advertisement was never pinned, so there is nothing to compare against');
    return { id, project, box, projPath, mirrorFile, excludeFile, pidFile, inst };
  }

  // End the provider's connection generation and start a new one that answers
  // differently. ONLY a new generation can move the advertisement — cc memoises
  // `describeRemote` on handshake identity — so this is the only way a live
  // session ever sees a different answer.
  async function readvertise(f, { mirror, exclude }) {
    if (mirror !== undefined) {
      await fs.writeFile(f.mirrorFile, mirror === '' ? '' : path.join(f.box, mirror));
    }
    if (exclude !== undefined) {
      await fs.writeFile(f.excludeFile, exclude.map(rel => path.join(f.box, rel)).join('\n'));
    }
    const system = f.inst._redirectPlacement.system;
    const generation = system.handshake;
    const gone = Number(await fs.readFile(f.pidFile, 'utf8'));
    // The fixture IS the provider — one process, no child to orphan.
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    await waitFor(() => system.handshake === null);
    await system.connect();
    assert.notEqual(system.handshake, generation, 'a new connection generation really began');
  }

  const respawn = async (inst) => {
    await inst.kill({ graceMs: 200 });
    return api(baseUrl, 'POST', `/api/instances/${inst.id}/respawn`);
  };

  // PINS: criterion 5 itself, with no mount — a moved mirror ROOT refuses the
  // next relaunch by name, naming both geometries, and the session does not
  // half-apply the move.
  // DIES UNDER: deleting the `scope.mirrorRoot !== pinned.mirrorRoot`
  // comparison; reading the advertisement live instead of the pinned scope.
  test('T28: a moved mirror ROOT refuses the relaunch 501 MIRROR_ADVERTISEMENT_CHANGED', async () => {
    const f = await fixture({ mirror: '' });
    const before = f.inst.cwd;
    assert.equal(before, f.projPath, "the session started at the project's own path");
    // '.' joins to the box itself — a root WIDER than the project.
    await readvertise(f, { mirror: '.' });

    const r = await respawn(f.inst);
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(r.body.error, /changed its mirror advertisement/);
    assert.match(r.body.error, new RegExp(f.box.replace(/[.*+?^$()|[\]\\]/g, '\\$&')),
      'the refusal does not name the geometry it moved to');
    assert.equal(f.inst.cwd, before, 'the session moved anyway');

    // AT THE MANAGER ENTRY POINT TOO, which is what every other relaunch
    // caller reaches directly and where the machine-readable code survives.
    await assert.rejects(() => instances.respawn(f.inst.id),
      (e) => e.code === 'MIRROR_ADVERTISEMENT_CHANGED' && e.statusCode === 501);
  });

  // PINS: THE HALF NOTHING PINNED BEFORE — a changed `exclude` list at an
  // UNCHANGED root refuses too. Every arm in the mounting file changes only the
  // root, so a mutant dropping the `exclude.join(...)` clause survived the
  // entire suite.
  // DIES UNDER: dropping the exclude comparison from src/instances.ts.
  test('T29: a changed EXCLUDE list at an unchanged root refuses too', async () => {
    // A wide root, so the excludes are inside it and therefore live.
    const f = await fixture({ mirror: '.', exclude: ['proj/secrets'] });
    const pinnedRoot = f.inst._mirrorScope.mirrorRoot;
    assert.deepEqual(f.inst._mirrorScope.exclude, [path.join(f.box, 'proj/secrets')],
      'the first advertisement carried no exclude, so changing it changes nothing');

    await readvertise(f, { exclude: ['proj/secrets', 'proj/other'] });
    // THE ROOT IS THE CONTROL: it must be UNCHANGED, or this arm is T28 again.
    const scope = f.inst._redirectPlacement.system;
    assert.equal((await scope.mirror()).mirrorRoot, pinnedRoot,
      'the root moved as well — this arm no longer isolates the exclude clause');

    const r = await respawn(f.inst);
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(r.body.error, /changed its mirror advertisement/);
    // The message names the exclude lists on both sides, which is the only
    // thing telling an operator WHICH half moved. The FULL path, not the
    // basename: `other` alone would also match a temp directory's own name.
    const appeared = path.join(f.box, 'proj/other');
    assert.match(r.body.error, new RegExp(appeared.replace(/[.*+?^$()|[\]\\]/g, '\\$&')),
      'the refusal does not name the exclude that appeared');
    // AND THE ROOT IS REPORTED UNCHANGED on both sides of the arrow, so the
    // message cannot be read as a root move.
    assert.match(r.body.error, new RegExp(`root '${pinnedRoot.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}' → `
      + `'${pinnedRoot.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}'`),
      'the refusal reports two different roots, so this arm did not isolate the exclude clause');
  });

  // PINS: the control that makes both arms about the CHANGE rather than about
  // relaunching at all — an UNCHANGED advertisement relaunches normally,
  // through the very same comparison and the very same restart.
  // DIES UNDER: refusing every relaunch of a remote session (both arms above
  // would still pass).
  test('T29b control: an unchanged advertisement relaunches normally', async () => {
    const f = await fixture({ mirror: '.', exclude: ['proj/secrets'] });
    await readvertise(f, {});
    const r = await respawn(f.inst);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(f.inst.cwd, f.projPath);
  });
});
