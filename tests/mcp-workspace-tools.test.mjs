// Tests for the five workspace MCP tools added so conductors can set up
// their own sidebar organisation alongside the human:
//   list_workspaces, create_workspace, delete_workspace,
//   rename_workspace, set_project_workspace.
// Same bootServer + rpc + unwrap pattern as tests/mcp.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content));
  return JSON.parse(result.content[0].text);
}

test('tools/list exposes all five workspace tools', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/list');
    const names = body.result.tools.map(t => t.name);
    for (const n of [
      'list_workspaces', 'create_workspace', 'delete_workspace',
      'rename_workspace', 'set_project_workspace',
    ]) {
      assert.ok(names.includes(n), `tools/list missing ${n}`);
    }
  } finally { await close(); }
});

test('create_workspace registers a name; second call is a no-op', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const first = unwrap(await callTool(ctx.baseUrl, 'create_workspace', { name: 'Refactor' }));
    assert.equal(first.added, true);
    assert.equal(first.name, 'Refactor');

    const second = unwrap(await callTool(ctx.baseUrl, 'create_workspace', { name: 'Refactor' }));
    assert.equal(second.added, false);

    // Visible in list_workspaces with projectCount 0.
    const list = unwrap(await callTool(ctx.baseUrl, 'list_workspaces', {}));
    const refactor = list.find(w => w.name === 'Refactor');
    assert.ok(refactor, 'workspace appears in list');
    assert.equal(refactor.projectCount, 0);
  } finally { await ctx.close(); }
});

test('list_workspaces unions registered names with workspaces derived from project assignments', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    // One workspace registered without any members; another exists only
    // via a project assignment. Both must appear in list_workspaces.
    await callTool(ctx.baseUrl, 'create_workspace', { name: 'Empty' });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'alpha' });
    await callTool(ctx.baseUrl, 'set_project_workspace', { project: 'alpha', workspace: 'Derived' });

    const list = unwrap(await callTool(ctx.baseUrl, 'list_workspaces', {}));
    const names = list.map(w => w.name).sort();
    assert.deepEqual(names, ['Derived', 'Empty']);
    const derived = list.find(w => w.name === 'Derived');
    assert.equal(derived.projectCount, 1);
    const empty = list.find(w => w.name === 'Empty');
    assert.equal(empty.projectCount, 0);
  } finally { await ctx.close(); }
});

test('set_project_workspace assigns, clears with null, and auto-registers the new name', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'alpha' });

    // Assign — workspace gets auto-registered even though we never called create_workspace.
    const a = unwrap(await callTool(ctx.baseUrl, 'set_project_workspace', {
      project: 'alpha', workspace: 'Side projects',
    }));
    assert.equal(a.workspace, 'Side projects');

    const list1 = unwrap(await callTool(ctx.baseUrl, 'list_workspaces', {}));
    assert.ok(list1.some(w => w.name === 'Side projects'),
      'newly-assigned workspace appears in list_workspaces');

    // Reflected in list_projects.
    const projects = unwrap(await callTool(ctx.baseUrl, 'list_projects', {}));
    const alpha = projects.find(p => p.name === 'alpha');
    assert.equal(alpha.workspace, 'Side projects');

    // Clear with null.
    const cleared = unwrap(await callTool(ctx.baseUrl, 'set_project_workspace', {
      project: 'alpha', workspace: null,
    }));
    assert.equal(cleared.workspace, null);
    const after = unwrap(await callTool(ctx.baseUrl, 'list_projects', {}));
    assert.equal(after.find(p => p.name === 'alpha').workspace, null);
  } finally { await ctx.close(); }
});

test('set_project_workspace refuses the hidden .conduct project', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'set_project_workspace',
      arguments: { project: '.conduct', workspace: 'Anything' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /cannot be assigned/i);
  } finally { await ctx.close(); }
});

test('rename_workspace atomically moves every member project', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'alpha' });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'beta' });
    await callTool(ctx.baseUrl, 'set_project_workspace', { project: 'alpha', workspace: 'Old' });
    await callTool(ctx.baseUrl, 'set_project_workspace', { project: 'beta', workspace: 'Old' });

    const r = unwrap(await callTool(ctx.baseUrl, 'rename_workspace', {
      oldName: 'Old', newName: 'New',
    }));
    assert.equal(r.renamed, true);
    assert.deepEqual([...r.movedProjects].sort(), ['alpha', 'beta']);

    const projects = unwrap(await callTool(ctx.baseUrl, 'list_projects', {}));
    for (const name of ['alpha', 'beta']) {
      assert.equal(projects.find(p => p.name === name).workspace, 'New',
        `${name} now points at New`);
    }
    const list = unwrap(await callTool(ctx.baseUrl, 'list_workspaces', {}));
    const names = list.map(w => w.name);
    assert.ok(names.includes('New'));
    assert.ok(!names.includes('Old'), 'old name gone after rename');
  } finally { await ctx.close(); }
});

test('delete_workspace clears member assignments without deleting the projects themselves', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'alpha' });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'beta' });
    await callTool(ctx.baseUrl, 'set_project_workspace', { project: 'alpha', workspace: 'Doomed' });
    await callTool(ctx.baseUrl, 'set_project_workspace', { project: 'beta', workspace: 'Doomed' });

    const r = unwrap(await callTool(ctx.baseUrl, 'delete_workspace', { name: 'Doomed' }));
    assert.equal(r.removed, true);
    assert.deepEqual([...r.clearedProjects].sort(), ['alpha', 'beta']);

    // Workspace gone; projects survive with workspace:null.
    const list = unwrap(await callTool(ctx.baseUrl, 'list_workspaces', {}));
    assert.ok(!list.some(w => w.name === 'Doomed'));
    const projects = unwrap(await callTool(ctx.baseUrl, 'list_projects', {}));
    assert.equal(projects.find(p => p.name === 'alpha').workspace, null);
    assert.equal(projects.find(p => p.name === 'beta').workspace, null);
  } finally { await ctx.close(); }
});
