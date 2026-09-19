// A COLD RESUME OF A REMOTE SESSION, AFTER THE FUSE-UNION GEOMETRY.
//
// There is no candidate-set scan, and the reason is one line: a remote
// session's cwd is the project's real path on its system, which does not move.
// There is one candidate, it is fixed at registration, and the whole search
// space is that one path. `mirrorOffsets` — an enumerator over cwds a session
// could have been left at when its cc-owned local session root sat at
// `imageRoot + offset`, and the "the candidate set is COMPLETE" argument that
// licensed stopping at the first hit — does not exist, and nothing relocates a
// transcript.
//
// What this file pins is the geometry that makes the scan unnecessary: a cold
// resume finds the session at
// the project's path and nothing has to move, INCLUDING across an orchestrator
// restart, which is the path with nothing in memory to help it. The
// session-fatal refusal that replaced the LIVE follow is pinned in
// tests/systems-mirror-geometry-follow.test.mjs.
//
// FIXTURE FACT: `bootServer` here uses the in-process launcher, so `status`
// reaching `idle` really does mean a session exists; the arms below assert on
// cwd and on the resolved location rather than on a pid.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, findSessionLocation, orchStoreRoot} from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');

describe('a cold resume of a remote session', () => {
  let ctx, baseUrl, instances, home, claudeProjectsRoot, n = 0;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
  after(async () => { if (ctx) await ctx.close(); });
  beforeEach(async () => { ({ home, claudeProjectsRoot } = await freshProjectsRoot()); });
  afterEach(async () => {
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  const exists = (p) => fs.stat(p).then(() => true, () => false);

  // `mirror` is what the provider advertises: '' for nothing at all, or a
  // subpath of the box. Both are exercised, because the point is that NEITHER
  // changes where the session runs any more.
  async function fixture({ sub = 'proj', mirror = '' } = {}) {
    const id = `movable${++n}`;
    const project = `app${n}`;
    const box = await mkdtemp('cc-0287-');
    const projPath = path.join(box, sub);
    await seedRepo(projPath);
    const mirrorFile = path.join(box, '.mirror');
    await fs.writeFile(mirrorFile, mirror === '' ? '' : path.join(box, mirror));
    await addSystem({ id, label: id, launch: ['node', FIXTURE, '--mirror-file', mirrorFile] });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    // The in-process launcher writes no transcript, and findSessionLocation
    // probes for one — seeded at the cwd the session actually has, so a locator
    // that looked anywhere else would find nothing rather than agree by luck.
    await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId);
    return { id, project, box, projPath, mirrorFile, inst };
  }

  // PINS CRITERION 8 AT THE LOCATOR: a remote session is located at the
  // project's real path on its system, and no session root is composed under the
  // store for it to be located at instead.
  test('a remote session is located at the project path on its system', async () => {
    const f = await fixture();
    assert.equal(f.inst.cwd, f.projPath);

    const hit = await findSessionLocation(f.inst.backingSessionId);
    assert.ok(hit, 'the session was not located at all');
    assert.equal(hit.project, f.project);
    assert.equal(hit.cwd, f.projPath, 'located somewhere other than the project path');
    assert.equal(await exists(path.join(orchStoreRoot(), 'systems', f.id, 'sessions')), false,
      'a session root was composed under the store');
  });

  // PINS: a WIDER advertisement does not move the session. Under the old
  // geometry this was the whole subject of this file — the cwd was
  // `imageRoot + offset` and a wider root produced a different offset. The cwd
  // is now the project's own path, which an advertisement cannot address.
  test('a wider advertisement does not change where the session runs', async () => {
    const f = await fixture({ sub: 'a/proj', mirror: '.' });
    assert.equal(f.inst.cwd, f.projPath, 'a wide mirror root moved the cwd');
    const hit = await findSessionLocation(f.inst.backingSessionId);
    assert.equal(hit?.cwd, f.projPath);
  });

  // PINS THE COLD PATH, which is the one the deleted candidate scan existed to
  // serve: with NOTHING in the orchestrator's memory — the instance dropped, as
  // it is after a restart — the session still resolves, from the store and the
  // transcript alone, at the project's path. A resume then goes to the right
  // place with no relocation to perform.
  test('a session with nothing left in memory still resolves at the project path', async () => {
    const f = await fixture();
    const backingId = f.inst.backingSessionId;
    await f.inst.kill({ graceMs: 100 });
    instances.byId.delete(f.inst.id);
    assert.equal(instances.get(f.inst.id), undefined, 'the instance is really gone from memory');

    const hit = await findSessionLocation(backingId);
    assert.ok(hit, 'a cold session could not be located');
    assert.equal(hit.project, f.project);
    assert.equal(hit.cwd, f.projPath);
    assert.equal(hit.worktreeName, null);

    // And a resume at that place is accepted rather than refused.
    const r = await api(baseUrl, 'POST', '/api/instances', { project: f.project, resume: backingId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id).cwd, f.projPath);
  });

  // PINS: a bogus resume id still refuses, and the refusal names the cwd it
  // looked in — the project's path. The old refusal named a session root, and a
  // resume that quietly succeeded at the wrong place is the failure this guards.
  test('an unknown resume id refuses, naming the project path it looked in', async () => {
    const f = await fixture();
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: f.project, resume: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(f.projPath.replace(/[.*+?^$()|[\]\\]/g, '\\$&')));
  });
});
