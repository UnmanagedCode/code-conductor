// Live spawn-tree links: `rootSessionId` / `parentSessionId` are the public
// sessionIds of the ROOT of a live worker's spawn chain and of its immediate
// spawner — resolved once at create, in memory only, reported only while the
// worker is live, and re-formed by whoever resumes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupIdleWake, ctx, callTool, unwrap } from './idleWakeCase.mjs';
import { api, waitFor, instForSession, seedSessionJsonl } from './helpers.mjs';
import { localPlace } from '../src/projects.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { CONDUCTOR_VIEW_KEYS } from '../src/mcp/handlers.ts';

let baseUrl, instances;
setupIdleWake((c) => { ({ baseUrl, instances } = c); });

let n = 0;
async function rpcJson(caller, name, args) {
  const res = await fetch(`${baseUrl}/mcp/${encodeURIComponent(caller)}?format=json`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { body: await res.json() };
}
// A `.conduct` conductor (REST, non-conducted) — the only kind of session offered
// the spawn tools. `warn` keeps ungoverned spawns proceeding (default `enforce`).
async function driver() {
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: CONDUCT_PROJECT_NAME, role: 'conductor', playbookEnforcement: 'warn', mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

// A hand-spawned (REST, non-conducted) project session.
async function handSpawned(project) {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', temp: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

async function spawnFrom(caller, args) {
  const view = unwrap(await callTool('spawn_instance', { mode: 'bypassPermissions', ...args }, caller ? { caller } : undefined));
  assert.ok(view.sessionId, JSON.stringify(view));
  await waitFor(() => instForSession(instances, view.sessionId)?.status === 'idle');
  return view;
}

async function kill(sessionId) {
  const inst = instForSession(instances, sessionId);
  await inst.kill({ graceMs: 50 });
  await waitFor(() => !inst.proc && (inst.status === 'exited' || inst.status === 'crashed'));
  return inst;
}

test('a worker spawned by a conductor has it as root and parent; the conductor itself has neither', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const worker = await spawnFrom(cond.sessionId, { project: 'demo' });
  assert.equal(worker.rootSessionId, cond.sessionId, 'the spawn_instance view carries the root');
  assert.equal(worker.parentSessionId, cond.sessionId, 'the spawn_instance view carries the parent');
  const sum = instForSession(instances, worker.sessionId).summary();
  assert.equal(sum.rootSessionId, cond.sessionId);
  assert.equal(sum.parentSessionId, cond.sessionId);
  assert.equal(cond.summary().rootSessionId, null, 'a root conductor → null');
  assert.equal(cond.summary().parentSessionId, null, 'a root conductor → null');
  const rows = (await api(baseUrl, 'GET', '/api/instances')).body;
  const row = rows.find(r => r.sessionId === worker.sessionId);
  assert.equal(row.rootSessionId, cond.sessionId, 'GET /api/instances');
  assert.equal(row.parentSessionId, cond.sessionId, 'GET /api/instances');
});

test('a conducted session spawned anonymously (no caller path) has no root and no parent', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const orphan = await spawnFrom(null, { project: 'demo' });
  assert.equal(orphan.rootSessionId, null);
  assert.equal(orphan.parentSessionId, null);
});

test("nested: a section lead's worker has the lead as parent and the top conductor as root, and keeps both after the lead is gone", async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  // The intermediate spawner is a section lead: a `.conduct` session a conductor spawned.
  const lead = await spawnFrom(cond.sessionId, { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const grandchild = await spawnFrom(lead.sessionId, { project: 'demo', playbook: 'freeform', stage: 'freeform' });
  assert.equal(grandchild.parentSessionId, lead.sessionId, 'the spawn view: parent is the immediate spawner');
  assert.equal(grandchild.rootSessionId, cond.sessionId, 'the spawn view: root is the top conductor');
  const gInst = instForSession(instances, grandchild.sessionId);
  assert.equal(gInst.summary().parentSessionId, lead.sessionId);
  assert.equal(gInst.summary().rootSessionId, cond.sessionId);
  const rows = (await api(baseUrl, 'GET', '/api/instances')).body;
  const row = rows.find(r => r.sessionId === grandchild.sessionId);
  assert.equal(row.parentSessionId, lead.sessionId, 'GET /api/instances');
  assert.equal(row.rootSessionId, cond.sessionId, 'GET /api/instances');

  const leadInst = await kill(lead.sessionId);
  await waitFor(() => !instances.byId.has(leadInst.id));
  assert.equal(gInst.summary().parentSessionId, lead.sessionId, 'still names the exited lead');
  assert.equal(gInst.summary().rootSessionId, cond.sessionId,
    'resolved at create, so it survives the intermediate section lead leaving byId');
});

test('a killed worker reports neither root nor parent the moment it exits', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const worker = await spawnFrom(cond.sessionId, { project: 'demo' });
  const inst = await kill(worker.sessionId);
  assert.equal(inst.summary().rootSessionId, null);
  assert.equal(inst.summary().parentSessionId, null);
});

test('resume re-links: whichever conductor resumes the worker becomes its root and parent; disk rows carry neither key', async () => {
  const a = await driver();
  const b = await driver();
  const project = `own-w${n}`;
  const husk = await handSpawned(project);
  const sessionId = husk.sessionId;
  const place = localPlace(path.join(process.env.PROJECTS_ROOT, project));
  // The fake engine writes no transcript and a resume requires one.
  const seed = () => seedSessionJsonl(place, husk.backingSessionId);
  await seed();
  await kill(sessionId);

  const first = await spawnFrom(a.sessionId, { resume: sessionId });
  assert.equal(first.rootSessionId, a.sessionId);
  assert.equal(first.parentSessionId, a.sessionId);
  await kill(sessionId);
  await seed();
  const second = await spawnFrom(b.sessionId, { resume: sessionId });
  assert.equal(second.rootSessionId, b.sessionId, 'the resuming conductor, not the earlier one');
  assert.equal(second.parentSessionId, b.sessionId, 'the resuming conductor, not the earlier one');

  await kill(sessionId);
  await seed();
  const sessions = (await api(baseUrl, 'GET', `/api/projects/${project}/sessions`)).body;
  const rows = Array.isArray(sessions) ? sessions : sessions.sessions;
  assert.ok(rows.length > 0, 'premise: the session has a disk row');
  for (const r of rows) assert.ok(!('rootSessionId' in r) && !('parentSessionId' in r), 'a disk row never carries the spawn-tree links');
});

test('the root and parent flags render on the LIVE worker block of list_sessions', async () => {
  const cond = await driver();
  const project = `own-demo${n}`;
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const worker = await spawnFrom(cond.sessionId, { project });
  const text = (await callTool('list_sessions', { project })).content[0].text;
  const block = text.slice(text.indexOf(`LIVE ${worker.sessionId}`)).split('\n\n')[0];
  assert.match(block, new RegExp(`flags .*root ${cond.sessionId}`));
  assert.match(block, new RegExp(`flags .*parent ${cond.sessionId}`));
});

test('a hand-spawned session is a worker: its spawn_instance is refused TOOL_UNAVAILABLE_TO_CALLER', async () => {
  const hand = await handSpawned(`own-h${++n}`);
  const { body } = await rpcJson(hand.sessionId, 'spawn_instance', { project: 'demo' });
  assert.equal(body.error.data.code, 'TOOL_UNAVAILABLE_TO_CALLER');
});

test('ownerSessionId is gone from summary(), GET /api/instances and the MCP view', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const worker = await spawnFrom(cond.sessionId, { project: 'demo' });
  const inst = instForSession(instances, worker.sessionId);
  assert.ok(!('ownerSessionId' in inst.summary()), 'summary()');
  const rows = (await api(baseUrl, 'GET', '/api/instances')).body;
  assert.ok(!('ownerSessionId' in rows.find(r => r.sessionId === worker.sessionId)), 'GET /api/instances');
  assert.ok(!('ownerSessionId' in worker), 'the spawn_instance view');
  const described = JSON.parse((await rpcJson(cond.sessionId, 'describe_session', { sessionId: worker.sessionId })).body.result.content[0].text);
  assert.ok(!('ownerSessionId' in described), 'describe_session live result');
  assert.ok(!CONDUCTOR_VIEW_KEYS.includes('ownerSessionId'), 'the conductor view allowlist');
});
