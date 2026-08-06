// The recon split, end to end: `list_projects` counts a project's live workers,
// `list_instances` names them and keeps the ones that have exited.
//
// The load-bearing test here is the agreement invariant — `live N` and the size
// of the INSTANCES section must be the same number, before AND after a worker
// dies. They are computed by different code (InstanceManager.liveCountForProject
// vs the isDeadStatus partition in listInstances) over different collections
// (byId vs byId ∪ _recentExits), so nothing but the shared predicate keeps them
// equal. That is exactly the drift that made the two tools look inconsistent.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args = {}) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result.content[0].text;
}

// `live N` for one project, read out of the list_projects rendering.
function liveCountOf(text, project) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.startsWith(`▸ ${project}  `));
  assert.ok(at >= 0, `project '${project}' not in the rendering:\n${text}`);
  const end = lines.slice(at + 1).findIndex(l => l.startsWith('▸ '));
  const block = lines.slice(at + 1, end >= 0 ? at + 1 + end : undefined);
  const live = block.find(l => l.startsWith('  live '));
  assert.ok(live, `no live line in the block for '${project}':\n${block.join('\n')}`);
  return Number(live.slice('  live '.length));
}

// Split a list_instances rendering into its two sections' sessionId lists.
function sections(text) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.startsWith('EXITED ('));
  const ids = (ls) => ls.filter(l => /^\[\d+\] /.test(l)).map(l => l.slice(l.indexOf('] ') + 2));
  return at >= 0
    ? { live: ids(lines.slice(0, at)), exited: ids(lines.slice(at)) }
    : { live: ids(lines), exited: [] };
}

async function spawnTemp(project) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp: true, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

test('live N and the INSTANCES section stay equal across a worker exiting', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const a = await spawnTemp('demo');
  const b = await spawnTemp('demo');

  const before = sections(await callTool('list_instances', { project: 'demo' }));
  assert.deepEqual(before.live.slice().sort(), [a.sessionId, b.sessionId].sort());
  assert.deepEqual(before.exited, [], 'nothing has exited yet');
  assert.equal(liveCountOf(await callTool('list_projects'), 'demo'), before.live.length,
    'live N must equal the INSTANCES section size');

  await a.kill({ graceMs: 50 });
  await waitFor(() => a.status === 'exited' || a.status === 'crashed');
  // The temp-eviction path really did drop it — so the EXITED row below can only
  // be coming from the tombstone, not from a row that was never removed.
  assert.equal(instances.idsForSession(a.sessionId).length, 0, 'a temp instance leaves byId on exit');

  const after = sections(await callTool('list_instances', { project: 'demo' }));
  assert.deepEqual(after.live, [b.sessionId], 'only the survivor is live');
  assert.deepEqual(after.exited, [a.sessionId], 'the dead worker is listed, in its own section');
  assert.equal(liveCountOf(await callTool('list_projects'), 'demo'), after.live.length,
    'live N must follow the exit in lockstep with the INSTANCES section');
});

test('an exited worker is distinguishable at a glance, and keeps its handle', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const inst = await spawnTemp('demo');
  const sid = inst.sessionId;
  await inst.kill({ graceMs: 50 });
  await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');

  const text = await callTool('list_instances', { project: 'demo' });
  assert.match(text, /^INSTANCES \(none\) {2}project demo$/m, 'no worker is still running');
  assert.match(text, /^EXITED \(1\)$/m);
  assert.ok(text.includes(sid), 'the sessionId stays a full-length, usable handle');
  assert.match(text, /^ {4}flags .*exited \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/m, 'the death time is on the row');
  // That the handle still resolves to a transcript is the temp-archive
  // behaviour, covered by tests/archive-sessions.test.mjs — not re-asserted here.
});

test('the project filter narrows both sections and echoes itself on the heading', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'other' });
  const mine = await spawnTemp('demo');
  const theirs = await spawnTemp('other');
  await theirs.kill({ graceMs: 50 });
  await waitFor(() => theirs.status === 'exited' || theirs.status === 'crashed');

  const all = sections(await callTool('list_instances'));
  assert.ok(all.live.includes(mine.sessionId) && all.exited.includes(theirs.sessionId),
    'unfiltered, both projects are present');

  const filtered = await callTool('list_instances', { project: 'demo' });
  assert.deepEqual(sections(filtered), { live: [mine.sessionId], exited: [] },
    "the other project's exited worker must be filtered out too, not just its live one");
  assert.ok(!filtered.includes(theirs.sessionId));

  // A name matching nothing is an empty list that says why it is empty.
  assert.equal(await callTool('list_instances', { project: 'no-such-project' }),
    'INSTANCES (none)  project no-such-project');
});

test('rows are grouped by project rather than by spawn order', async () => {
  // Interleave the spawns so byId insertion order and the intended order differ:
  // a pass-through of Map order would return a,b,a — the grouping makes it a,a,b.
  await api(baseUrl, 'POST', '/api/projects', { name: 'aaa' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'bbb' });
  const a1 = await spawnTemp('aaa');
  const b1 = await spawnTemp('bbb');
  const a2 = await spawnTemp('aaa');

  const { live } = sections(await callTool('list_instances'));
  assert.deepEqual(live, [a1.sessionId, a2.sessionId, b1.sessionId],
    'both aaa workers must be adjacent, in spawn order, ahead of bbb');
});
