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
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', persistent: true });
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

// ── A caller-less (UI) resume of a conducted worker keeps its recorded lineage ──

// A persistent husk `W` that conductor `a` resumed (so it is conducted, stored
// parent `a`), then stopped with a transcript on disk: ready for a UI resume.
async function stoppedOwnedWorker(project, spawner, extra = {}) {
  const husk = await handSpawned(project);
  const place = localPlace(path.join(process.env.PROJECTS_ROOT, project));
  const seed = () => seedSessionJsonl(place, husk.backingSessionId);
  await seed();
  await kill(husk.sessionId);
  await spawnFrom(spawner.sessionId, { resume: husk.sessionId, ...extra });
  await kill(husk.sessionId);
  await seed();
  return { sessionId: husk.sessionId, project };
}

async function uiResume(w) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project: w.project, resume: w.sessionId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

test('a UI resume of a conducted worker whose spawner is live restores its parent, root and caller', async () => {
  const a = await driver();
  const w = await stoppedOwnedWorker('own-live-parent', a);
  const inst = await uiResume(w);
  const sum = inst.summary();
  assert.equal(sum.parentSessionId, a.sessionId);
  assert.equal(sum.rootSessionId, a.sessionId);
  assert.equal(sum.callerInstanceId, a.id, 'the live spawn edge is re-formed');
  const row = (await api(baseUrl, 'GET', '/api/instances')).body.find(r => r.sessionId === w.sessionId);
  assert.equal(row.parentSessionId, a.sessionId, 'GET /api/instances');
  assert.equal(row.rootSessionId, a.sessionId, 'GET /api/instances');
  assert.ok(instances.conductedSubtreeOf(a.id).some(r => r.sessionId === w.sessionId),
    "the spawner's subtree (the next restart's worker list) lists the worker");
});

test('a UI resume of a conducted worker whose spawner is not live keeps the stored parent and root, with no caller', async () => {
  const a = await driver();
  const w = await stoppedOwnedWorker('own-dead-parent', a);
  await kill(a.sessionId);
  const inst = await uiResume(w);
  const sum = inst.summary();
  assert.equal(sum.parentSessionId, a.sessionId);
  assert.equal(sum.rootSessionId, a.sessionId);
  assert.equal(sum.callerInstanceId, null);
});

test("nested: a UI resume of a section lead's worker restores the lead as parent and the top conductor as root", async () => {
  const a = await driver();
  const lead = await spawnFrom(a.sessionId, { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const w = await stoppedOwnedWorker('own-nested', lead, { playbook: 'freeform', stage: 'freeform' });
  const inst = await uiResume(w);
  const sum = inst.summary();
  assert.equal(sum.parentSessionId, lead.sessionId);
  assert.equal(sum.rootSessionId, a.sessionId, 'the root follows the stored chain, not one hop');
  assert.equal(sum.callerInstanceId, instForSession(instances, lead.sessionId).id);
});

// Conductor `a` (stopped, then resumed as `a2`) and its worker `w`, which a UI resume started
// while `a` was down: running, conducted, recorded parent `a`, no owner.
async function unownedWorkerWithResumedSpawner(project) {
  const a = await driver();
  const w = await stoppedOwnedWorker(project, a);
  const aBacking = a.backingSessionId;
  const aSid = a.sessionId;
  await kill(aSid);
  const inst = await uiResume(w);
  assert.equal(inst.summary().callerInstanceId, null, 'premise: the worker came up before its spawner');
  // The conductor's transcript must exist to resume it.
  await seedSessionJsonl(localPlace(path.join(process.env.PROJECTS_ROOT, CONDUCT_PROJECT_NAME)), aBacking);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: CONDUCT_PROJECT_NAME, resume: aSid, playbookEnforcement: 'warn', mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a2 = instances.get(r.body.id);
  await waitFor(() => a2.status === 'idle');
  return { w, inst, a2, aSid };
}

// Records the `status` summaries `inst` emits while `fn` runs.
async function statusesDuring(inst, fn) {
  const statuses = [];
  const onStatus = (sum) => { if (sum?.id === inst.id) statuses.push(sum); };
  instances.on('status', onStatus);
  try { await fn(); } finally { instances.off('status', onStatus); }
  return statuses;
}

test("a conductor's spawn_instance({resume}) adopts its own worker that a UI resume started before it was live; another conductor is refused", async () => {
  const b = await driver();
  const { w, inst, a2, aSid } = await unownedWorkerWithResumedSpawner('own-adopt');

  const refused = await rpcJson(b.sessionId, 'spawn_instance', { resume: w.sessionId, mode: 'bypassPermissions' });
  assert.match(JSON.stringify(refused.body), /already attached/, 'a conductor that is not the recorded spawner is refused');
  assert.equal(inst.summary().callerInstanceId, null, 'and the worker stays unowned');

  const view = unwrap(await callTool('spawn_instance', { resume: w.sessionId, title: 'adopted worker', mode: 'bypassPermissions' }, { caller: aSid }));
  assert.equal(view.sessionId, w.sessionId, JSON.stringify(view));
  assert.equal(instForSession(instances, w.sessionId), inst, 'the running instance was adopted, not a second process');
  assert.equal(inst.summary().title, 'adopted worker', "the adopting call's title is applied to the adopted session");
  assert.equal(inst.summary().callerInstanceId, a2.id);
  assert.equal(inst.summary().parentSessionId, aSid);
  assert.equal(inst.summary().rootSessionId, aSid);
});

test('adoption broadcasts a status summary carrying the new owner on its own, with no title to emit one', async () => {
  const { w, inst, a2, aSid } = await unownedWorkerWithResumedSpawner('own-adopt-emit');
  const statuses = await statusesDuring(inst, async () => {
    const view = unwrap(await callTool('spawn_instance', { resume: w.sessionId, mode: 'bypassPermissions' }, { caller: aSid }));
    assert.equal(view.sessionId, w.sessionId, JSON.stringify(view));
  });
  assert.equal(inst.summary().callerInstanceId, a2.id, 'premise: the worker was adopted');
  assert.ok(statuses.some(x => x.callerInstanceId === a2.id), 'a summary with the new owner is emitted, so lists refresh');
});

test('adoption refuses a worker whose owner is live, even its recorded spawner: already attached, instance unchanged', async () => {
  const a = await driver();
  const w = await stoppedOwnedWorker('own-owned', a);
  await spawnFrom(a.sessionId, { resume: w.sessionId });
  const inst = instForSession(instances, w.sessionId);
  assert.equal(inst.summary().callerInstanceId, a.id, 'premise: the spawner already owns the running worker');
  const statuses = await statusesDuring(inst, async () => {
    const refused = await rpcJson(a.sessionId, 'spawn_instance', { resume: w.sessionId, mode: 'bypassPermissions' });
    assert.match(JSON.stringify(refused.body), /already attached/);
  });
  assert.equal(instForSession(instances, w.sessionId), inst, 'no second process');
  assert.equal(inst.summary().callerInstanceId, a.id);
  assert.equal(inst.summary().parentSessionId, a.sessionId);
  assert.equal(inst.summary().rootSessionId, a.sessionId);
  assert.deepEqual(statuses, [], 'a refusal re-forms and broadcasts nothing');
});

test("nested: a UI resume of a worker whose section lead is stopped keeps the lead as parent and the top conductor as root, read from the stored chain", async () => {
  const a = await driver();
  const lead = await spawnFrom(a.sessionId, { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const w = await stoppedOwnedWorker('own-nested-dead', lead, { playbook: 'freeform', stage: 'freeform' });
  await kill(lead.sessionId);
  const sum = (await uiResume(w)).summary();
  assert.equal(sum.parentSessionId, lead.sessionId, 'the recorded spawner, though it is not running');
  assert.equal(sum.rootSessionId, a.sessionId, 'climbed through the stopped lead to the top conductor, not the lead itself');
  assert.equal(sum.callerInstanceId, null, 'no live spawner to own it');
});
