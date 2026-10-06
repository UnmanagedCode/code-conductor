// Platform.capabilities: a feature the host platform turns off is refused at its
// chokepoints with a stable code, and the local path is untouched.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { posixPlatform } from '../src/platform/posix.ts';
import { sweepFuseLeftovers } from '../server.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';

const SCENARIO = new URL('./fixtures/scenario-instance.json', import.meta.url).pathname;

const OFF = { remoteSystems: false, fuseUnion: false, voice: false };
const platformWith = (capabilities) => ({ ...posixPlatform, capabilities });

test('the boot sweep is skipped with fuseUnion off and runs with it on', async () => {
  let calls = 0;
  const sweep = async () => { calls++; };
  await sweepFuseLeftovers(platformWith(OFF), sweep);
  assert.equal(calls, 0);
  await sweepFuseLeftovers(posixPlatform, sweep);
  assert.equal(calls, 1, 'positive control: the same call sweeps on POSIX');
});

describe('every capability off', () => {
  let ctx, baseUrl, home;
  let rpcId = 0;
  before(async () => {
    ctx = await bootServer({ scenarioPath: SCENARIO, platform: platformWith(OFF) });
    baseUrl = ctx.baseUrl;
    ({ home } = await freshProjectsRoot());
  });
  after(async () => {
    await ctx.instances.shutdown();
    if (home) await rmrf(home);
    await ctx.close();
  });

  async function rpc(method, params) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return res.json();
  }

  test('GET /api/health reports the flags', async () => {
    const r = await api(baseUrl, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.capabilities, OFF);
  });

  test('the systems routes are refused 501 SYSTEMS_UNAVAILABLE', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/settings/systems'],
      ['POST', '/api/settings/systems', { id: 'box', label: 'Box', launch: ['x'] }],
      ['PUT', '/api/projects/x/remote', { remoteId: 'r' }],
      ['GET', '/api/systems/x/remotes'],
      ['POST', '/api/projects', { name: 'remote1', system: 'box', systemPath: '/srv/x' }],
    ]) {
      const r = await api(baseUrl, method, url, body);
      assert.equal(r.status, 501, `${method} ${url}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SYSTEMS_UNAVAILABLE');
    }
  });

  test('adopting onto a system is a 200 soft refusal', async () => {
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: 'r', path: '/srv/x', system: 'box' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'SYSTEMS_UNAVAILABLE');
  });

  test('the voice routes are refused 501 VOICE_UNAVAILABLE', async () => {
    for (const [method, url] of [
      ['POST', '/api/settings/transcribe/install'],
      ['POST', '/api/settings/tts/install'],
      ['POST', '/api/tts'],
      ['GET', '/api/transcribe/status'],
    ]) {
      const r = await api(baseUrl, method, url, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 501, `${method} ${url}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'VOICE_UNAVAILABLE');
    }
  });

  test('MCP omits the system tools and refuses a remote create or adopt', async () => {
    const list = await rpc('tools/list');
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('project_bash'), 'positive control: other tools remain');
    assert.ok(!names.includes('system_bash'));
    assert.ok(!names.includes('set_project_remote'));
    assert.ok(!names.includes('enumerate_remotes'));

    const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
    const created = await call('create_project', { name: 'rm1', system: 'box', systemPath: '/srv/x' });
    assert.equal(created.isError, true);
    assert.equal(JSON.parse(created.content[1].text).code, 'SYSTEMS_UNAVAILABLE');
    const adopted = await call('adopt_project', { name: 'rm2', path: '/srv/x', system: 'box' });
    assert.equal(JSON.parse(adopted.content[0].text).code, 'SYSTEMS_UNAVAILABLE');
  });

  test('the local path is untouched', async () => {
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'plain' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'viaLocal', system: 'local' })).status, 201);
    const dir = await seedRepo(await mkdtemp('cc-cap-'));
    const adopted = await api(baseUrl, 'POST', '/api/projects/external', { name: 'ext', path: dir });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.body));
    const spawned = await api(baseUrl, 'POST', '/api/instances', { project: 'plain', mode: 'bypassPermissions' });
    assert.equal(spawned.status, 201, JSON.stringify(spawned.body));
    const inst = ctx.instances.get(spawned.body.id);
    await waitFor(() => inst.status === 'idle');
  });
});

describe('fuseUnion off with remote Systems on', () => {
  let ctx, baseUrl, home;
  before(async () => {
    ctx = await bootServer({ platform: platformWith({ remoteSystems: true, fuseUnion: false, voice: true }) });
    baseUrl = ctx.baseUrl;
    ({ home } = await freshProjectsRoot());
  });
  after(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    await ctx.close();
  });

  test('a session on a remote project is refused 501 FUSE_UNAVAILABLE', async () => {
    const sys = await bindRemoteSystem();
    const dir = await seedRepo(`${sys.root}/app`);
    const adopted = await api(baseUrl, 'POST', '/api/projects/external', { name: 'remoteapp', path: dir, system: sys.id });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.body));
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'remoteapp', mode: 'bypassPermissions' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.equal(r.body.code, 'FUSE_UNAVAILABLE');
    assert.equal(ctx.instances.list().length, 0, 'refused before any instance existed');
    await fs.rm(sys.root, { recursive: true, force: true });
  });
});

describe('every capability on', () => {
  let ctx, baseUrl, home;
  before(async () => {
    ctx = await bootServer();
    baseUrl = ctx.baseUrl;
    ({ home } = await freshProjectsRoot());
  });
  after(async () => {
    await ctx.instances.shutdown();
    if (home) await rmrf(home);
    await ctx.close();
  });

  test('health carries all three flags on', async () => {
    const r = await api(baseUrl, 'GET', '/api/health');
    assert.deepEqual(r.body.capabilities, { remoteSystems: true, fuseUnion: true, voice: true });
  });

  test('a coded REST refusal carries its code in the body', async () => {
    const r = await api(baseUrl, 'POST', '/api/projects', { name: 'nosys', system: 'ghost', systemPath: '/x' });
    assert.ok(r.status >= 400);
    assert.equal(typeof r.body.code, 'string', JSON.stringify(r.body));
  });
});
