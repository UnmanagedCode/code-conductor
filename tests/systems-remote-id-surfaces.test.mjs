// THE TWO SURFACES THAT DRIVE A TARGET: REST and MCP.
//
// Both call the one `setProjectRemote`, so the guard and every refusal live in
// one place — and the point of testing both is that they AGREE, not that each
// works. A conductor can already register a remote project through
// `create_project`/`adopt_project`; leaving it unable to re-point one would be
// an asymmetry with no defence.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { projectStoreDir } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

async function readRecord(name) {
  try { return JSON.parse(await fs.readFile(path.join(projectStoreDir(name), 'project.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

describe('remoteId across REST and MCP', () => {
  let ctx, baseUrl, home, sandbox, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    sandbox = await fs.realpath(await mkdtemp('cc-remote-'));
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`] });
  });
  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // ── Creation carries it ──────────────────────────────────────────────

  // PINS: POST /projects records the target, and the listing reports it — so a
  // project created on one of many targets is not indistinguishable from one
  // created on the provider's default.
  test('POST /projects places a project on a named target', async () => {
    const created = await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.remoteId, 'a');
    assert.equal((await readRecord('app')).remoteId, 'a');

    const row = (await api(baseUrl, 'GET', '/api/projects')).body.find(p => p.name === 'app');
    assert.equal(row.remoteId, 'a');
    assert.equal(row.system, remote.id);
  });

  // PINS: an unusable remoteId is refused at the ingress, before anything is
  // created — the 400 is the answer, not a half-made project.
  test('POST /projects refuses an unusable remoteId with nothing created', async () => {
    const r = await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'has space', systemPath: path.join(sandbox, 'app'),
    });
    assert.equal(r.status, 400);
    assert.equal(await readRecord('app'), null);
  });

  // PINS: the adopt surface carries it too, and reports it back — the two
  // creation paths cannot disagree about what a placement is.
  test('POST /projects/external adopts onto a named target', async () => {
    const tree = await seedRepo(path.join(sandbox, 'repo'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', {
      name: 'app', path: tree, system: remote.id, remoteId: 'b',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.remoteId, 'b');
    assert.equal((await readRecord('app')).remoteId, 'b');
  });

  // ── PUT /projects/:name/remote ───────────────────────────────────────

  // PINS: the REST mutation re-points the project and returns the refreshed
  // placement.
  test('PUT /projects/:name/remote changes the target', async () => {
    await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    const r = await api(baseUrl, 'PUT', '/api/projects/app/remote', { remoteId: 'b' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remoteId, 'b');
    assert.equal((await readRecord('app')).remoteId, 'b');
  });

  // PINS: a local project has no target, and the route says so rather than
  // recording a field placementOf would then ignore.
  test('PUT /projects/:name/remote refuses a local project', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'here' });
    assert.equal((await api(baseUrl, 'PUT', '/api/projects/here/remote', { remoteId: 'a' })).status, 400);
  });

  // PINS: the 409 body NAMES the worktrees to clear, so the user is told what
  // to do rather than only that they cannot.
  test('PUT /projects/:name/remote returns the 409 payload naming what holds it', async () => {
    const tree = await seedRepo(path.join(sandbox, 'app'));
    await api(baseUrl, 'POST', '/api/projects/external', {
      name: 'app', path: tree, system: remote.id, remoteId: 'a',
    });
    const wt = await createWorktree('app', { name: 'feature' });
    const before = await readRecord('app');

    const r = await api(baseUrl, 'PUT', '/api/projects/app/remote', { remoteId: 'b' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PROJECT_PLACEMENT_IN_USE');
    assert.deepEqual(r.body.worktrees, [wt.worktreeName]);
    assert.deepEqual(r.body.instances, []);
    assert.deepEqual(await readRecord('app'), before, 'a refused change writes nothing at all');
  });

  // ── set_project_remote ───────────────────────────────────────────────

  // PINS: the MCP twin exists and does the same thing — a conductor that can
  // register a remote project can re-point one.
  test('set_project_remote changes the target', async () => {
    await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    const r = await callTool(baseUrl, 'set_project_remote', { project: 'app', remoteId: 'b' });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal((await readRecord('app')).remoteId, 'b');
  });

  // PINS: BOTH SURFACES PRODUCE THE SAME REFUSAL, because both call the one
  // helper — the guard is not something a surface can be built without.
  test('REST and MCP refuse identically, from the same helper', async () => {
    const tree = await seedRepo(path.join(sandbox, 'app'));
    await api(baseUrl, 'POST', '/api/projects/external', {
      name: 'app', path: tree, system: remote.id, remoteId: 'a',
    });
    const wt = await createWorktree('app', { name: 'feature' });
    const before = await readRecord('app');

    const rest = await api(baseUrl, 'PUT', '/api/projects/app/remote', { remoteId: 'b' });
    const mcp = await callTool(baseUrl, 'set_project_remote', { project: 'app', remoteId: 'b' });

    assert.equal(rest.status, 409);
    assert.equal(rest.body.code, 'PROJECT_PLACEMENT_IN_USE');
    assert.equal(mcp.isError, true);
    const text = mcp.content.map(c => c.text).join('\n');
    assert.match(text, /PROJECT_PLACEMENT_IN_USE/);
    assert.match(text, new RegExp(wt.worktreeName));
    assert.deepEqual(await readRecord('app'), before, 'neither surface wrote anything');
  });

  // ── Clearing is an EXPLICIT act on both surfaces ─────────────────────

  // PINS: an ABSENT remoteId is refused, naming the field — it must not read as
  // "clear the target". `set_project_remote({project})` with no target at all is
  // the shape a caller reaches by accident, and silently unbinding the project
  // is the most destructive reading available.
  test('PUT /projects/:name/remote refuses a body with no remoteId at all', async () => {
    await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    const before = await readRecord('app');
    const r = await api(baseUrl, 'PUT', '/api/projects/app/remote', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /remoteId/, 'the refusal names the missing field');
    assert.deepEqual(await readRecord('app'), before, 'and nothing was cleared');
  });

  // PINS: the documented way to clear still works — the refusal above is about
  // OMISSION, not about clearing, and an explicit null or empty string is how a
  // project falls back to the provider's own default target.
  test('PUT /projects/:name/remote clears on an explicit null or empty string', async () => {
    for (const value of [null, '']) {
      await api(baseUrl, 'DELETE', '/api/projects/app');
      await api(baseUrl, 'POST', '/api/projects', {
        name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, `app-${String(value)}`),
      });
      const r = await api(baseUrl, 'PUT', '/api/projects/app/remote', { remoteId: value });
      assert.equal(r.status, 200, `${JSON.stringify(value)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.remoteId, null);
      assert.equal('remoteId' in (await readRecord('app')), false, `${JSON.stringify(value)} clears the field`);
    }
  });

  // PINS: the MCP twin enforces the same thing STRUCTURALLY — the schema marks
  // remoteId required, so an omitted one never reaches the handler at all.
  test('set_project_remote refuses an omitted remoteId and clears on an explicit null', async () => {
    await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    const before = await readRecord('app');

    const omitted = await callTool(baseUrl, 'set_project_remote', { project: 'app' });
    assert.equal(omitted.isError, true, JSON.stringify(omitted));
    assert.match(omitted.content.map(c => c.text).join('\n'), /remoteId/);
    assert.deepEqual(await readRecord('app'), before, 'nothing was cleared');

    const cleared = await callTool(baseUrl, 'set_project_remote', { project: 'app', remoteId: null });
    assert.equal(cleared.isError, undefined, JSON.stringify(cleared));
    assert.equal('remoteId' in (await readRecord('app')), false);
  });

  // PINS: create_project over MCP carries the target too, so a conductor's
  // registration is not a second-class one.
  test('create_project over MCP places a project on a named target', async () => {
    const r = await callTool(baseUrl, 'create_project', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal((await readRecord('app')).remoteId, 'a');
  });

  // ── Settings sees which targets are bound ────────────────────────────

  // PINS: the systems panel's payload names each referencing project WITH its
  // target — on a system serving ten containers, "shipping" alone does not say
  // which one holds the row.
  test('the systems registry reports each project with its target', async () => {
    await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    const r = await api(baseUrl, 'GET', '/api/settings/systems');
    assert.deepEqual(
      r.body.systems.find(s => s.id === remote.id).projects,
      [{ name: 'app', remoteId: 'a' }],
    );
  });
});
