// The `projects` hint (`{t:'projects'}`) reaches every client exactly once per
// committed change to the project list, its workspaces, its worktrees or a
// project's target — signalled by the shared layer (src/projects.ts,
// src/worktrees.ts), so REST and MCP alike. A refusal or no-op that wrote
// nothing, and a read, send none; a refusal after a write landed sends one.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { createProject, addWorkspace } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

let rpcId = 1;
/** One MCP tools/call's raw result. */
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

/** A tool's JSON answer, or `{isError, text}` for a refusal it threw. */
async function mcp(baseUrl, name, args) {
  const result = await callTool(baseUrl, name, args);
  const text = result.content[0].text;
  return result.isError ? { isError: true, text } : JSON.parse(text);
}

/**
 * A client socket counting `projects` frames. `projectsFrames()` sends a probe
 * the server answers on the same socket and reads the count once the answer
 * is in: frames on one socket arrive in order, so every hint the server sent
 * before the probe is counted, with no wait for frames that never come.
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const frames = [];
  ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString())); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let probes = 0;
  return {
    async projectsFrames() {
      const reqId = `probe-${++probes}`;
      ws.send(JSON.stringify({ t: 'subscribe', id: 'no-such-instance', reqId }));
      await waitFor(() => frames.some((m) => m.t === 'ack' && m.reqId === reqId));
      return frames.filter((m) => m.t === 'projects').length;
    },
    close: () => ws.close(),
  };
}

/** The `projects` frames `act` caused, read through the probe before and after it. */
async function framesFor(client, act) {
  const before = await client.projectsFrames();
  await act();
  return (await client.projectsFrames()) - before;
}

const names = async (baseUrl) => (await api(baseUrl, 'GET', '/api/projects')).body.map((p) => p.name).sort();

describe('the projects hint on the local system', () => {
  let ctx, baseUrl, wsUrl, home, projectsRoot, client;
  before(async () => { ctx = await bootServer(); ({ baseUrl, wsUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home, projectsRoot } = await freshProjectsRoot());
    client = await connect(wsUrl);
    // Positive control: the probe counts hints the server sends with or without the shared signal.
    assert.equal(await framesFor(client, async () => {
      await api(baseUrl, 'POST', '/api/workspaces', { name: 'Probe' });
      await api(baseUrl, 'DELETE', '/api/workspaces/Probe');
    }), 2, 'positive control');
  });
  afterEach(async () => {
    client.close();
    await ctx.instances.shutdown();
    await rmrf(home);
  });

  test('creating a project sends exactly one projects frame, through REST and through MCP create_project', async () => {
    let status = 0;
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'POST', '/api/projects', { name: 'rest-made' })).status;
    }), 1, 'REST create');
    assert.equal(status, 201);
    let made = null;
    assert.equal(await framesFor(client, async () => {
      made = await mcp(baseUrl, 'create_project', { name: 'mcp-made' });
    }), 1, 'MCP create_project');
    assert.equal(made.name, 'mcp-made');
    assert.deepEqual(await names(baseUrl), ['mcp-made', 'rest-made']);
  });

  test('two projects created together send exactly two frames, and the list read after them holds both', async () => {
    let statuses = [];
    assert.equal(await framesFor(client, async () => {
      statuses = (await Promise.all([
        api(baseUrl, 'POST', '/api/projects', { name: 'twin-a' }),
        api(baseUrl, 'POST', '/api/projects', { name: 'twin-b' }),
      ])).map((r) => r.status);
    }), 2);
    assert.deepEqual(statuses, [201, 201]);
    assert.deepEqual(await names(baseUrl), ['twin-a', 'twin-b']);
  });

  test('adopting and deleting a project each send exactly one frame per committed change, a stale-record replace and a delete with a worktree included', async () => {
    const dir = path.join(projectsRoot, 'adopted-dir');
    await fs.mkdir(dir, { recursive: true });
    let adopted = null;
    assert.equal(await framesFor(client, async () => {
      adopted = (await api(baseUrl, 'POST', '/api/projects/external', { name: 'adopted', path: dir })).body;
    }), 1, 'adopt');
    assert.equal(adopted.ok, true, JSON.stringify(adopted));

    await rmrf(dir);
    const moved = path.join(projectsRoot, 'moved-dir');
    await fs.mkdir(moved, { recursive: true });
    let replaced = null;
    assert.equal(await framesFor(client, async () => {
      replaced = (await api(baseUrl, 'POST', '/api/projects/external', { name: 'adopted', path: moved, onStaleRecord: 'replace' })).body;
    }), 1, 'replace a stale record');
    assert.equal(replaced.ok, true, JSON.stringify(replaced));

    await api(baseUrl, 'POST', '/api/projects', { name: 'plain' });
    assert.equal(await framesFor(client, () => api(baseUrl, 'DELETE', '/api/projects/plain')), 1, 'delete');

    await api(baseUrl, 'POST', '/api/projects', { name: 'doomed' });
    const wt = await mcp(baseUrl, 'create_worktree', { project: 'doomed' });
    assert.equal(wt.parentProject, 'doomed', JSON.stringify(wt));
    let deleted = 0;
    assert.equal(await framesFor(client, async () => {
      deleted = (await api(baseUrl, 'DELETE', '/api/projects/doomed')).status;
    }), 1, 'delete with a worktree');
    assert.equal(deleted, 200);
    assert.deepEqual(await names(baseUrl), ['adopted']);
  });

  test('a project delete refused by a dirty worktree sends no frame when it dropped nothing, and exactly one after dropping a clean worktree first', async () => {
    // The cascade removes worktrees oldest first and refuses at the first dirty one.
    await api(baseUrl, 'POST', '/api/projects', { name: 'stuck' });
    const lone = await mcp(baseUrl, 'create_worktree', { project: 'stuck' });
    await fs.writeFile(path.join(lone.worktreePath, 'dirty.txt'), 'uncommitted\n');
    let status = 0;
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'DELETE', '/api/projects/stuck')).status;
    }), 0, 'refused before any write');
    assert.equal(status, 409);

    await api(baseUrl, 'POST', '/api/projects', { name: 'partial' });
    const clean = await mcp(baseUrl, 'create_worktree', { project: 'partial' });
    const dirty = await mcp(baseUrl, 'create_worktree', { project: 'partial' });
    await fs.writeFile(path.join(dirty.worktreePath, 'dirty.txt'), 'uncommitted\n');
    status = 0;
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'DELETE', '/api/projects/partial')).status;
    }), 1, 'refused after the clean worktree was dropped');
    assert.equal(status, 409);
    const row = (await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'partial');
    assert.deepEqual(row.worktrees.map((w) => w.worktreeName), [dirty.worktree]);
    assert.notEqual(clean.worktree, dirty.worktree);
  });

  test('assigning a workspace sends exactly one frame through REST and through MCP set_project_workspace, a newly named workspace included', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'member' });
    let rest = null;
    assert.equal(await framesFor(client, async () => {
      rest = (await api(baseUrl, 'PUT', '/api/projects/member/workspace', { workspace: 'Fresh-A' })).body;
    }), 1, 'REST assign');
    assert.equal(rest.workspace, 'Fresh-A');
    let viaMcp = null;
    assert.equal(await framesFor(client, async () => {
      viaMcp = await mcp(baseUrl, 'set_project_workspace', { project: 'member', workspace: 'Fresh-B' });
    }), 1, 'MCP assign');
    assert.equal(viaMcp.workspace, 'Fresh-B');
    const workspaces = (await api(baseUrl, 'GET', '/api/workspaces')).body.map((w) => w.name);
    assert.deepEqual(workspaces, ['Fresh-A', 'Fresh-B']);
  });

  test('creating, renaming and deleting a workspace each send exactly one frame through REST and through MCP', async () => {
    assert.equal(await framesFor(client, () => api(baseUrl, 'POST', '/api/workspaces', { name: 'W1' })), 1, 'REST create');
    assert.equal(await framesFor(client, () => mcp(baseUrl, 'create_workspace', { name: 'W2' })), 1, 'MCP create');
    for (const p of ['m1', 'm2']) {
      await api(baseUrl, 'POST', '/api/projects', { name: p });
      await api(baseUrl, 'PUT', `/api/projects/${p}/workspace`, { workspace: 'W1' });
    }
    let renamed = null;
    assert.equal(await framesFor(client, async () => {
      renamed = (await api(baseUrl, 'PUT', '/api/workspaces/W1', { name: 'W1b' })).body;
    }), 1, 'REST rename of a two-member workspace');
    assert.deepEqual(renamed.movedProjects, ['m1', 'm2']);
    assert.equal(await framesFor(client, () => mcp(baseUrl, 'rename_workspace', { oldName: 'W2', newName: 'W2b' })), 1, 'MCP rename');
    assert.equal(await framesFor(client, () => api(baseUrl, 'DELETE', '/api/workspaces/W1b')), 1, 'REST delete');
    assert.equal(await framesFor(client, () => mcp(baseUrl, 'delete_workspace', { name: 'W2b' })), 1, 'MCP delete');
    assert.deepEqual((await api(baseUrl, 'GET', '/api/workspaces')).body, []);
  });

  test('creating and deleting a worktree each send exactly one frame through MCP, and deleting or locking one through REST sends one', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'trees' });
    let first = null;
    assert.equal(await framesFor(client, async () => {
      first = await mcp(baseUrl, 'create_worktree', { project: 'trees' });
    }), 1, 'MCP create_worktree');
    assert.equal(first.parentProject, 'trees', JSON.stringify(first));
    assert.equal(await framesFor(client, () => mcp(baseUrl, 'delete_worktree', { project: 'trees', worktree: first.worktree })), 1, 'MCP delete_worktree');
    const second = await mcp(baseUrl, 'create_worktree', { project: 'trees' });
    let locked = null;
    assert.equal(await framesFor(client, async () => {
      locked = (await api(baseUrl, 'PUT', `/api/projects/trees/worktrees/${second.worktree}/lock`, { locked: true })).body;
    }), 1, 'REST lock');
    assert.equal(locked.locked, true);
    let removed = 0;
    assert.equal(await framesFor(client, async () => {
      removed = (await api(baseUrl, 'DELETE', `/api/projects/trees/worktrees/${second.worktree}`)).status;
    }), 1, 'REST delete');
    assert.equal(removed, 200);
    const row = (await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'trees');
    assert.deepEqual(row.worktrees, []);
  });

  test('a refused, no-op or read-only call sends no frame', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'held' });
    await api(baseUrl, 'POST', '/api/workspaces', { name: 'Kept' });
    // A member, so a rename of Kept onto itself that rewrote anything would be a real write.
    await api(baseUrl, 'PUT', '/api/projects/held/workspace', { workspace: 'Kept' });
    const wt = await mcp(baseUrl, 'create_worktree', { project: 'held' });
    await fs.writeFile(path.join(wt.worktreePath, 'dirty.txt'), 'uncommitted\n');

    const refusals = [
      ['REST duplicate create', async () => assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'held' })).status, 409)],
      ['MCP duplicate create_project', async () => assert.equal((await mcp(baseUrl, 'create_project', { name: 'held' })).isError, true)],
      ['REST adopt of a missing path', async () => assert.equal((await api(baseUrl, 'POST', '/api/projects/external', { name: 'ghost', path: path.join(projectsRoot, 'no-such-dir') })).body.ok, false)],
      ['REST workspace for .conduct', async () => assert.equal((await api(baseUrl, 'PUT', '/api/projects/.conduct/workspace', { workspace: 'Kept' })).status, 400)],
      ['MCP set_project_workspace for .conduct', async () => assert.match((await mcp(baseUrl, 'set_project_workspace', { project: '.conduct', workspace: 'Kept' })).text, /cannot be assigned to a workspace/)],
      ['REST workspace for an unknown project', async () => assert.equal((await api(baseUrl, 'PUT', '/api/projects/nope/workspace', { workspace: 'Kept' })).status, 404)],
      ['REST create of an existing workspace', async () => assert.equal((await api(baseUrl, 'POST', '/api/workspaces', { name: 'Kept' })).body.added, false)],
      ['MCP rename of a missing workspace', async () => assert.equal((await mcp(baseUrl, 'rename_workspace', { oldName: 'Gone', newName: 'Other' })).isError, true)],
      ['REST delete of an unregistered workspace', async () => assert.deepEqual((await api(baseUrl, 'DELETE', '/api/workspaces/Never-Registered')).body, { ok: true, removed: false, name: 'Never-Registered', clearedProjects: [] })],
      ['MCP delete_workspace of an unregistered workspace', async () => assert.deepEqual(await mcp(baseUrl, 'delete_workspace', { name: 'Never-Registered' }), { removed: false, name: 'Never-Registered', clearedProjects: [] })],
      ['REST rename of a workspace to its own name', async () => assert.deepEqual((await api(baseUrl, 'PUT', '/api/workspaces/Kept', { name: 'Kept' })).body, { ok: true, renamed: false, name: 'Kept', movedProjects: [] })],
      ['MCP rename_workspace to its own name', async () => assert.deepEqual(await mcp(baseUrl, 'rename_workspace', { oldName: 'Kept', newName: 'Kept' }), { renamed: false, name: 'Kept', movedProjects: [] })],
      ['MCP delete of a dirty worktree', async () => assert.equal((await mcp(baseUrl, 'delete_worktree', { project: 'held', worktree: wt.worktree })).code, 'WORKTREE_DIRTY')],
      ['REST target change on a local project', async () => assert.equal((await api(baseUrl, 'PUT', '/api/projects/held/remote', { remoteId: 'x' })).status, 400)],
      ['REST list', async () => assert.equal((await api(baseUrl, 'GET', '/api/projects')).status, 200)],
      ['MCP list_projects', async () => assert.match((await callTool(baseUrl, 'list_projects', {})).content[0].text, /held/)],
    ];
    for (const [label, act] of refusals) {
      assert.equal(await framesFor(client, act), 0, label);
    }
    assert.deepEqual((await api(baseUrl, 'GET', '/api/workspaces')).body.map((w) => w.name), ['Kept']);
    assert.equal((await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'held').workspace, 'Kept');
  });

  test('the signal comes from the shared layer: projects.ts and worktrees.ts calls with no surface in front send one frame each', async () => {
    assert.equal(await framesFor(client, () => createProject('direct')), 1, 'createProject');
    assert.equal(await framesFor(client, () => addWorkspace('Direct-WS')), 1, 'addWorkspace');
    let wt = null;
    assert.equal(await framesFor(client, async () => { wt = await createWorktree('direct', {}); }), 1, 'createWorktree');
    const row = (await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'direct');
    assert.deepEqual(row.worktrees.map((w) => w.worktreeName), [wt.worktreeName]);
  });

  test('a conventions edit sends exactly one frame, and a refused one none', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'conv' });
    let status = 0;
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'PUT', '/api/projects/conv/conventions', { selection: { mode: 'selected', slugs: ['design-guidelines'] }, expected: { mode: 'unset' } })).status;
    }), 1, 'edit');
    assert.equal(status, 200);
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'PUT', '/api/projects/conv/conventions', { selection: { mode: 'unset' }, expected: { mode: 'unset' } })).status;
    }), 0, 'stale edit');
    assert.equal(status, 409);
  });

  test('a project custom-convention add regenerates every project and sends exactly one frame', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'sweep-a' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'sweep-b' });
    let status = 0;
    assert.equal(await framesFor(client, async () => {
      status = (await api(baseUrl, 'POST', '/api/settings/conventions/project',
        { slug: 'house-style', name: 'House style', description: 'x', body: '## House style\n- rule' })).status;
    }), 1);
    assert.equal(status, 201);
  });

  test('a worktree created through MCP is in the next projects read though the git-facts cache is warm', async () => {
    resetProjectsCache(60_000);
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'cached' });
      const before = (await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'cached');
      assert.deepEqual(before.worktrees, []);
      const wt = await mcp(baseUrl, 'create_worktree', { project: 'cached' });
      const after = (await api(baseUrl, 'GET', '/api/projects')).body.find((p) => p.name === 'cached');
      assert.deepEqual(after.worktrees.map((w) => w.worktreeName), [wt.worktree]);
    } finally {
      resetProjectsCache(0);
    }
  });
});

describe('the projects hint for a target change', () => {
  let ctx, baseUrl, wsUrl, home, sandbox, remote, client;
  before(async () => { ctx = await bootServer(); ({ baseUrl, wsUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    sandbox = await fs.realpath(await mkdtemp('cc-changed-'));
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`] });
    client = await connect(wsUrl);
    // Positive control: the probe counts hints the server sends with or without the shared signal.
    assert.equal(await framesFor(client, async () => {
      await api(baseUrl, 'POST', '/api/workspaces', { name: 'Probe' });
      await api(baseUrl, 'DELETE', '/api/workspaces/Probe');
    }), 2, 'positive control');
  });
  afterEach(async () => {
    client.close();
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  test('changing a project target sends exactly one frame through REST and through MCP set_project_remote', async () => {
    const created = await api(baseUrl, 'POST', '/api/projects', {
      name: 'app', system: remote.id, remoteId: 'a', systemPath: path.join(sandbox, 'app'),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    let rest = null;
    assert.equal(await framesFor(client, async () => {
      rest = (await api(baseUrl, 'PUT', '/api/projects/app/remote', { remoteId: 'b' })).body;
    }), 1, 'REST');
    assert.equal(rest.remoteId, 'b');
    let viaMcp = null;
    assert.equal(await framesFor(client, async () => {
      viaMcp = await mcp(baseUrl, 'set_project_remote', { project: 'app', remoteId: 'a' });
    }), 1, 'MCP');
    assert.equal(viaMcp.remoteId, 'a');
  });
});
