// GET /api/projects/:name/location — where a project lives, read off its stored
// record ALONE. The point of the route is what it does NOT do: it answers from
// the record, so a caller needing only the placement never pays for the git
// facts GET /api/projects computes for every project.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import dc from 'node:diagnostics_channel';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { registerProject } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';

const locationUrl = name => `/api/projects/${name}/location`;

// Counts every way work could reach a system: the three provider primitives
// (every remote operation is one of them, and bound views share the prototype),
// the local system's exec, and any child process spawned at all.
function installWorkCounters() {
  const counts = { providerOps: 0, localExec: 0, spawns: 0 };
  const restores = [];
  for (const [proto, method, key] of [
    [ProviderSystem.prototype, 'exec', 'providerOps'],
    [ProviderSystem.prototype, 'readFile', 'providerOps'],
    [ProviderSystem.prototype, 'writeFile', 'providerOps'],
    [LocalSystem.prototype, 'exec', 'localExec'],
  ]) {
    const real = proto[method];
    proto[method] = function (...args) { counts[key]++; return real.apply(this, args); };
    restores.push(() => { proto[method] = real; });
  }
  const channel = dc.channel('child_process');
  const onSpawn = () => { counts.spawns++; };
  channel.subscribe(onSpawn);
  restores.push(() => channel.unsubscribe(onSpawn));
  return { counts, restore() { for (const r of restores) r(); } };
}

describe('GET /api/projects/:name/location', () => {
  let ctx, baseUrl, home, remote, root;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    root = await fs.realpath(await mkdtemp('cc-loc-remote-'));
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${root}`] });
  });
  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // PINS: a local project's placement is its stored path under system 'local'
  // with no target, and the answer comes from the record — the directory it
  // names has been removed, so nothing on disk could have produced it.
  test('a local project answers from its record, with its tree gone', async () => {
    const dir = await mkdtemp('cc-loc-local-');
    await registerLocalProject('app', dir);
    await rmrf(dir);

    const r = await api(baseUrl, 'GET', locationUrl('app'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { name: 'app', system: 'local', remoteId: null, path: dir });
  });

  // PINS: a remote project on the provider's default target reports the system
  // and a null remoteId — the default is absence of a target, not a named one.
  test('a remote project on the default target reports remoteId null', async () => {
    const dir = path.join(root, 'rdefault');
    await registerProject('rdefault', { kind: 'remote', system: remote.id, remoteId: null, path: dir });

    const r = await api(baseUrl, 'GET', locationUrl('rdefault'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { name: 'rdefault', system: remote.id, remoteId: null, path: dir });
  });

  // PINS: a named target is carried through unchanged, so a project on one of
  // several targets of a system is distinguishable from the default.
  test('a remote project on a named target reports that remoteId', async () => {
    const dir = path.join(root, 'rnamed');
    await registerProject('rnamed', { kind: 'remote', system: remote.id, remoteId: 'a', path: dir });

    const r = await api(baseUrl, 'GET', locationUrl('rnamed'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remoteId, 'a');
    assert.equal(r.body.system, remote.id);
    assert.equal(r.body.path, dir);
  });

  // PINS: a name no record holds is refused 404 with the same PROJECT_UNKNOWN
  // code GET /api/projects/:name gives, so a caller branches on one code.
  test('an unregistered name is refused 404 PROJECT_UNKNOWN', async () => {
    const r = await api(baseUrl, 'GET', locationUrl('nope'));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'PROJECT_UNKNOWN');
    assert.equal(typeof r.body.error, 'string');
  });

  // PINS: a malformed name is refused 400 with the INVALID_ARGUMENT code, not
  // just the status — the code is what a caller branches on.
  test('a malformed name is refused 400 INVALID_ARGUMENT', async () => {
    const r = await api(baseUrl, 'GET', locationUrl('bad%20name'));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_ARGUMENT');
  });

  // PINS: reading a placement runs nothing on any system — no provider primitive,
  // no local exec, no child process — while the same counters see GET
  // /api/projects do real work, so the zeros are not a blind read.
  test('reading a placement runs nothing on any system', async () => {
    const localDir = await mkdtemp('cc-loc-count-');
    await registerLocalProject('app', localDir);
    await registerProject('rdefault', { kind: 'remote', system: remote.id, remoteId: null, path: path.join(root, 'rdefault') });
    await registerProject('rnamed', { kind: 'remote', system: remote.id, remoteId: 'a', path: path.join(root, 'rnamed') });
    // Dispose first: any touch of the remote would have to launch its provider.
    disposeSystemHandles();

    const work = installWorkCounters();
    try {
      for (const name of ['app', 'rdefault', 'rnamed']) {
        const r = await api(baseUrl, 'GET', locationUrl(name));
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      assert.deepEqual(work.counts, { providerOps: 0, localExec: 0, spawns: 0 },
        'the location route must not reach any system or spawn anything');

      // POSITIVE CONTROL: the list endpoint does run system work, so the counters
      // above can see it when it happens.
      const list = await api(baseUrl, 'GET', '/api/projects');
      assert.equal(list.status, 200);
      assert.ok(work.counts.providerOps + work.counts.localExec + work.counts.spawns > 0,
        'positive control: GET /api/projects must register against the counters');
    } finally {
      work.restore();
    }
  });
});
