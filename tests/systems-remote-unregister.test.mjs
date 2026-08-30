// UNREGISTERING MUST NEVER DEPEND ON REACHING THE SYSTEM — through the surfaces
// a user actually has, not just through the function.
//
// `deleteProject`'s remote branch was written to resolve nothing on the system,
// precisely so a project on a system that is down is never stranded. The DELETE
// route in front of it then resolved the project — and therefore the system —
// before calling it, so the branch was unreachable from the only surface there
// is. A unit test on `deleteProject` cannot see that, which is why the suite was
// green: THE BUG LIVED IN THE GAP BETWEEN THE UNIT TEST AND THE ROUTE. Every
// test here goes through HTTP or MCP, and in the unreachable state.
//
// The consequence was a deadlock with no exit: the project stayed registered,
// `removeSystem` refused 409 because that project still named the system, and
// the only repair was hand-editing the store.
//
// The same root cause has a second, worse instance — a record naming a system
// with NO `systemPath`. It is what a half-written or hand-edited record looks
// like, deleting it is the repair, and it was invisible in the listing on top of
// being undeletable. P2's degraded-listing contract already covers the visible
// half: an unresolvable row STAYS, carrying its reason.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, snapshotTree, assertTreeUnchanged } from './remoteSystem.mjs';
import { adoptProject, projectStoreDir } from '../src/projects.ts';
import { updateSystem } from '../src/appSettings.ts';
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

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function writeRecord(name, record) {
  await fs.mkdir(projectStoreDir(name), { recursive: true });
  await fs.writeFile(path.join(projectStoreDir(name), 'project.json'), JSON.stringify(record, null, 2) + '\n');
}

describe('a project on a system cc cannot reach can still be unregistered', () => {
  let ctx, baseUrl, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // Adopt a real repo on the system, then take the system away.
  async function adoptThenStrand(name = 'app') {
    const tree = await seedRepo(path.join(remote.root, name));
    assert.equal((await adoptProject(name, tree, { system: remote.id })).ok, true);
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
    return tree;
  }

  // PINS: DELETE succeeds against a system that cannot be reached, leaves the
  // remote tree byte-identical, and reports that it only unregistered.
  test('DELETE /api/projects/:name works when the system is unreachable', async () => {
    const tree = await adoptThenStrand();
    const before = await snapshotTree(tree);

    const r = await api(baseUrl, 'DELETE', '/api/projects/app');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.system, remote.id);
    assert.equal(r.body.unregisteredOnly, true);
    assertTreeUnchanged(assert, before, await snapshotTree(tree), 'the tree on the system is untouched');
    assert.equal(await exists(projectStoreDir('app')), false, 'the record is gone');
    assert.deepEqual((await api(baseUrl, 'GET', '/api/projects')).body.map(p => p.name), []);
  });

  // PINS THE DEADLOCK'S EXIT: once the project is unregistered, the system row
  // itself can be removed. Before, `removeSystem` refused 409 naming a project
  // that could not be deleted — a cycle with no way out but hand-editing.
  test('and the system row can then be removed, which is the way out of the cycle', async () => {
    await adoptThenStrand();
    const blocked = await api(baseUrl, 'DELETE', `/api/settings/systems/${remote.id}`);
    assert.equal(blocked.status, 409, 'the system is still held while the project names it');
    assert.match(blocked.body.error, /app/);

    assert.equal((await api(baseUrl, 'DELETE', '/api/projects/app')).status, 200);
    const freed = await api(baseUrl, 'DELETE', `/api/settings/systems/${remote.id}`);
    assert.equal(freed.status, 200, JSON.stringify(freed.body));
    assert.equal(freed.body.systems.some(s => s.id === remote.id), false);
  });

  // PINS: a project whose system row does not exist AT ALL is deletable too —
  // the harshest unreachable state, and the one a removed system would leave
  // behind if removal ever stopped refusing.
  test('DELETE works when the system is not even in the registry', async () => {
    await writeRecord('ghosted', { system: 'ghostbox', systemPath: '/app' });
    const r = await api(baseUrl, 'DELETE', '/api/projects/ghosted');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.system, 'ghostbox');
    assert.equal(await exists(projectStoreDir('ghosted')), false);
  });

  // PINS: a record naming a system with NO systemPath — which cc never writes,
  // so it is a half-written or hand-edited one — is still deletable. Deleting it
  // IS the repair, so this is the one path that must not refuse it.
  test('DELETE works on a record with a system and no systemPath', async () => {
    await writeRecord('broken', { system: remote.id });
    const r = await api(baseUrl, 'DELETE', '/api/projects/broken');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.system, remote.id);
    assert.equal(await exists(projectStoreDir('broken')), false);
  });

  // PINS P2's degraded-listing contract for that same record: an unresolvable
  // row STAYS VISIBLE and says why. Invisible AND undeletable is how it pinned
  // the system row at 409 with nothing on any page to explain it.
  test('a record with no systemPath is still listed, carrying its reason', async () => {
    await writeRecord('broken', { system: remote.id });
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    const row = r.body.find(p => p.name === 'broken');
    assert.ok(row, `the row must not disappear; got ${JSON.stringify(r.body.map(p => p.name))}`);
    assert.equal(row.system, remote.id);
    assert.match(row.systemUnreachable, /systemPath/,
      'the row says WHY it could not be resolved, so the page is not silently wrong');
    assert.equal('isGitRepo' in row, false, 'and invents no measured fact');
  });

  // PINS: the MCP listing face degrades the same row the same way — the two
  // faces of the same contract must not disagree.
  test('list_projects shows it too, with the reason and no invented git fact', async () => {
    await writeRecord('broken', { system: remote.id });
    const r = await callTool(baseUrl, 'list_projects', {});
    const text = r.content.map(c => c.text).join('\n');
    assert.match(text, /▸ broken\b/, text);
    assert.match(text, /! system unreachable/);
    assert.ok(!text.includes('! not a git repo'));
  });

  // PINS: a healthy remote project is unaffected — the listing still measures
  // it, so none of the above degrades the working case.
  test('a reachable remote project is still measured', async () => {
    const tree = await seedRepo(path.join(remote.root, 'ok'));
    assert.equal((await adoptProject('ok', tree, { system: remote.id })).ok, true);
    const row = (await api(baseUrl, 'GET', '/api/projects')).body.find(p => p.name === 'ok');
    assert.equal(row.systemUnreachable, null);
    assert.equal(row.isGitRepo, true);
  });
});

describe('a held name on an unreachable system is a REFUSAL, never a throw', () => {
  let ctx, baseUrl, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  async function strandedProject(name = 'app') {
    const tree = await seedRepo(path.join(remote.root, name));
    assert.equal((await adoptProject(name, tree, { system: remote.id })).ok, true);
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
  }

  // PINS: adopt's documented contract — "every refusal is RETURNED with a code,
  // never thrown". A purely LOCAL adopt whose NAME happens to be held by a
  // project on a down system must answer PROJECT_EXISTS, not throw about a
  // system the caller never mentioned.
  test('a local adopt under a held remote name returns PROJECT_EXISTS', async () => {
    await strandedProject('app');
    const localRepo = await seedRepo(path.join(home, 'mine'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: 'app', path: localRepo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'PROJECT_EXISTS',
      'the name is held; the repair is to unregister it, not to hunt a system');
    assert.match(r.body.reason, new RegExp(remote.id), 'and the reason names where it is held');
  });

  // PINS the same on the MCP face, where the returned-not-thrown contract is
  // written into the tool description.
  test('adopt_project returns the refusal rather than erroring', async () => {
    await strandedProject('app');
    const localRepo = await seedRepo(path.join(home, 'mine'));
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 9001, method: 'tools/call',
        params: { name: 'adopt_project', arguments: { name: 'app', path: localRepo } },
      }),
    });
    const result = (await res.json()).result;
    assert.ok(!result.isError, `must not be a tool error: ${JSON.stringify(result)}`);
    assert.match(result.content.map(c => c.text).join('\n'), /PROJECT_EXISTS/);
  });

  // PINS: create's contract is a 409 on a held name. A 501 about someone else's
  // system misdirects the repair — the caller named no system at all.
  test('a local create under a held remote name is a 409, not a system error', async () => {
    await strandedProject('app');
    const r = await api(baseUrl, 'POST', '/api/projects', { name: 'app' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /already exists/);
  });

  // PINS: the same for the malformed-record shape, which reaches the held-name
  // check through a different refusal.
  test('a held name whose record has no systemPath is also a returned refusal', async () => {
    await fs.mkdir(projectStoreDir('app'), { recursive: true });
    await fs.writeFile(path.join(projectStoreDir('app'), 'project.json'),
      JSON.stringify({ system: remote.id }));
    const localRepo = await seedRepo(path.join(home, 'mine'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: 'app', path: localRepo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PROJECT_EXISTS');
  });

  // PINS: an ordinary local name collision still answers exactly as before —
  // the new branch must not swallow the case it sits in front of.
  test('a local name collision is unchanged', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'taken' });
    const localRepo = await seedRepo(path.join(home, 'mine'));
    const r = await api(baseUrl, 'POST', '/api/projects/external', { name: 'taken', path: localRepo });
    assert.equal(r.body.code, 'PROJECT_EXISTS');
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'taken' })).status, 409);
  });
});
