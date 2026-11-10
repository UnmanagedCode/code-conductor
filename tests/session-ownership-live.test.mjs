// Live session ownership: `ownerSessionId` is the public sessionId of the ROOT
// of a live worker's spawn chain — resolved once at create, in memory only,
// reported only while the worker is live, and re-formed by whoever resumes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupIdleWake, ctx, callTool, unwrap } from './idleWakeCase.mjs';
import { api, waitFor, instForSession, seedSessionJsonl } from './helpers.mjs';
import { localPlace } from '../src/projects.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

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

test('a worker spawned by a conductor is owned by it; the conductor itself has no owner', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const worker = await spawnFrom(cond.sessionId, { project: 'demo' });
  assert.equal(worker.ownerSessionId, cond.sessionId, 'the spawn_instance view carries the owner');
  assert.equal(instForSession(instances, worker.sessionId).summary().ownerSessionId, cond.sessionId);
  assert.equal(cond.summary().ownerSessionId, null, 'a root conductor → null');
  const rows = (await api(baseUrl, 'GET', '/api/instances')).body;
  assert.equal(rows.find(r => r.sessionId === worker.sessionId).ownerSessionId, cond.sessionId, 'GET /api/instances');
});

test('a conducted session spawned anonymously (no caller path) has no owner', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const orphan = await spawnFrom(null, { project: 'demo' });
  assert.equal(orphan.ownerSessionId, null);
});

test('nested: a grandchild is owned by the ROOT conductor, and stays so after the intermediate section lead is gone', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  // The intermediate spawner is a section lead: a `.conduct` session a conductor spawned.
  const worker = await spawnFrom(cond.sessionId, { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const grandchild = await spawnFrom(worker.sessionId, { project: 'demo', playbook: 'freeform', stage: 'freeform' });
  assert.equal(grandchild.ownerSessionId, cond.sessionId, 'the root, not the immediate spawner');

  const workerInst = await kill(worker.sessionId);
  await waitFor(() => !instances.byId.has(workerInst.id));
  assert.equal(instForSession(instances, grandchild.sessionId).summary().ownerSessionId, cond.sessionId,
    'resolved at create, so it survives the intermediate section lead leaving byId');
});

test('a killed worker reports no owner the moment it exits', async () => {
  const cond = await driver();
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const worker = await spawnFrom(cond.sessionId, { project: 'demo' });
  const inst = await kill(worker.sessionId);
  assert.equal(inst.summary().ownerSessionId, null);
});

test('resume re-links: whichever conductor resumes the worker owns it; disk rows carry no owner key', async () => {
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
  assert.equal(first.ownerSessionId, a.sessionId);
  await kill(sessionId);
  await seed();
  const second = await spawnFrom(b.sessionId, { resume: sessionId });
  assert.equal(second.ownerSessionId, b.sessionId, 'the resuming conductor, not the earlier one');

  await kill(sessionId);
  await seed();
  const sessions = (await api(baseUrl, 'GET', `/api/projects/${project}/sessions`)).body;
  const rows = Array.isArray(sessions) ? sessions : sessions.sessions;
  assert.ok(rows.length > 0, 'premise: the session has a disk row');
  for (const r of rows) assert.ok(!('ownerSessionId' in r), 'a disk row never carries ownerSessionId');
});

test('the owner flag renders on the LIVE worker block of list_sessions', async () => {
  const cond = await driver();
  const project = `own-demo${n}`;
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const worker = await spawnFrom(cond.sessionId, { project });
  const text = (await callTool('list_sessions', { project })).content[0].text;
  const block = text.slice(text.indexOf(`LIVE ${worker.sessionId}`)).split('\n\n')[0];
  assert.match(block, new RegExp(`flags .*owner ${cond.sessionId}`));
});

test('a hand-spawned session is a worker: its spawn_instance is refused TOOL_UNAVAILABLE_TO_CALLER', async () => {
  const hand = await handSpawned(`own-h${++n}`);
  const { body } = await rpcJson(hand.sessionId, 'spawn_instance', { project: 'demo' });
  assert.equal(body.error.data.code, 'TOOL_UNAVAILABLE_TO_CALLER');
});
