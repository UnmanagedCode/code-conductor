// One spawn body, one spawn implementation: New conductor's body lives in
// shared/newConductor.ts, and POST /api/instances and the headless runner both
// spawn through spawnFromBody (src/spawnRequest.ts).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { newConductorSpawnBody } from '../shared/newConductor.ts';
import { spawnFromBody } from '../src/spawnRequest.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

const SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-basic.json');

let server, home;
before(async () => { server = await bootServer({ scenarioPath: SCENARIO }); });
after(async () => { await server.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await server.instances.shutdown(); await rmrf(home); });

test('the New-conductor body names the conduct project, the conductor role, a pristine temp spawn', () => {
  assert.equal(newConductorSpawnBody('code').project, CONDUCT_PROJECT_NAME);
  assert.deepEqual(newConductorSpawnBody('code'),
    { project: CONDUCT_PROJECT_NAME, role: 'conductor', temp: true, mode: 'bypassPermissions', pristine: true });
  assert.deepEqual(newConductorSpawnBody('plan'),
    { project: CONDUCT_PROJECT_NAME, role: 'conductor', temp: true, mode: 'plan', pristine: true });
});

test('spawnFromBody spawns what the route spawns for the same body', async () => {
  const viaRoute = await api(server.baseUrl, 'POST', '/api/instances', newConductorSpawnBody('plan'));
  assert.equal(viaRoute.status, 201, JSON.stringify(viaRoute.body));
  const direct = await spawnFromBody(server.instances, newConductorSpawnBody('plan'));
  const routed = server.instances.get(viaRoute.body.id);
  for (const inst of [routed, direct]) {
    assert.equal(inst.project, CONDUCT_PROJECT_NAME);
    assert.equal(inst.temp, true);
    assert.equal(inst.pristine, true);
    assert.equal(inst.mode, 'plan');
  }
  assert.equal(direct.model, routed.model, 'both resolve the same Settings → Models row');
  assert.equal(direct.backend, routed.backend);
  await waitFor(() => direct.status === 'idle');
});

test('spawnFromBody maps a temp spawn with no mode to bypassPermissions', async () => {
  const inst = await spawnFromBody(server.instances, { project: CONDUCT_PROJECT_NAME, role: 'conductor', temp: true });
  assert.equal(inst.mode, 'bypassPermissions');
});

test('spawnFromBody refuses pristine off a fresh conduct temp spawn with the route\'s code', async () => {
  await assert.rejects(
    spawnFromBody(server.instances, { ...newConductorSpawnBody('code'), resume: 'deadbeef' }),
    (e) => e.statusCode === 400 && e.code === 'PRISTINE_NOT_FRESH_CONDUCTOR',
  );
});

test('spawnFromBody refuses an unknown playbookEnforcement with a 400, before any spawn', async () => {
  const before = server.instances.byId.size;
  await assert.rejects(
    spawnFromBody(server.instances, { ...newConductorSpawnBody('code'), playbookEnforcement: 'nope' }),
    (e) => e.statusCode === 400 && /playbookEnforcement must be one of/.test(e.message),
  );
  assert.equal(server.instances.byId.size, before);
  const res = await api(server.baseUrl, 'POST', '/api/instances', { ...newConductorSpawnBody('code'), playbookEnforcement: 'nope' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /playbookEnforcement must be one of/);
});
