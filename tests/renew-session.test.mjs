// Integration tests for the renew_session MCP tool — a managed, server-driven
// `/clear` that rotates the calling session's context in place (same process,
// new sessionId) and reseeds it with a self-authored summary plus a
// server-generated mechanical state block. See src/sessionRenew.js +
// src/mcp/handlers.js (renewSession).
//
// The fake CLI can't call MCP tools, so each test arms the renewal out of
// band (POST /mcp?caller=<sid>) and then drives a turn_end with send_prompt —
// faithfully standing in for the model finishing the turn the tool was called
// in. The fixture's `/clear` turn emits a system/init with a fixed NEW sessionId
// so the real Instance rotation-follow fires; observing that rotation is itself
// proof the `/clear` text was written to the CLI and matched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { isConducted } from '../src/conductedSessions.js';
import { isTemp } from '../src/tempSessions.js';
import { isArchived } from '../src/archivedSessions.js';
import { getTitle } from '../src/sessionTitles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-renew.json');
// Must match the session_id the `/clear` turn emits in scenario-renew.json.
const NEW_SID = 'c0000000-0000-4000-8000-000000000001';

let nextRpcId = 1;
// Set to the live manager by each test after bootServer. `?caller=` now carries the
// stable INSTANCE id (what Instance.spawn bakes), so translate a caller sessionId to
// its instanceId here; a value that resolves to no instance (bogus/absent) passes
// through so the "no caller" refusal paths still fire.
let mgr = null;
async function rpc(baseUrl, method, params, { caller } = {}) {
  const handle = caller ? (instForSession(mgr, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(baseUrl, name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}
const userTexts = (transcript) =>
  transcript.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((o) => o.type === 'user')
    .map((o) => (o.message?.content ?? []).map((c) => c.text ?? '').join(' '));

test('renew_session drives a /clear that rotates the session in place and reseeds with the summary', async () => {
  const transcript = path.join(os.tmpdir(), `renew-tx-${process.pid}.jsonl`);
  await fs.rm(transcript, { force: true });
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  const srv = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // Plain, non-conducted (UI-spawned) worker — the tool must work for any
    // code-conductor-managed session, not just orchestrator-spawned ones.
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    assert.equal(spawn.status, 201);
    const sid1 = spawn.body.sessionId;
    const instanceId = spawn.body.id;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const pidBefore = instForSession(srv.instances, sid1).pid;

    const armed = await callTool(srv.baseUrl, 'renew_session', { summary: 'HANDOFF-XYZ: finish task Q' }, { caller: sid1 });
    assert.equal(armed.ok, true);
    assert.equal(armed.willClearAtTurnEnd, true);

    // End the turn the tool was "called in" → the renewal fires.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    const rotated = instForSession(srv.instances, NEW_SID);
    assert.ok(rotated, 'a live instance now carries the rotated sessionId');
    assert.equal(rotated.id, instanceId, 'same Instance object across the in-place clear');
    assert.equal(rotated.pid, pidBefore, 'same OS process (pid unchanged) — in-place clear, not respawn');
    assert.equal(instForSession(srv.instances, sid1), undefined, 'old sessionId no longer maps to a live instance');

    const seedEcho = rotated.ringSnapshot().find(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('HANDOFF-XYZ'));
    assert.ok(seedEcho, 'summary was injected as a user turn on the cleared session');
    assert.ok(seedEcho.text.includes('MECHANICAL STATE'), 'mechanical state block was appended to the seed');

    await waitFor(async () => (await fs.readFile(transcript, 'utf8').catch(() => '')).includes('HANDOFF-XYZ'));
    const texts = userTexts(await fs.readFile(transcript, 'utf8'));
    const iGo = texts.findIndex((t) => t.includes('go1'));
    const iClear = texts.findIndex((t) => t.trim() === '/clear');
    const iSeed = texts.findIndex((t) => t.includes('HANDOFF-XYZ'));
    assert.ok(iGo >= 0 && iClear > iGo && iSeed > iClear,
      `stdin order should be go1 < /clear < seed; got ${JSON.stringify(texts)}`);
  } finally {
    await srv.close();
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await fs.rm(transcript, { force: true });
  }
});

test('renew_session carries the durable temp + conducted markers onto the rotated id and archives the old one', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // spawn_instance defaults to temp:true AND conducted:true — the one call that
    // exercises BOTH durable sidecars in a single rotation.
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);
    const id = inst.id;
    assert.equal(inst.conducted, true, 'spawn_instance yields a conducted worker');
    assert.equal(inst.temp, true, 'spawn_instance yields a temp worker');
    // temp is durably marked at spawn; conducted is marked on the first turn_end
    // (_writeSessionMetadata), i.e. by the armed 'go1' turn below — so only assert
    // the temp sidecar pre-renewal.
    await waitFor(async () => await isTemp(sid1));

    await callTool(srv.baseUrl, 'renew_session', { summary: 'carry on with the migration' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    const rotated = instForSession(srv.instances, NEW_SID);
    assert.equal(rotated.id, id, 'same Instance across the clear');
    assert.equal(rotated.conducted, true, 'rotated session is still conducted');
    assert.equal(rotated.temp, true, 'rotated session is still temp');
    // Both durable markers followed the rotation onto the new sessionId — the
    // explicit carry at rotation, independent of the reseed turn_end's incidental
    // _writeSessionMetadata re-write.
    await waitFor(async () => (await isConducted(NEW_SID)) && (await isTemp(NEW_SID)));
    // The abandoned pre-clear id is archived (retained-but-hidden) and its stale
    // temp marker is cleaned. (We deliberately do NOT unmarkConducted the old id —
    // mirroring _archiveTempSession, a conducted marker stays meaningful on an
    // archived row — but the fixture never durably writes one on the old id, so
    // there is nothing to assert there.)
    await waitFor(async () => await isArchived(sid1));
    assert.equal(await isTemp(sid1), false, 'stale temp marker on the old id was cleaned');
  } finally {
    await srv.close();
  }
});

test('renew_session carries a custom session title onto the rotated id', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');

    // Persist a custom title on the pre-clear id (route sets both the sidecar and
    // the instance's in-memory this.title, which the carry reads).
    const TITLE = 'Migration follow-up';
    const put = await api(srv.baseUrl, 'PUT', `/api/sessions/${sid1}/title`, { title: TITLE });
    assert.equal(put.status, 200);
    await waitFor(async () => (await getTitle(sid1)) === TITLE);

    await callTool(srv.baseUrl, 'renew_session', { summary: 'keep the title' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    // No turn_end path writes the title sidecar, so this is proof of the explicit
    // carry — the rotated id inherits the title (and the in-memory title too).
    await waitFor(async () => (await getTitle(NEW_SID)) === TITLE);
    assert.equal(instForSession(srv.instances, NEW_SID).title, TITLE, 'in-memory title survived the rotation');
  } finally {
    await srv.close();
  }
});

test('renew_session: an outgoing idle subscription survives the caller\'s /clear with no migration', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // `worker` is watched; `sub` watches it and then renews ITSELF — the
    // self-renewal case where the caller's own sessionId rotates while it holds
    // an outgoing subscription. Because the idle-subscription graph is keyed by
    // the stable instanceId (which /clear preserves), the entry is untouched by
    // the rotation — nothing to re-key. The snapshot is a sessionId-shaped view,
    // so it simply reflects the caller's CURRENT (rotated) sessionId.
    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sub = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const wSid = worker.sessionId, sSid = sub.sessionId;
    await waitFor(() => instForSession(srv.instances, wSid)?.status === 'idle'
      && instForSession(srv.instances, sSid)?.status === 'idle');

    await callTool(srv.baseUrl, 'subscribe_to_idle', { sessionId: wSid }, { caller: sSid });
    let snap = srv.instances._idleSubscriberSnapshot();
    assert.ok(snap[wSid]?.includes(sSid), 'subscription registered under the caller\'s original sid');

    await callTool(srv.baseUrl, 'renew_session', { summary: 'keep watching the worker' }, { caller: sSid });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sSid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    snap = srv.instances._idleSubscriberSnapshot();
    assert.ok(snap[wSid]?.includes(NEW_SID), 'subscription still present, now shown under the rotated caller sid');
    assert.ok(!snap[wSid]?.includes(sSid), 'stale caller sid no longer resolves — not orphaned on the dead id');
  } finally {
    await srv.close();
  }
});

test('renew_session defers the /clear while an overage-queued turn is pending, then proceeds once it drains', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const id = instForSession(srv.instances, sid1).id;

    await callTool(srv.baseUrl, 'renew_session', { summary: 'renew me later' }, { caller: sid1 });
    const inst = instForSession(srv.instances, sid1);
    // Stand in for a user turn parked in the overage queue at turn_end (the real
    // stop→idle-with-queued-work case). We drive the armed turn_end DIRECTLY
    // rather than via send_prompt: a real prompt fires user_prompt → cancel(),
    // which empties _overageQueue (overageResume.js) — so it could never leave a
    // queued entry standing at turn_end. This isolates the controller's defer gate.
    inst._overageQueue.push({ text: 'queued task', attachments: [], ts: 1 });
    srv.instances.emit('event', { id, ev: { kind: 'turn_end' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(instForSession(srv.instances, NEW_SID), undefined, 'no rotation while a queued turn is pending');
    const pend = srv.instances._sessionRenew.pending.get(id);
    assert.ok(pend && pend.state === 'armed', 'renewal is still armed (deferred), not fired');

    // Drain the queue and drive another turn_end — the renewal now proceeds.
    inst._overageQueue.length = 0;
    srv.instances.emit('event', { id, ev: { kind: 'turn_end' } });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    assert.ok(instForSession(srv.instances, NEW_SID), 'rotation proceeds once the queue drains');
    assert.ok(!srv.instances._sessionRenew.pending.has(id), 'pending renewal consumed');
  } finally {
    await srv.close();
  }
});

// The `?caller=` staleness regression: the baked caller handle is the stable
// INSTANCE id, so it keeps resolving after a /clear rotates the sessionId in place
// — repeated renewal works. On the old sessionId-baked behavior the second
// (post-rotation) call resolved to a rotated-away id and soft-refused. The rpc
// helper passes `caller` through unchanged when it's already an instanceId.
test('renew_session: the baked caller handle survives a /clear so a session can renew repeatedly', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    const handle = spawn.body.id; // the stable instanceId — exactly what Instance.spawn bakes into ?caller=
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');

    // First caller-addressed call: the handle resolves to the pre-rotation sessionId.
    const r1 = await callTool(srv.baseUrl, 'renew_session', { summary: 'first handoff' }, { caller: handle });
    assert.equal(r1.ok, true);
    assert.equal(r1.sessionId, sid1, 'caller handle resolves to the current sessionId (pre-rotation)');

    // End the turn → the managed /clear rotates sid1 → NEW_SID in place.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    assert.equal(instForSession(srv.instances, sid1), undefined, 'old sessionId rotated away');

    // SECOND caller-addressed call with the SAME baked handle, AFTER the rotation.
    // This is the regression: it must resolve to the CURRENT (rotated) sessionId,
    // not soft-refuse SESSION_UNKNOWN on the stale id.
    const r2 = await callTool(srv.baseUrl, 'renew_session', { summary: 'second handoff' }, { caller: handle });
    assert.equal(r2.ok, true, 'caller still resolves after the rotation (not SESSION_UNKNOWN)');
    assert.equal(r2.sessionId, NEW_SID, 'caller handle now resolves to the rotated sessionId');
  } finally {
    await srv.close();
  }
});

test('renew_session: the mechanical state block lists live spawned workers and idle subscriptions', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // `conductor` spawns `worker` via spawn_instance with ?caller=conductor, so
    // Instance.callerInstanceId links them — the ownership tracking liveOwnedBy()
    // relies on.
    const conductorSpawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const conductorSid = conductorSpawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, conductorSid)?.status === 'idle');

    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' }, { caller: conductorSid });
    const workerSid = worker.sessionId;
    await waitFor(() => instForSession(srv.instances, workerSid)?.status === 'idle');

    // Conductor subscribes to the worker's idle callback.
    await callTool(srv.baseUrl, 'subscribe_to_idle', { sessionId: workerSid }, { caller: conductorSid });

    await callTool(srv.baseUrl, 'renew_session', { summary: 'HANDOFF-STATE-1' }, { caller: conductorSid });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: conductorSid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    const rotated = instForSession(srv.instances, NEW_SID);
    const seedEcho = rotated.ringSnapshot().find(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('HANDOFF-STATE-1'));
    assert.ok(seedEcho, 'summary was injected');
    assert.ok(seedEcho.text.includes(workerSid), 'state block lists the live spawned worker by sessionId');
    assert.ok(seedEcho.text.includes('project=p'), 'state block carries the worker project');
    // The worker sessionId also appears as a pending idle subscription entry.
    const subsSection = seedEcho.text.split('pending idle subscriptions')[1] ?? '';
    assert.ok(subsSection.includes(workerSid), 'state block lists the pending idle subscription');
  } finally {
    await srv.close();
  }
});

test('renew_session: the state block is composed at reseed time, not arm time', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const conductorSpawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const conductorSid = conductorSpawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, conductorSid)?.status === 'idle');

    // Arm renewal BEFORE the worker even exists.
    await callTool(srv.baseUrl, 'renew_session', { summary: 'HANDOFF-STATE-2' }, { caller: conductorSid });

    // Spawn the worker (and subscribe) AFTER arming, but before the turn ends.
    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' }, { caller: conductorSid });
    const workerSid = worker.sessionId;
    await waitFor(() => instForSession(srv.instances, workerSid)?.status === 'idle');
    await callTool(srv.baseUrl, 'subscribe_to_idle', { sessionId: workerSid }, { caller: conductorSid });

    // NOW end the turn — the clear (and state-block composition) fires here.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: conductorSid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    const rotated = instForSession(srv.instances, NEW_SID);
    const seedEcho = rotated.ringSnapshot().find(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('HANDOFF-STATE-2'));
    assert.ok(seedEcho, 'summary was injected');
    assert.ok(seedEcho.text.includes(workerSid),
      'worker spawned AFTER arm (before reseed) still appears — block reflects state at reseed time, not arm time');
  } finally {
    await srv.close();
  }
});

test('renew_session: the state block renders (none) when there are no owned workers or subscriptions', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');

    await callTool(srv.baseUrl, 'renew_session', { summary: 'HANDOFF-EMPTY' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    const rotated = instForSession(srv.instances, NEW_SID);
    const seedEcho = rotated.ringSnapshot().find(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('HANDOFF-EMPTY'));
    assert.ok(seedEcho, 'summary was injected');
    const noneCount = (seedEcho.text.match(/\(none\)/g) ?? []).length;
    assert.equal(noneCount, 2, 'both the workers and subscriptions sections render (none)');
  } finally {
    await srv.close();
  }
});

// Real-binary confirmation that `_sendRaw` of a `/clear` user message actually
// rotates the session on the real claude CLI (the fake fixture only simulates
// the rotation). Gated behind RUN_REAL_CLAUDE=1 — needs auth + network.
test('renew_session against the real claude binary rotates the sessionId', { skip: process.env.RUN_REAL_CLAUDE !== '1' }, async () => {
  const srv = await bootServer({ useRealClaude: true });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle', { timeout: 30000 });
    const pidBefore = instForSession(srv.instances, sid1).pid;

    await callTool(srv.baseUrl, 'renew_session', { summary: 'REAL-SMOKE: continue' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'hello' });

    await waitFor(() => {
      const cur = srv.instances.get(instForSession(srv.instances, sid1)?.id ?? spawn.body.id);
      return cur && cur.sessionId !== sid1 && cur.status === 'idle';
    }, { timeout: 60000 });
    const rotated = srv.instances.get(spawn.body.id);
    assert.notEqual(rotated.sessionId, sid1, 'real /clear rotated the sessionId');
    assert.equal(rotated.pid, pidBefore, 'same process across the real /clear');
  } finally {
    await srv.close();
  }
});
