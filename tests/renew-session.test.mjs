// Integration tests for the renew_session MCP tool — a managed, server-driven
// `/clear` that rotates the calling session's context in place (same process,
// new sessionId) and reseeds it with a self-authored summary plus a
// server-generated mechanical state block. See src/sessionRenew.ts +
// src/mcp/handlers.ts (renewSession).
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
import { isConducted } from '../src/conductedSessions.ts';
import { isTemp } from '../src/tempSessions.ts';
import { isArchived } from '../src/archivedSessions.ts';
import { getTitle } from '../src/sessionTitles.ts';
import { getSessionMode } from '../src/sessionModes.ts';
import { encodeCwd } from '../src/projects.ts';

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

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
    const rotated = instForSession(srv.instances, NEW_SID);
    assert.ok(rotated, 'a live instance now carries the rotated sessionId');
    assert.equal(rotated.id, instanceId, 'same Instance object across the in-place clear');
    assert.equal(rotated.pid, pidBefore, 'same OS process (pid unchanged) — in-place clear, not respawn');
    // INVERTED by card 2026-0126, and this is the point of the card: the id the
    // caller holds keeps resolving to the same live instance across the rotation.
    // Both forms — the pinned public id and the new backing id — name it.
    assert.equal(instForSession(srv.instances, sid1)?.id, instanceId,
      'the public id still maps to the same live instance');
    assert.equal(rotated.sessionId, sid1, 'and the public id itself never moved');

    // The reseed is dispatched only after the DURABLE lineage write settles (see
    // SessionRenewController), so "rotated" no longer implies "seeded".
    await waitFor(() => rotated.ringSnapshot().some(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string'
        && ev.text.startsWith('Your context was just renewed')));
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

// ---------------------------------------------------------------------------
// Durable identity across the rotation (card 2026-0126). These three are the
// point of the whole phase: the public id a conductor holds must outlive every
// `/clear`, and a resume by that id must land on the CURRENT segment.
// ---------------------------------------------------------------------------

test('identity holds across a rotation: the public id is pinned, the backing id moves', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    const firstBacking = inst.backingSessionId;
    assert.equal(publicId, firstBacking.slice(0, 8), 'the public id is 8 hex from the first backing id');

    await callTool(srv.baseUrl, 'renew_session', { summary: 'pinned-id check' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID && inst.status === 'idle');

    // The whole invariant, in three lines.
    assert.equal(inst.sessionId, publicId, 'the public id did not move');
    assert.equal(inst.summary().sessionId, publicId, 'and summary() still reports it');
    assert.notEqual(inst.backingSessionId, firstBacking, 'while the backing id rotated');

    // The backing id is deliberately ABSENT from summary() — that absence is what
    // enforces "a rotating id never reaches a conductor".
    assert.ok(!('backingSessionId' in inst.summary()),
      'summary() must never carry the backing id');

    // The lineage row lists both segments, in order, with the renew reason.
    const { segmentsFor, resolveBacking, publicIdFor } = await import('../src/sessionLineage.ts');
    await waitFor(async () => (await segmentsFor(publicId)).length === 2);
    assert.deepEqual((await segmentsFor(publicId)).map(g => [g.id, g.reason]),
      [[firstBacking, 'initial'], [NEW_SID, 'renew']]);
    assert.equal(await resolveBacking(publicId), NEW_SID, 'the public id resolves to the NEWEST segment');
    assert.equal(await publicIdFor(firstBacking), publicId, 'and the old segment still names its session');
    assert.deepEqual(inst._segments, [firstBacking, NEW_SID], 'in-memory chain mirrors the row');
  } finally {
    await srv.close();
  }
});

test('resume after rotation resumes CURRENT, not the first segment', async () => {
  // THE highest-risk edit in this card. Getting the redirection wrong resumes
  // the PRE-CLEAR transcript — which is the duplicate-worker bug this phase
  // exists to kill, wearing new clothes. So this asserts both halves: the argv
  // names `current`, and the replayed conversation is the post-clear one.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    const firstBacking = inst.backingSessionId;
    const cwd = inst.cwd;

    await callTool(srv.baseUrl, 'renew_session', { summary: 'resume-target check' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID && inst.status === 'idle');

    // The fake CLI writes no transcripts, so materialise BOTH segments with
    // distinguishable content. If the resume redirection is wrong it will find a
    // perfectly valid file — the PRE-clear one — which is exactly the silent
    // failure a file-existence-only assertion would miss.
    const dir = path.join(srv.claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    const line = (uuid, text) => JSON.stringify({
      type: 'user', uuid, message: { role: 'user', content: text },
    }) + '\n';
    await fs.writeFile(path.join(dir, `${firstBacking}.jsonl`), line('pre-1', 'PRE-CLEAR TURN'));
    await fs.writeFile(path.join(dir, `${NEW_SID}.jsonl`), line('post-1', 'POST-CLEAR TURN'));

    await callTool(srv.baseUrl, 'kill_instance', { sessionId: publicId });
    await waitFor(() => !instForSession(srv.instances, publicId));

    // Resume by the PUBLIC id — the only handle a conductor was ever given.
    const resumed = await callTool(srv.baseUrl, 'spawn_instance', { resume: publicId });
    assert.equal(resumed.sessionId, publicId, 'the resumed session reports the same public id');
    const inst2 = instForSession(srv.instances, publicId);
    await waitFor(() => inst2.status === 'idle');

    // (1) The argv names CURRENT.
    const argv = inst2._spawnArgv;
    const at = argv.indexOf('--resume');
    assert.ok(at > 0, `--resume must be in the argv: ${JSON.stringify(argv)}`);
    assert.equal(argv[at + 1], NEW_SID, '--resume must carry the CURRENT segment');
    assert.notEqual(argv[at + 1], firstBacking, 'and must NOT carry the first segment');
    assert.equal(inst2.backingSessionId, NEW_SID);

    // (2) The replayed conversation is the post-clear one.
    const echoes = inst2.ringSnapshot().filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
    assert.ok(echoes.some(t => t.includes('POST-CLEAR TURN')),
      `the post-clear transcript must be replayed; got ${JSON.stringify(echoes)}`);
    assert.ok(!echoes.some(t => t.includes('PRE-CLEAR TURN')),
      `the pre-clear transcript must NOT be replayed; got ${JSON.stringify(echoes)}`);

    // (3) …and naming the OLD segment explicitly still opens that segment — the
    // permanent full-id guarantee, for wiki pages and old kanban cards.
    const { resolveBacking } = await import('../src/sessionLineage.ts');
    assert.equal(await resolveBacking(firstBacking), firstBacking);
  } finally {
    await srv.close();
  }
});

test('no duplicate worker: the public id still resolves live after a rotation', async () => {
  // The bug in one assertion. Before this card, a conductor addressing its
  // worker after a self-renewal got SESSION_NOT_LIVE with advice to
  // `spawn_instance({resume:"<old id>"})` — spawning a SECOND worker on the same
  // worktree against the un-cleared transcript.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.sessionId;
    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    const instanceId = inst.id;

    await callTool(srv.baseUrl, 'renew_session', { summary: 'still-addressable' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID && inst.status === 'idle');

    // Addressed by the id the conductor holds: resolves LIVE, same instance.
    // (Pre-card this answered SESSION_NOT_LIVE and advised a resume, which is
    // what spawned the second worker.)
    const view = await callTool(srv.baseUrl, 'wait_for_idle', { sessionId: publicId, timeoutMs: 5000 });
    assert.notEqual(view.ok, false, `must not refuse: ${JSON.stringify(view)}`);
    assert.equal(view.sessionId, publicId);
    assert.equal(view.summary.sessionId, publicId, 'and the conductor view reports the public id');
    assert.equal(instForSession(srv.instances, publicId).id, instanceId, 'same Instance, no second worker');

    // All three accepted input forms land on the same session: the public id
    // (above), a prefix of it, and any full backing/segment id — permanently.
    const byPrefix = await callTool(srv.baseUrl, 'wait_for_idle', { sessionId: publicId.slice(0, 5), timeoutMs: 5000 });
    assert.equal(byPrefix.sessionId, publicId, 'a prefix resolves to the public id');
    const byBacking = await callTool(srv.baseUrl, 'wait_for_idle', { sessionId: NEW_SID, timeoutMs: 5000 });
    assert.equal(byBacking.sessionId, publicId, 'a full backing id resolves to the public id');
  } finally {
    await srv.close();
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
    // The temp/conducted/title/mode/backend sidecars are keyed to the TRANSCRIPT,
    // deliberately: listSessionsForCwdWithCounts looks them up by filename, so
    // re-keying them to public ids would have needed a migration. That makes the
    // carry a backing→backing move, and both ends of it are named here.
    const oldBacking = inst.backingSessionId;
    assert.notEqual(oldBacking, sid1, 'precondition: the two ids have diverged');
    assert.equal(inst.conducted, true, 'spawn_instance yields a conducted worker');
    assert.equal(inst.temp, true, 'spawn_instance yields a temp worker');
    // temp is durably marked at spawn; conducted is marked on the first turn_end
    // (_writeSessionMetadata), i.e. by the armed 'go1' turn below — so only assert
    // the temp sidecar pre-renewal.
    await waitFor(async () => await isTemp(oldBacking));

    await callTool(srv.baseUrl, 'renew_session', { summary: 'carry on with the migration' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
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
    await waitFor(async () => await isArchived(oldBacking));
    assert.equal(await isTemp(oldBacking), false, 'stale temp marker on the old id was cleaned');
    // …and the session's own identity is untouched by any of it.
    assert.equal(rotated.sessionId, sid1, 'the public id is pinned across the carry');

    // The mode record is NOT asserted here: for a bypassPermissions session the
    // system/init handler records the rotated id on the reseed turn anyway, so
    // an assertion here would pass with the carry deleted. `ask` is the mode
    // the carry actually owns — see the dedicated test at the end of this file.
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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

    snap = srv.instances._idleSubscriberSnapshot();
    // INVERTED by card 2026-0126. The snapshot projects instanceIds back through
    // `inst.sessionId`, which is now PINNED — so the rotation is invisible here
    // too: the entry does not move, and the id the conductor was given stays the
    // one it is listed under. (Pre-card it re-keyed onto the rotated id, which is
    // exactly how a conductor's held reference went stale.)
    assert.ok(snap[wSid]?.includes(sSid), 'subscription still listed under the caller\'s UNCHANGED public id');
    assert.ok(!snap[wSid]?.includes(NEW_SID), 'the internal backing id never surfaces here');
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
    // which empties _overageQueue (overageResume.ts) — so it could never leave a
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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
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

    // End the turn → the managed /clear rotates the BACKING id in place.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
    assert.equal(instForSession(srv.instances, sid1)?.backingSessionId, NEW_SID,
      'the public id still names the same instance, whose backing id rotated');

    // SECOND caller-addressed call with the SAME baked handle, AFTER the rotation.
    const r2 = await callTool(srv.baseUrl, 'renew_session', { summary: 'second handoff' }, { caller: handle });
    assert.equal(r2.ok, true, 'caller still resolves after the rotation (not SESSION_UNKNOWN)');
    // Now stronger than before: the handle resolves to the SAME id it did
    // pre-rotation, because the public id is pinned. Nothing the caller holds
    // — the baked instanceId or the sessionId it was told — ever goes stale.
    assert.equal(r2.sessionId, sid1, 'caller handle resolves to the SAME pinned public id');
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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

    const rotated = instForSession(srv.instances, NEW_SID);
    // The reseed is dispatched only after the DURABLE lineage write settles (see
    // SessionRenewController), so "rotated" no longer implies "seeded".
    await waitFor(() => rotated.ringSnapshot().some(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string'
        && ev.text.startsWith('Your context was just renewed')));
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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

    const rotated = instForSession(srv.instances, NEW_SID);
    // The reseed is dispatched only after the DURABLE lineage write settles (see
    // SessionRenewController), so "rotated" no longer implies "seeded".
    await waitFor(() => rotated.ringSnapshot().some(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string'
        && ev.text.startsWith('Your context was just renewed')));
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
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

    const rotated = instForSession(srv.instances, NEW_SID);
    // The reseed is dispatched only after the DURABLE lineage write settles (see
    // SessionRenewController), so "rotated" no longer implies "seeded".
    await waitFor(() => rotated.ringSnapshot().some(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string'
        && ev.text.startsWith('Your context was just renewed')));
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
test('rotation interlock: renew and prune refuse to interleave (SESSION_ROTATING)', async () => {
  // Prune sets `_mutating`, which makes prompt() 409 — and a renewal's reseed IS a
  // prompt(). Interleaving them clears the context and then loses the summary: no
  // memory, no signal. Unreachable today only because nothing external triggers a
  // prune; reachable the moment prune is MCP-exposed. So the two are made mutually
  // exclusive at the controller level, each refusing the later one with a code.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    // ── direction 1: renewal armed, then a prune arrives ──────────────────────
    const armed = await callTool(srv.baseUrl, 'renew_session', { summary: 'do not lose me' }, { caller: sid1 });
    assert.equal(armed.ok, true);
    assert.equal(inst.rotationPending, true, 'arming opens the rotation window');
    assert.equal(inst.rotationInFlight, 'renew');

    const pr = await api(srv.baseUrl, 'POST', `/api/instances/${inst.id}/prune`, { cutTurnIndex: 0 });
    assert.equal(pr.status, 409, `prune must be refused: ${JSON.stringify(pr.body)}`);
    assert.match(pr.body.error, /renewal is in progress/i);
    // The `code` is asserted at the throw site: the REST error handler forwards
    // only `statusCode` + message (pre-existing — BACKEND_LOCKED behaves the same),
    // while the code is what prune's future MCP surface will report.
    await assert.rejects(() => inst.pruneSession({ cutTurnIndex: 0 }),
      (e) => e.code === 'SESSION_ROTATING' && e.statusCode === 409);

    // The refusal is a REFUSAL, not a half-done rotation: the renewal is still
    // armed and still completes normally, summary and all.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
    const rotated = instForSession(srv.instances, NEW_SID);
    await waitFor(() => rotated.ringSnapshot().some(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('do not lose me')));
    // Window closed on the success path, and the completed rotation is recorded.
    await waitFor(() => rotated.rotationPending === false);
    assert.equal(rotated.rotationReason, 'renew');
    assert.ok(rotated.lastRotatedAt > 0, 'the completion is stamped');

    // ── direction 2: prune in flight, then a renewal arrives ─────────────────
    // Hold the window open by hand rather than racing a real prune: the refusal
    // reads `rotationInFlight`, which is exactly what a live prune sets.
    rotated.beginRotation('prune');
    try {
      const refused = await callTool(srv.baseUrl, 'renew_session', { summary: 'too late' }, { caller: sid1 });
      assert.equal(refused.ok, false, `renew must soft-refuse: ${JSON.stringify(refused)}`);
      assert.equal(refused.code, 'SESSION_ROTATING');
      assert.equal(refused.sessionId, sid1, 'and the refusal names the public id');
      assert.match(refused.reason, /prune is in progress/i);
    } finally {
      rotated.endRotation({ ok: false, comesUpIdle: true });
    }

    // Re-arming a RENEWAL over its own window stays idempotent — same instance,
    // same mechanism, so it is not an interleaving.
    const a1 = await callTool(srv.baseUrl, 'renew_session', { summary: 'first' }, { caller: sid1 });
    const a2 = await callTool(srv.baseUrl, 'renew_session', { summary: 'second' }, { caller: sid1 });
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, true, 'a second renew_session in the same turn must not be refused');
  } finally {
    await srv.close();
  }
});

test('an ABANDONED renewal closes the rotation window and wakes its subscriber', async () => {
  // The failure mode this guards: the rotation window is opened at arm() and the
  // idle hub defers every turn_end while it is open. If an abandonment path forgot
  // to close it, a conductor waiting on that worker would hang until the 30-minute
  // watchdog and then be told the worker "did NOT finish" — for a worker that is
  // sitting there perfectly healthy, with a renewal that simply never happened.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const target = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    const watcherSid = target.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle'
      && instForSession(srv.instances, watcherSid)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);
    const watcher = instForSession(srv.instances, watcherSid);

    // The watcher subscribes to the renewing session, with a watchdog long enough
    // that this test cannot pass by timing out.
    srv.instances.subscribeIdle(watcherSid, sid1, 600_000);
    await callTool(srv.baseUrl, 'renew_session', { summary: 'never delivered' }, { caller: sid1 });
    assert.equal(inst.rotationPending, true);

    // Abandon it: clearContext throws, which is the wedged/hung-subprocess path.
    inst.clearContext = () => { throw new Error('simulated clearContext failure'); };
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    // Window closed, nothing stamped (it never completed), and the session is
    // untouched — same backing id, no clear.
    await waitFor(() => inst.rotationPending === false);
    assert.equal(inst.lastRotatedAt, null, 'an abandoned rotation is not stamped as completed');
    assert.equal(inst.rotationReason, null);
    assert.equal(inst.sessionId, sid1, 'and the public id is untouched');

    // …and the watcher is woken NOW rather than waiting out the watchdog: the
    // abandonment declares comesUpIdle, because no turn is coming.
    const stub = await waitFor(() => watcher.ringSnapshot().find(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('get_recent_messages')));
    assert.ok(!stub.text.includes('did NOT finish'),
      `the wake must come from the rotation trigger, not the watchdog: ${stub.text}`);
    assert.equal(srv.instances._idleHub.hasSubscriber(inst.id), false, 'one-shot consumed');
  } finally {
    await srv.close();
  }
});

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

test('renew_session carries the mode record for an `ask` session, which nothing else writes', async () => {
  // The carry at Instance.carryMarkersAcrossRenewal is redundant for `plan` and
  // `bypassPermissions`: the system/init handler rotates the sessionId and
  // records the CLI-reported mode in the same breath, and the fork path
  // relaunches, so spawn() records there. `ask` is the one mode it cannot
  // cover — `ask` is orchestrator-only, the CLI reports the rotated session as
  // `bypassPermissions`, and the init handler's anti-clobber guard skips BOTH
  // the assignment and the record write. Without the carry the rotated id stays
  // unrecorded, so it resolves to DEFAULT_RESUME_MODE: listed with
  // `resumes-hot` and resumed ungated, for a worker that was deliberately in
  // the hook-gated mode. That is this task's footgun on the renewal path.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'ask' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);
    const oldBacking = inst.backingSessionId;
    assert.equal(inst.mode, 'ask', 'the CLI reports bypassPermissions; the orchestrator keeps `ask`');
    await waitFor(async () => (await getSessionMode(oldBacking)) === 'ask');

    await callTool(srv.baseUrl, 'renew_session', { summary: 'carry on' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);
    assert.equal(instForSession(srv.instances, NEW_SID).mode, 'ask',
      'the rotated worker is still in ask');

    await waitFor(async () => (await getSessionMode(NEW_SID)) === 'ask');
    assert.equal(await getSessionMode(NEW_SID), 'ask',
      'the rotated id must carry `ask` — nothing else writes it');
    // The old id KEEPS its record: it survives as an archived, still-listable
    // row whose resumes-hot flag has to stay accurate.
    assert.equal(await getSessionMode(oldBacking), 'ask',
      'the archived pre-clear id keeps its mode record');
  } finally {
    await srv.close();
  }
});
