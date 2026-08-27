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
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';
import { RENEW_SUMMARY_TEMPLATE, LINEAGE_RETRY_ATTEMPTS } from '../src/sessionRenew.ts';
import { isConducted } from '../src/conductedSessions.ts';
import { isTemp } from '../src/tempSessions.ts';
import { isArchived } from '../src/archivedSessions.ts';
import { getTitle } from '../src/sessionTitles.ts';
import { getSessionMode } from '../src/sessionModes.ts';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-renew.json');
// The conductor-REQUESTED renewal: scenario-renew plus a leading turn matching
// DIRECTIVE that emits nothing, so turn A stays open for the worker's self-call.
const SCENARIO_REQUEST = path.join(__dirname, 'fixtures', 'scenario-renew-request.json');
const SCENARIO_DRAIN = path.join(__dirname, 'fixtures', 'scenario-renew-drain.json');
const SCENARIO_DECLINE_DEFER = path.join(__dirname, 'fixtures', 'scenario-renew-decline-defer.json');
// Must be a substring of every `directive` below — it is what the fixture's
// leading turn filters on.
const DIRECTIVE = 'MARK-D';
// Must match the session_id the `/clear` turn emits in scenario-renew.json.
const NEW_SID = 'c0000000-0000-4000-8000-000000000001';

let nextRpcId = 1;
// Set to the live manager by each test after bootServer. `?caller=` now carries the
// stable INSTANCE id (what Instance.spawn bakes), so translate a caller sessionId to
// its instanceId here; a value that resolves to no instance (bogus/absent) passes
// through so the "no caller" refusal paths still fire.
// Ownership + the turn that arms it. `noteDispatch` records the ownership edge;
// the ARM happens when the target enters a turn. Tests that need an armed entry
// without running a turn (the target must stay idle for the rotation under test)
// drive onTurnStart directly — the same call Instance._setStatus makes.
function armWake(instances, callerSid, targetSid, timeoutMs) {
  instances.noteDispatch(callerSid, targetSid, timeoutMs);
  instances._idleHub.onTurnStart(instances.liveForSession(targetSid).id);
}

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
  // mkdtemp from the registry, NOT a pid-named path in os.tmpdir(): a
  // pid-named file is orphaned by a crash and collides outright when two runs
  // share a pid space, and nothing cleans it up. tmpRegistry tears every
  // directory it mints down automatically, including on the crash path.
  const transcript = path.join(await mkdtemp('renew-tx-'), 'transcript.jsonl');
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
    // MISSING BARRIER, not a slow test. `backingSessionId` and `status` are both
    // IN-MEMORY facts that flip independently of the durable lineage write: the
    // renew path records the rotation fire-and-forget (Instance._kickLineageWrite
    // → recordRotation). `spawn_instance {resume}` below resolves through
    // resolveBacking(), which reads the STORE — so losing that race returns the
    // PRE-rotation segment and this test fails in ~150ms with a misleading
    // "resume redirection is wrong". Measured 2/45 under 24-way CPU starvation,
    // 0/24 unloaded. flushLineage() awaits the serialised write chain and
    // rethrows a failed write, so it is both the exact barrier and stricter than
    // polling segmentsFor() (which cannot see a write that FAILED).
    await inst.flushLineage();
    const { resolveBacking: resolveBackingPreKill } = await import('../src/sessionLineage.ts');
    assert.equal(await resolveBackingPreKill(publicId), NEW_SID,
      'the rotation must be durable BEFORE we resume — otherwise the --resume assertion below is testing a race, not the redirection');

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

// ---------------------------------------------------------------------------
// The KICK-ANCHORED READ BARRIER (card 2026-0193, window (a)). The renew
// rotation is persisted fire-and-forget — Instance._kickLineageWrite from the
// system/init handler — so between the in-memory rotation and that write
// landing, every lineage READ still serves the PRE-rotation row. The damaging
// reader is spawn_instance({resume}), which resolves the public id through
// publicIdFor -> resolveBacking (InstanceManager._doCreate): losing that race
// `--resume`s the pre-clear transcript and orphans everything the renewed
// session goes on to write.
//
// Both tests FORCE the window instead of racing it: _kickLineageWrite(() => held)
// parks the CHAIN itself, so the rotation's own write queues behind a promise the
// test owns. Parking the chain — not stubbing recordRotation — is what makes the
// store genuinely stale; a stopped recordRotation would prove nothing about a
// barrier that waits on kicked writes.
//
// They differ ONLY in how the session stops being live, and that is the point:
// T1 kills it (remove() ran, the instance left byId), T2 loses the subprocess
// spontaneously (no remove(), the instance is still in byId with proc === null).
// A flush-before-byId.delete fix passes T1 and fails T2.
// ---------------------------------------------------------------------------

// Materialise both segments' transcripts with distinguishable content. A wrong
// resume then finds a perfectly valid file — the PRE-clear one — which is exactly
// the silent failure a file-existence-only assertion would miss.
async function materializeBothSegments(claudeProjectsRoot, cwd, firstBacking) {
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const line = (uuid, text) => JSON.stringify({
    type: 'user', uuid, message: { role: 'user', content: text },
  }) + '\n';
  await fs.writeFile(path.join(dir, `${firstBacking}.jsonl`), line('pre-1', 'PRE-CLEAR TURN'));
  await fs.writeFile(path.join(dir, `${NEW_SID}.jsonl`), line('post-1', 'POST-CLEAR TURN'));
}

// Fire spawn_instance({resume}) WITHOUT awaiting it, park until the server is
// demonstrably inside create({resume}) — `_resuming` is populated synchronously,
// before _doCreate's first await, and that first await IS the lineage read — then
// release the held write and settle.
//
// `settledBeforeRelease` is captured in the promise's own continuation, so the
// ordering claim is a recorded fact rather than a timer. The release is
// UNCONDITIONAL, so a fix that blocks the resume can never hang this.
async function resumeAcrossRelease(srv, publicId, releaseWrite) {
  let released = false;
  let settledBeforeRelease = null;
  const note = () => { if (settledBeforeRelease === null) settledBeforeRelease = !released; };
  const before = new Set(srv.instances.byId.keys());
  const resumeP = callTool(srv.baseUrl, 'spawn_instance', { resume: publicId })
    .then((v) => { note(); return v; }, (e) => { note(); throw e; });
  // Park until the server is demonstrably past the point of no return — either
  // inside create({resume}) with the read still pending, or (with no barrier)
  // already finished. The second disjunct is what turns a missing barrier into
  // the assertion failure below instead of a 10s timeout.
  await waitFor(() => srv.instances._resuming.size === 1 || settledBeforeRelease !== null);
  released = true;
  releaseWrite();
  await resumeP;
  const inst2 = [...srv.instances.byId.values()].find((i) => !before.has(i.id));
  assert.ok(inst2, 'the resume registered a new instance');
  return { inst2, settledBeforeRelease };
}

// The three assertions both tests share: the resume waited, it named the CURRENT
// segment, and the conversation it replayed is the post-clear one.
async function assertResumedCurrentSegment({ inst2, settledBeforeRelease }, firstBacking) {
  await waitFor(() => inst2.status === 'idle');
  const argv = inst2._spawnArgv;
  const at = argv.indexOf('--resume');
  assert.ok(at > 0, `--resume must be in the argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], NEW_SID, '--resume must carry the CURRENT segment');
  assert.notEqual(argv[at + 1], firstBacking, 'and must NOT carry the pre-rotation segment');
  const echoes = inst2.ringSnapshot().filter((ev) => ev.kind === 'user_echo').map((ev) => ev.text);
  assert.ok(echoes.some((t) => t.includes('POST-CLEAR TURN')),
    `the post-clear transcript must be replayed; got ${JSON.stringify(echoes)}`);
  assert.ok(!echoes.some((t) => t.includes('PRE-CLEAR TURN')),
    `the pre-clear transcript must NOT be replayed; got ${JSON.stringify(echoes)}`);
  // Asserted LAST so the two above report the actual damage first. This one is
  // the mechanism: the resume did not settle until the parked write landed.
  assert.equal(settledBeforeRelease, false,
    'the resume must not resolve its public id before the pending rotation write lands');
}

test('a resume waits for a PENDING rotation write instead of reading the pre-rotation row (killed)', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    const firstBacking = inst.backingSessionId;

    // Park the durable-write chain: everything kicked from here on — the rotation
    // included — queues behind `held`.
    let releaseWrite;
    const held = new Promise((r) => { releaseWrite = r; });
    inst._kickLineageWrite(() => held);

    await callTool(srv.baseUrl, 'renew_session', { summary: 'stale-read check' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    // IN-MEMORY only. The store is still pre-rotation, by construction.
    await waitFor(() => inst.backingSessionId === NEW_SID);
    await materializeBothSegments(srv.claudeProjectsRoot, inst.cwd, firstBacking);

    await callTool(srv.baseUrl, 'kill_instance', { sessionId: publicId });
    await waitFor(() => !instForSession(srv.instances, publicId));

    await assertResumedCurrentSegment(
      await resumeAcrossRelease(srv, publicId, releaseWrite), firstBacking);
  } finally {
    await srv.close();
  }
});

test('…and on the SPONTANEOUS-EXIT variant, where the instance never left byId', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    const firstBacking = inst.backingSessionId;

    let releaseWrite;
    const held = new Promise((r) => { releaseWrite = r; });
    inst._kickLineageWrite(() => held);

    await callTool(srv.baseUrl, 'renew_session', { summary: 'stale-read check' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID);
    await materializeBothSegments(srv.claudeProjectsRoot, inst.cwd, firstBacking);

    // Lose the subprocess on its own — no kill_instance, so no remove() runs.
    inst.proc.kill('SIGKILL');
    await waitFor(() => inst.proc === null);
    // THE precondition that separates this from T1: the exited instance is still
    // registered, yet nothing live answers to the public id, so the resume's
    // check-and-claim guard lets it through.
    assert.equal(srv.instances.byId.has(inst.id), true, 'the instance never left byId');
    assert.equal(srv.instances.liveForSession(publicId), null, 'and nothing live answers to the public id');

    await assertResumedCurrentSegment(
      await resumeAcrossRelease(srv, publicId, releaseWrite), firstBacking);
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
    const view = await callTool(srv.baseUrl, 'set_mode', { sessionId: publicId, mode: 'bypassPermissions' });
    assert.notEqual(view.ok, false, `must not refuse: ${JSON.stringify(view)}`);
    assert.equal(view.sessionId, publicId);
    assert.equal(instForSession(srv.instances, publicId).id, instanceId, 'same Instance, no second worker');

    // All three accepted input forms land on the same session: the public id
    // (above), a prefix of it, and any full backing/segment id — permanently.
    const byPrefix = await callTool(srv.baseUrl, 'set_mode', { sessionId: publicId.slice(0, 5), mode: 'bypassPermissions' });
    assert.equal(byPrefix.sessionId, publicId, 'a prefix resolves to the public id');
    const byBacking = await callTool(srv.baseUrl, 'set_mode', { sessionId: NEW_SID, mode: 'bypassPermissions' });
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

    // Persist a custom title through the route, addressed by the PUBLIC id — the
    // only id a UI client has. The route resolves it to the backing id, because
    // that is what the sidecar is keyed to; it also sets the instance's in-memory
    // this.title, which the carry reads.
    const oldBacking = instForSession(srv.instances, sid1).backingSessionId;
    const TITLE = 'Migration follow-up';
    const put = await api(srv.baseUrl, 'PUT', `/api/sessions/${sid1}/title`, { title: TITLE });
    assert.equal(put.status, 200);
    await waitFor(async () => (await getTitle(oldBacking)) === TITLE);

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
    // self-renewal case where the caller's own backing id rotates while it holds
    // an outgoing wake. Because the idle-wake graph is keyed by
    // the stable instanceId (which /clear preserves), the entry is untouched by
    // the rotation — nothing to re-key. The snapshot is a sessionId-shaped view,
    // so it simply reflects the caller's CURRENT (rotated) sessionId.
    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sub = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const wSid = worker.sessionId, sSid = sub.sessionId;
    await waitFor(() => instForSession(srv.instances, wSid)?.status === 'idle'
      && instForSession(srv.instances, sSid)?.status === 'idle');

    // Armed directly: the worker must stay idle across the caller's rotation, so
    // there is no turn of its own to arm on.
    armWake(srv.instances, sSid, wSid, 600_000);
    let snap = srv.instances._idleSubscriberSnapshot();
    assert.ok(snap[wSid]?.includes(sSid), 'wake armed under the caller\'s original sid');

    await callTool(srv.baseUrl, 'renew_session', { summary: 'keep watching the worker' }, { caller: sSid });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sSid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.backingSessionId === NEW_SID);

    snap = srv.instances._idleSubscriberSnapshot();
    // INVERTED by card 2026-0126. The snapshot projects instanceIds back through
    // `inst.sessionId`, which is now PINNED — so the rotation is invisible here
    // too: the entry does not move, and the id the conductor was given stays the
    // one it is listed under. (Pre-card it re-keyed onto the rotated id, which is
    // exactly how a conductor's held reference went stale.)
    assert.ok(snap[wSid]?.includes(sSid), 'wake still listed under the caller\'s UNCHANGED public id');
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
// INSTANCE id, so it keeps resolving across a /clear — repeated renewal works. On
// the old sessionId-baked behavior the second (post-rotation) call resolved to a
// rotated-away id and soft-refused; the public id is pinned now, so the handle
// resolves to the SAME value each time. The rpc helper passes `caller` through
// unchanged when it's already an instanceId.
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
    // The worker sessionId also appears in the owned-wake-targets section.
    const subsSection = seedEcho.text.split('Workers you own')[1] ?? '';
    assert.ok(subsSection.includes(workerSid), 'state block lists the owned wake target');
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

    // Spawn the worker AFTER arming, but before the turn ends. The spawn IS the
    // ownership edge (callerInstanceId), so nothing else needs registering.
    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' }, { caller: conductorSid });
    const workerSid = worker.sessionId;
    await waitFor(() => instForSession(srv.instances, workerSid)?.status === 'idle');

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
test('the rotation tell reaches the conductor view, and the backing id never does', async () => {
  // Pinning the public id makes a rotation invisible — which removes the only
  // signal a conductor had that one happened. Without this a renewed worker and a
  // stalled one look identical, so a conductor cannot tell "fresh context" from
  // "gone quiet". These three keys are the replacement, and the ABSENCE of
  // backingSessionId beside them is the enforcement of the invariant.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const publicId = spawn.sessionId;

    // Before any rotation: the tell reads "never rotated" — and it is PRESENT,
    // not absent, so a conductor can rely on reading it.
    assert.ok('lastRotatedAt' in spawn, 'the key is published even when null');
    assert.equal(spawn.lastRotatedAt, null);
    assert.equal(spawn.rotationReason, null);
    assert.equal(spawn.segmentCount, 1, 'one segment = never rotated');
    assert.ok(!('backingSessionId' in spawn), 'the backing id must never reach a conductor');

    await waitFor(() => instForSession(srv.instances, publicId)?.status === 'idle');
    const inst = instForSession(srv.instances, publicId);
    await callTool(srv.baseUrl, 'renew_session', { summary: 'tell-check' }, { caller: publicId });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID);
    await waitFor(() => inst.rotationPending === false);

    // After: the same public id, now carrying the tell.
    const view = await callTool(srv.baseUrl, 'set_mode', { sessionId: publicId, mode: 'bypassPermissions' });
    assert.equal(view.sessionId, publicId, 'the handle did not move');
    const summary = inst.summary();
    assert.equal(summary.rotationReason, 'renew');
    assert.ok(summary.lastRotatedAt > 0, 'and when');
    assert.equal(summary.segmentCount, 2, 'two segments after one rotation');

    // …and it renders, so a conductor reading list_sessions sees it too. It is on
    // the flags line, i.e. shown only because it deviates from never-rotated.
    // list_sessions returns PLAIN TEXT, not JSON, so read the raw content.
    const { body } = await rpc(srv.baseUrl, 'tools/call',
      { name: 'list_sessions', arguments: { project: 'p' } });
    const text = body.result.content[0].text;
    assert.match(text, /rotated-by renew/);
    assert.match(text, /segments 2/);
    assert.ok(!text.includes(NEW_SID), 'and never the backing id');
  } finally {
    await srv.close();
  }
});

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

test('the interlock covers the RESEED window, not just arming', async () => {
  // The gap review round 1 found. `_rotation` is closed at the /clear's own
  // turn_end — it has to be, or the idle hub would never deliver at the reseed's
  // turn_end — which leaves a window where _rotation is null, _mutating is false
  // and status is 'idle': every guard a prune or a rewind checks. A request landing
  // there kills the proc, and the reseed then 409s in prompt(): context cleared,
  // handoff summary LOST, conductor silent until the watchdog. The second flag
  // (_renewing) exists to cover exactly this window.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    // Hold the renewal INSIDE the window under test: make the durable flush hang,
    // so the sequence is parked after _clear({ok:true}) and before the reseed.
    let releaseFlush;
    const held = new Promise((r) => { releaseFlush = r; });
    const realFlush = inst.flushLineage.bind(inst);
    inst.flushLineage = async () => { await held; return realFlush(); };

    await callTool(srv.baseUrl, 'renew_session', { summary: 'must not be lost' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    // Park: rotated, hub window CLOSED (so the wake can still be delivered by the
    // reseed's turn_end), but the renewal is not finished.
    await waitFor(() => inst.backingSessionId === NEW_SID && inst.rotationPending === false);
    assert.equal(inst.status, 'idle', 'precondition: idle, so the status guard would not refuse');
    assert.equal(inst._mutating, false, 'precondition: _mutating is clear too');
    assert.equal(inst.renewalPending, true, 'the renewal window is still open — this is the fix');

    // All three destructive rewrites must refuse in this window.
    const pr = await api(srv.baseUrl, 'POST', `/api/instances/${inst.id}/prune`, { cutTurnIndex: 0 });
    assert.equal(pr.status, 409, `prune must be refused mid-reseed: ${JSON.stringify(pr.body)}`);
    assert.match(pr.body.error, /renewal is in progress/i);
    const rw = await api(srv.baseUrl, 'POST', `/api/instances/${inst.id}/rewind`, { userMessageIndex: 0 });
    assert.equal(rw.status, 409, `rewind must be refused mid-reseed: ${JSON.stringify(rw.body)}`);
    assert.match(rw.body.error, /renewal is in progress/i);
    const fk = await api(srv.baseUrl, 'POST', `/api/instances/${inst.id}/fork`, { userMessageIndex: 0 });
    assert.equal(fk.status, 409, `fork must be refused mid-reseed: ${JSON.stringify(fk.body)}`);
    // Same message as prune/rewind now: fork routes through the shared
    // _assertNoRotationInFlight rather than re-checking the two flags locally.
    assert.match(fk.body.error, /renewal is in progress/i);
    await assert.rejects(() => inst.pruneSession({ cutTurnIndex: 0 }),
      (e) => e.code === 'SESSION_ROTATING' && e.statusCode === 409);

    // Let it finish: the summary lands, and the window closes behind it.
    releaseFlush();
    await waitFor(() => inst.ringSnapshot().some(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('must not be lost')));
    await waitFor(() => inst.renewalPending === false);
    // …and once closed, a prune is allowed again — the guard is a window, not a latch.
    assert.equal(inst.rotationPending, false);
    assert.doesNotThrow(() => inst._assertNoRotationInFlight());
  } finally {
    await srv.close();
  }
});

test('a failed DURABLE FLUSH is reported and the reseed happens anyway', async () => {
  // D2 step 3, and the other half of the reseed failure handling. If the lineage
  // write fails (EACCES, ENOSPC, or a corrupt-JSON loadStrict throw), the rotation
  // is live in memory but absent from disk: a restart before the next rotation
  // would resolve the public id to the PRE-CLEAR transcript and orphan everything
  // the renewed session goes on to write. That has to be said loudly — and then the
  // reseed has to happen ANYWAY, because the clear already happened irreversibly
  // and the summary is the only thing that can still save the session. Aborting
  // here would leave a cleared context with no handoff at all, the exact outcome
  // this flow exists to prevent.
  //
  // Nothing else in the suite ever REJECTS flushLineage (the sibling stub only
  // delays it), so all three sub-behaviours were unpinned: the report, the
  // reseed-anyway, and their ordering.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    // Reject, do not delay — the seam the sibling test uses, driven the other way.
    // The message is TAGGED with the attempt number so the terminal report can be
    // traced to a specific attempt: with an identical message every time, "kept
    // the first error" and "kept the last error" are indistinguishable, and the
    // loop's LAST-error contract would be unpinned.
    let flushCalls = 0;
    inst.flushLineage = async () => {
      flushCalls++;
      throw new Error(`ENOSPC writing session-lineage.json (attempt ${flushCalls})`);
    };

    await callTool(srv.baseUrl, 'renew_session', { summary: 'survives a failed flush' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID);

    // (1) The failure is reported, at the LINEAGE stage specifically, naming the
    // orphan risk rather than a generic error.
    const errEv = await waitFor(() => inst.ringSnapshot().find(ev => ev.kind === 'system'
      && ev.subtype === 'renew_error' && ev.data?.stage === 'lineage'));
    assert.match(errEv.data.message, /ENOSPC writing session-lineage\.json/, 'carries the cause');
    assert.match(errEv.data.message, /in memory\s+but not on disk/, 'and names the orphan risk');
    // …and specifically the LAST attempt's cause, not the first. A loop that
    // remembered the first failure and never overwrote it would satisfy every
    // other assertion here; this is the only thing that separates them.
    assert.match(errEv.data.message, new RegExp(`attempt ${1 + LINEAGE_RETRY_ATTEMPTS}\\b`),
      `the terminal report must carry attempt ${1 + LINEAGE_RETRY_ATTEMPTS}'s error — the LAST one`);
    assert.doesNotMatch(errEv.data.message, /attempt 1\b/,
      'and must NOT be the first attempt\'s error, kept and never replaced');
    // DELIBERATE REVERSAL (card 2026-0193, window (c)). This used to pin
    // `flushCalls === 1, 'flushed exactly once — not retried behind the scenes'`.
    // The flush-failure branch now runs a BOUNDED retry — LINEAGE_RETRY_ATTEMPTS
    // re-kick + re-flush rounds on top of the first attempt — because a stale
    // store left behind by a transient failure orphans the session on the next
    // restart. This stub rejects every time — with a per-attempt tag — so all of
    // them fail and the exhausted loop emits ONE terminal renew_error carrying the
    // LAST error, both of which (1) above asserts. The transient-failure
    // counterpart (retry succeeds, nothing emitted) is the sibling test below.
    assert.equal(flushCalls, 1 + LINEAGE_RETRY_ATTEMPTS,
      'the first flush plus every bounded retry ran — and produced exactly one renew_error');
    assert.equal(inst.ringSnapshot().filter(ev => ev.kind === 'system'
      && ev.subtype === 'renew_error' && ev.data?.stage === 'lineage').length, 1,
      'one terminal report for the exhausted retry loop, not one per attempt');

    // (2) …and the reseed STILL lands. This is what dies if the branch rethrows.
    const seedEcho = await waitFor(() => inst.ringSnapshot().find(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('survives a failed flush')));
    assert.match(seedEcho.text, /Your context was just renewed/, 'the real seed, not a stray echo');
    // (3) Ordering: the report precedes the reseed, so a human reading the stream
    // sees the warning attached to the rotation and not after the new turn.
    assert.ok(errEv._seq < seedEcho._seq, 'the lineage warning precedes the reseed');

    // The in-memory rotation is still authoritative for this process, and the
    // renewal window is released even though the flush threw.
    assert.equal(inst.sessionId, sid1, 'the public id is untouched by a flush failure');
    await waitFor(() => inst.renewalPending === false);
  } finally {
    await srv.close();
  }
});

test('a TRANSIENT lineage-flush failure is retried, leaving the store correct and the stream clean', async () => {
  // Card 2026-0193 window (c), and the counterpart to the test above. Before the
  // retry, ANY flush failure — including a lock-contention throw or a store dir
  // that was briefly unwritable — left the rotation in memory and absent from
  // disk until some later rotation happened to succeed. A restart in that window
  // resolves the public id to the pre-clear transcript.
  //
  // The REAL write is made to fail, not `flushLineage`: a stub would bypass
  // recordRotation entirely and leave the store already correct, so it could not
  // tell a working retry from no retry at all.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    // A directory where the store file belongs: loadStrict's readFile throws
    // EISDIR inside the lock, so recordRotation aborts without clobbering.
    const storeFile = path.join(srv.projectsRoot, '.code-conductor', 'session-lineage.json');
    await fs.rm(storeFile, { force: true });
    await fs.mkdir(storeFile, { recursive: true });

    // Clear the obstruction on the FIRST flush only, so the retry hits a writable
    // store. In `finally`, because the call it hangs off of is the one that throws.
    let flushCalls = 0;
    const realFlush = inst.flushLineage.bind(inst);
    inst.flushLineage = async () => {
      flushCalls++;
      try {
        return await realFlush();
      } finally {
        if (flushCalls === 1) await fs.rm(storeFile, { recursive: true, force: true });
      }
    };

    await callTool(srv.baseUrl, 'renew_session', { summary: 'retried past a transient failure' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID);

    // The reseed is dispatched only after the retry loop settles, so the seed echo
    // is the signal that the loop is done — no polling on flushCalls itself.
    const seedEcho = await waitFor(() => inst.ringSnapshot().find(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('retried past a transient failure')));
    assert.match(seedEcho.text, /Your context was just renewed/, 'the real seed, not a stray echo');

    // (1) The store is actually CORRECT afterwards — the whole point, and the
    //     damage a missing retry does. The row was destroyed with the obstruction,
    //     so recordRotation recreates it lazily from the base case (the public id
    //     as its own `initial` segment).
    const { segmentsFor, resolveBacking } = await import('../src/sessionLineage.ts');
    assert.deepEqual((await segmentsFor(sid1)).map(g => [g.id, g.reason]),
      [[sid1, 'initial'], [NEW_SID, 'renew']],
      'the retry landed the rotation on a lazily recreated row');
    assert.equal(await resolveBacking(sid1), NEW_SID,
      'so the public id resolves to the POST-clear transcript, not the pre-clear one');
    // (2) A recovered failure is NOT reported. The renew_error is reserved for an
    //     exhausted loop, so the stream a human reads stays clean.
    assert.deepEqual(inst.ringSnapshot().filter(ev => ev.kind === 'system'
      && ev.subtype === 'renew_error' && ev.data?.stage === 'lineage'), [],
      'a failure the retry recovered must not be reported');
    // (3) Exactly one retry: the loop stops at the first success rather than
    //     running every attempt regardless.
    assert.equal(flushCalls, 2, 'one failed flush, then one retry that succeeded — and no more');
  } finally {
    await srv.close();
  }
});

test('a FAILED reseed wakes its owner instead of stranding it on the heartbeat', async () => {
  // endRotation closed the hub's window with comesUpIdle:false on the promise that
  // a reseed turn was coming. When that promise breaks, the promise has to be
  // retracted: `renew_error` is a UI event on the WORKER's stream and reaches no
  // conductor, so without this the conductor waits out the full watchdog and is
  // then told a healthy worker "did NOT finish".
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const target = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const watcher = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = target.body.sessionId;
    const watcherSid = watcher.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle'
      && instForSession(srv.instances, watcherSid)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);
    const watcherInst = instForSession(srv.instances, watcherSid);

    // A heartbeat window long enough that this test cannot pass by pinging out.
    armWake(srv.instances, watcherSid, sid1, 600_000);
    // Break the reseed specifically — not the clear, not the lineage write.
    const realPrompt = inst.prompt.bind(inst);
    inst.prompt = async (text, atts, opts) => {
      if (typeof text === 'string' && text.includes('lost handoff')) throw new Error('simulated reseed failure');
      return realPrompt(text, atts, opts);
    };

    await callTool(srv.baseUrl, 'renew_session', { summary: 'lost handoff' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    // The failure is visible to the human…
    await waitFor(() => inst.ringSnapshot().some(ev => ev.kind === 'system'
      && ev.subtype === 'renew_error' && ev.data?.stage === 'reseed'));
    // …AND the conductor is woken now, not in 30 minutes, and not with the
    // watchdog's "did NOT finish" stub.
    const stub = await waitFor(() => watcherInst.ringSnapshot().find(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('get_recent_messages')));
    assert.ok(!stub.text.includes('did NOT finish'),
      `the wake must come from the lost-turn signal, not the watchdog: ${stub.text}`);
    assert.ok(stub.text.includes(sid1), 'and it names the pinned public id');
    assert.equal(srv.instances._idleHub.hasArmedWake(inst.id), false, 'the wake was consumed');
    // The renewal window is released even though the reseed threw, so the session
    // is not left permanently un-prunable.
    await waitFor(() => inst.renewalPending === false);
  } finally {
    await srv.close();
  }
});

test('an ABANDONED renewal closes the rotation window and wakes its owner', async () => {
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

    // The watcher owns the renewing session, with a heartbeat window long enough
    // that this test cannot pass by timing out.
    armWake(srv.instances, watcherSid, sid1, 600_000);
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
    assert.equal(srv.instances._idleHub.hasArmedWake(inst.id), false, 'the wake was consumed');
  } finally {
    await srv.close();
  }
});

test('renew_session against the real claude binary rotates the BACKING id and pins the public one', { skip: process.env.RUN_REAL_CLAUDE !== '1' }, async () => {
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

    // The REAL CLI mints the new id, so the value is unknown up front — wait for
    // the backing id to move off whatever it started as.
    const inst = srv.instances.get(spawn.body.id);
    const firstBacking = inst.backingSessionId;
    await waitFor(() => inst.backingSessionId !== firstBacking && inst.status === 'idle',
      { timeout: 60000 });
    assert.notEqual(inst.backingSessionId, firstBacking, 'real /clear rotated the BACKING id');
    assert.equal(inst.sessionId, sid1, 'and the public id is pinned across it');
    assert.equal(inst.pid, pidBefore, 'same process across the real /clear');
    // The rotation reached the durable store, against the real CLI's own ids.
    const { segmentsFor } = await import('../src/sessionLineage.ts');
    await waitFor(async () => (await segmentsFor(sid1)).length === 2);
    assert.deepEqual((await segmentsFor(sid1)).map(g => [g.id, g.reason]),
      [[firstBacking, 'initial'], [inst.backingSessionId, 'renew']]);
  } finally {
    await srv.close();
  }
});

test('renew_session carries the mode record for an `ask` session, which nothing else writes', async () => {
  // The carry at Instance.carryMarkersAcrossRenewal is redundant for `plan` and
  // `bypassPermissions`: the system/init handler rotates the backing id and
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

// ---------------------------------------------------------------------------
// Phase 2 (card 2026-0127): the conductor can REQUEST a worker renewal. The
// conductor triggers and guides; the worker authors its own summary and may
// decline. `renew_session({sessionId, directive?, followUp?})`.
//
// The fake CLI cannot call MCP tools, so the worker's self-call is injected out
// of band — which is faithful, because the real shape is exactly that: the
// worker calls the SAME bare renew_session these tests call. The request
// fixture's leading turn emits nothing, so turn A stays open and the self-call
// lands INSIDE the turn the request opened, as it does in production.
// ---------------------------------------------------------------------------

// Spawn `conductor` + `worker` (both idle) in project p.
async function pair(srv) {
  await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
  const conductor = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
  const worker = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
  const condSid = conductor.body.sessionId;
  const wSid = worker.body.sessionId;
  await waitFor(() => instForSession(srv.instances, condSid)?.status === 'idle'
    && instForSession(srv.instances, wSid)?.status === 'idle');
  return { condSid, wSid, cond: instForSession(srv.instances, condSid), worker: instForSession(srv.instances, wSid) };
}

const echoWith = (inst, needle) => inst.ringSnapshot().find(
  (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes(needle));

test('a requested renewal: the worker authors the summary, and the followUp lands under its own fence', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);

    const req = await callTool(srv.baseUrl, 'renew_session', {
      sessionId: wSid,
      directive: `${DIRECTIVE}: name the sentinel you agreed with me`,
      followUp: 'MARK-F: next, land the worktree',
    }, { caller: condSid });
    // Bare data, no `ok` — the acknowledgement-tool convention.
    assert.equal(req.requested, true, JSON.stringify(req));
    assert.equal(req.ok, undefined, 'an acknowledgement carries no ok');
    assert.equal(req.sessionId, wSid, 'and names the PUBLIC id it targeted');
    assert.ok(srv.instances._idleHub.ownersOf(worker.id).includes(instForSession(srv.instances, condSid).id),
      'the targeted form records the conductor as owner — the wake needs no opt-in');

    // Turn A: the request reached the worker, carrying the conductor's PRE-directive.
    const reqEcho = await waitFor(() => echoWith(worker, DIRECTIVE));
    assert.match(reqEcho.text, /renew_session/, 'the request tells the worker what to call');
    assert.match(reqEcho.text, /DECLINE/, 'and that it may refuse');
    // …under its own fence, so the worker can tell its conductor's words from the
    // server's asking text, and followed by the summary template (D8: one home,
    // two consumers — this prompt and the tool schema's `summary` description).
    const iAsk = reqEcho.text.indexOf('renew_session');
    const iReqFence = reqEcho.text.indexOf('--- YOUR CONDUCTOR\'S DIRECTIVE FOR THIS SUMMARY ---');
    const iReqD = reqEcho.text.indexOf(DIRECTIVE);
    assert.ok(iReqFence > iAsk, `the directive must be fenced, after the ask: ${reqEcho.text}`);
    assert.ok(iReqD > iReqFence, 'and the directive text sits under that fence');
    assert.ok(reqEcho.text.includes(RENEW_SUMMARY_TEMPLATE),
      `the request must carry the summary template verbatim: ${reqEcho.text}`);
    assert.ok(reqEcho.text.indexOf(RENEW_SUMMARY_TEMPLATE) > iReqD,
      'the template comes last, after the conductor\'s directive');

    // The worker answers with its OWN summary, inside the turn the request opened.
    const armed = await callTool(srv.baseUrl, 'renew_session', { summary: 'MARK-S: the live roster' }, { caller: wSid });
    assert.equal(armed.ok, true, JSON.stringify(armed));
    assert.equal(armed.willClearAtTurnEnd, true);
    // The interlock, widened to the TARGET: a second request now refuses rather
    // than clobbering the renewal the worker just armed.
    const again = await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: again?` }, { caller: condSid });
    assert.equal(again.ok, false, `a request over an armed renewal must refuse: ${JSON.stringify(again)}`);
    assert.equal(again.code, 'SESSION_ROTATING');
    assert.equal(again.sessionId, wSid, 'and the refusal names the target');
    // End turn A → the renewal fires, and the request is consumed by the arm.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });
    await waitFor(() => worker.backingSessionId === NEW_SID);
    const seed = await waitFor(() => echoWith(worker, 'MARK-S'));

    // Fence separation: summary section first, then the conductor's follow-up
    // under a marker of its own. The summary is memory; the followUp is a task.
    const iSummary = seed.text.indexOf('--- HANDOFF SUMMARY ---');
    const iS = seed.text.indexOf('MARK-S');
    const iFence = seed.text.indexOf('--- YOUR CONDUCTOR\'S FOLLOW-UP DIRECTIVE ---');
    const iF = seed.text.indexOf('MARK-F');
    assert.ok(iF > 0, `the followUp must reach the reseed: ${seed.text}`);
    assert.ok(iSummary >= 0 && iS > iSummary, 'the summary sits under the handoff fence');
    assert.ok(iFence > iS, 'the follow-up fence comes AFTER the summary section');
    assert.ok(iF > iFence, 'and the followUp text sits under that fence, not inside the summary');
    assert.ok(!seed.text.includes(DIRECTIVE),
      `the PRE-directive shapes the summary and must not leak into the seed: ${seed.text}`);
  } finally {
    await srv.close();
  }
});

test('a DECLINED request: nothing is cleared, and the decline rides the conductor\'s wake', async () => {
  // Registry-owned temp dir — see the note on the renew-tx transcript above.
  const transcript = path.join(await mkdtemp('renew-decline-'), 'transcript.jsonl');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);
    const backingBefore = worker.backingSessionId;

    await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: capture the roster` }, { caller: condSid });
    await waitFor(() => echoWith(worker, DIRECTIVE));
    // The worker never self-calls. Ending the turn IS the decline — it may be
    // mid-rebase, and only it knows "not now" is the right answer.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });
    await waitFor(() => worker.status === 'idle'); // turn A has ended

    // (a) No `/clear` ever reached the CLI…
    const texts = userTexts(await fs.readFile(transcript, 'utf8'));
    assert.ok(!texts.some((t) => t.trim() === '/clear'),
      `a declined request must not clear anything; stdin was ${JSON.stringify(texts)}`);
    // (b) …and the session is untouched: same backing id, no rotated instance.
    assert.equal(worker.backingSessionId, backingBefore, 'the backing id never moved');
    assert.equal(instForSession(srv.instances, NEW_SID), undefined, 'no rotation happened');
    // (c) The conductor is told, server-side, with no inferring from prose — and
    // in the ALWAYS-VISIBLE part of the stub, not the collapsed payload.
    const stub = await waitFor(() => echoWith(cond, 'DECLINED'));
    assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER), 'delivered as a wake stub');
    assert.equal(stub.text.indexOf('Renewal request DECLINED'), WAKE_CALLBACK_MARKER.length,
      'the note leads the summary, right after the marker');
    const iSep = stub.text.indexOf(WAKE_BODY_SEP);
    assert.ok(iSep > WAKE_CALLBACK_MARKER.length, 'and before the folded body separator');
    const note = stub.text.slice(WAKE_CALLBACK_MARKER.length, stub.text.indexOf('Worker `'));
    assert.ok(note.includes(`DECLINED by \`${wSid}\``),
      `the NOTE itself must name the worker by its public id: ${note}`);
    assert.ok(!note.includes(worker.id),
      `and never by an internal instanceId the conductor cannot pass to any tool: ${note}`);
    assert.ok(!stub.text.includes('did NOT finish'), `not the watchdog stub: ${stub.text}`);

    // The note belongs to exactly ONE wake: a later, unrelated wake for the same
    // worker must not repeat it.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go2' }, { caller: condSid });
    const second = await waitFor(() => cond.ringSnapshot().filter((ev) => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('get_recent_messages'))[1]);
    assert.ok(!second.text.includes('DECLINED'),
      `the decline was read and deleted; a second wake must not repeat it: ${second.text}`);
  } finally {
    await srv.close();
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await fs.rm(transcript, { force: true });
  }
});

test('a request lives exactly ONE turn: a later self-renewal does not inherit the followUp', async () => {
  // The leak that sank the original post_renew_prompt sketch: a stored follow-up
  // with no bound lifetime gets injected into whatever renewal happens next,
  // which may be days of work later and about something else entirely.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);

    await callTool(srv.baseUrl, 'renew_session', {
      sessionId: wSid, directive: `${DIRECTIVE}: roster please`, followUp: 'MARK-F: land the worktree',
    }, { caller: condSid });
    await waitFor(() => echoWith(worker, DIRECTIVE));
    // Decline by ending turn A without self-calling.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });
    await waitFor(() => worker.status === 'idle');
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false,
      'the request is gone with the turn it was made in');

    // A LATER turn, on the worker's own initiative, with its own summary.
    const armed = await callTool(srv.baseUrl, 'renew_session', { summary: 'MARK-S3: my own checkpoint' }, { caller: wSid });
    assert.equal(armed.ok, true, JSON.stringify(armed));
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go2' });
    await waitFor(() => worker.backingSessionId === NEW_SID);
    const seed = await waitFor(() => echoWith(worker, 'MARK-S3'));
    assert.ok(!seed.text.includes('MARK-F'),
      `an expired request must not resurface in a later renewal: ${seed.text}`);
    assert.ok(!seed.text.includes('FOLLOW-UP DIRECTIVE'), 'and no empty follow-up fence is emitted');
  } finally {
    await srv.close();
  }
});

test('renew_session form guards: one code for every combination mistake, bare form untouched', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    const { condSid, wSid } = await pair(srv);
    const refusedForm = async (args) => {
      const res = await callTool(srv.baseUrl, 'renew_session', args, { caller: condSid });
      assert.equal(res.ok, false, `expected a refusal for ${JSON.stringify(args)}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'INVALID_RENEW_FORM', `${JSON.stringify(args)} → ${res.code}: ${res.reason}`);
      return res;
    };
    // The conductor never authors the summary — that channel is the worker's alone.
    const both = await refusedForm({ sessionId: wSid, summary: 'not yours to write' });
    assert.match(both.reason, /directive/, 'and the refusal names the argument that IS the conductor\'s');
    // A pre/post-directive with no target names no worker to renew.
    await refusedForm({ directive: 'shape it like this' });
    await refusedForm({ followUp: 'then do this next' });
    // Self-target: the two forms mean different things, so it is refused rather
    // than silently folded into the bare one.
    await refusedForm({ sessionId: condSid });

    // …and with no sessionId the behaviour is exactly what it always was.
    const empty = await callTool(srv.baseUrl, 'renew_session', {}, { caller: condSid });
    assert.equal(empty.code, 'INVALID_SUMMARY', JSON.stringify(empty));
    const blank = await callTool(srv.baseUrl, 'renew_session', { summary: '   ' }, { caller: condSid });
    assert.equal(blank.code, 'INVALID_SUMMARY',
      `a whitespace-only summary passes the schema's minLength and must be refused here: ${JSON.stringify(blank)}`);
    const bare = await callTool(srv.baseUrl, 'renew_session', { summary: 'my own handoff' }, { caller: condSid });
    assert.equal(bare.ok, true, JSON.stringify(bare));
    assert.equal(bare.willClearAtTurnEnd, true);
    assert.equal(bare.sessionId, condSid);
  } finally {
    await srv.close();
  }
});

test('an armed renewal fires when a background task drains an ALREADY-IDLE worker', async () => {
  // The reachable hang the defer gate leaves: it only re-fires on a turn_end, so
  // a background task finishing while the worker is already idle — with no
  // re-invocation turn ever coming — would strand the renewal until the rotate
  // watchdog, and a conductor waiting on it would be told a healthy worker "did
  // NOT finish". Mirrors IdleSubscriptionHub's own task-drain trigger.
  const srv = await bootServer({ scenarioPath: SCENARIO_DRAIN });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    await callTool(srv.baseUrl, 'renew_session', { summary: 'DRAIN-SUMMARY: carry on' }, { caller: sid1 });
    // Snapshot the state at the exact turn_end dispatch rather than polling for
    // it: the drain lands milliseconds later, so a poll could not tell "deferred
    // then fired by the drain" from "fired at the turn_end".
    let atTurnEnd = null;
    srv.instances.on('event', ({ id, ev }) => {
      if (id !== inst.id || ev?.kind !== 'turn_end' || atTurnEnd) return;
      atTurnEnd = {
        renew: srv.instances._sessionRenew.pending.get(inst.id)?.state ?? null,
        tasks: inst.activeAgentTaskCount,
      };
    });
    // This turn launches a backgrounded Agent task and ends while it is live.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'kick off a background agent' });
    await waitFor(() => atTurnEnd);
    // The defer still holds at that turn_end — nothing is stranded by a rotation.
    assert.deepEqual(atTurnEnd, { renew: 'armed', tasks: 1 },
      'at the turn_end the renewal must still be ARMED (deferred), with the task live');
    assert.notEqual(inst.backingSessionId, NEW_SID, 'and no /clear had rotated it');

    // The task now completes while the worker is idle. NO further prompt from
    // this test: if the drain trigger is missing, nothing below ever happens.
    await waitFor(() => inst.backingSessionId === NEW_SID);
    const seed = await waitFor(() => echoWith(inst, 'DRAIN-SUMMARY'));
    assert.match(seed.text, /Your context was just renewed/, 'the real reseed, not a stray echo');
    assert.equal(inst.ringSnapshot().filter((ev) => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('kick off a background agent')).length, 1,
      'exactly one test-driven prompt — the rotation came from the drain, not a turn we drove');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Review round 1 follow-ups: the request needs a turn of its OWN, and a recorded
// decline note must reach exactly one conductor exactly once.
// ---------------------------------------------------------------------------

test('a MID-TURN target is refused rather than producing a false decline', async () => {
  // The defect: with no idle guard the request registers against a turn the worker
  // did not open for it. That turn's end expires the request (a DECLINE the worker
  // never saw), drops the followUp, and spends the conductor's armed wake — inverting
  // the one signal the whole decline contract rests on.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);
    // Put the worker mid-turn: this fixture's turn for a MARK-D prompt emits
    // nothing, so the turn stays open.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: `${DIRECTIVE} busy work` });
    await waitFor(() => worker.status === 'turn');

    const busy = await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster`, followUp: 'MARK-F: next job' }, { caller: condSid });
    assert.equal(busy.ok, false, `a mid-turn target must be refused: ${JSON.stringify(busy)}`);
    assert.equal(busy.code, 'SESSION_BUSY');
    assert.equal(busy.status, 'turn', 'the refusal says what it observed');
    assert.equal(busy.busy, 'turn', 'and names which not-free state it is');
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false,
      'and registers nothing against the turn the worker is already in');

    // Now end that unrelated turn. Nothing may be reported: no decline for a
    // request the worker never saw, and no wake at all (the refusal never recorded ownership).
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });
    await waitFor(() => worker.status === 'idle');
    await assert.rejects(
      () => waitFor(() => echoWith(cond, 'DECLINED'), { timeout: 800, interval: 20 }),
      /timeout/, 'an unrelated turn end must never report a decline');
    assert.equal(srv.instances._idleHub.hasArmedWake(worker.id), false,
      'and the refused request must not have burned a subscription');
  } finally {
    await srv.close();
  }
});

test('a decline note is recorded only for a conductor that is waiting, and dies with the wait', async () => {
  // Both over-firing directions of the guard, at the hub's own surface (the note is
  // recorded from the manager's synchronous event dispatch, so the direct call is
  // the honest way to isolate it from the turn that would also deliver it).
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);
    const hub = srv.instances._idleHub;
    const condId = cond.id;

    // (1) NOBODY waiting → nothing recorded. A note with no watcher would sit in
    // the map and prefix itself onto the next unrelated wake.
    srv.instances.noteRenewalDeclined(worker.id, condSid);
    assert.equal(hub._pendingDeclines.size, 0, 'no watcher, no note');

    // (2) Recorded while waiting…
    armWake(srv.instances, condSid, wSid, 600_000);
    srv.instances.noteRenewalDeclined(worker.id, condSid);
    assert.ok(hub._takeDecline(worker.id, condId), 'recorded for the waiting requester');
    assert.equal(hub._pendingDeclines.size, 0, 'and read-and-deleted, not left behind');

    // (3) …but the note dies with the wait: a silent disarm ends it.
    srv.instances.noteRenewalDeclined(worker.id, condSid);
    srv.instances.disarmIdleSilently(condSid, worker.id);
    assert.equal(hub._takeDecline(worker.id, condId), null,
      'the disarm took the note with it');

    // Nothing recorded above may surface on a real, unrelated wake.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' }, { caller: condSid });
    const stub = await waitFor(() => echoWith(cond, 'get_recent_messages'));
    assert.ok(!stub.text.includes('DECLINED'),
      `an unrelated wake must carry no decline: ${stub.text}`);
  } finally {
    await srv.close();
  }
});

test('a DEFERRED wake still carries the decline (the worker declined with a subagent live)', async () => {
  // The turn the request opened ends while a background subagent is still running,
  // so the hub defers — at the very moment the request expires. The note has to
  // survive that gap and ride the wake that eventually fires.
  const srv = await bootServer({ scenarioPath: SCENARIO_DECLINE_DEFER });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);

    await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster` }, { caller: condSid });
    // The request turn launches a backgrounded Agent task and ends with it live.
    await waitFor(() => worker.status === 'idle' && worker.summary().activeAgentTasks === 1);
    assert.equal(srv.instances._idleHub.hasArmedWake(worker.id), true,
      'the wake is deferred, not consumed, while the subagent runs');
    await assert.rejects(
      () => waitFor(() => echoWith(cond, 'get_recent_messages'), { timeout: 500, interval: 20 }),
      /timeout/, 'nothing delivered yet');

    // The next turn completes the task; its turn_end delivers the deferred wake.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go2' });
    const stub = await waitFor(() => echoWith(cond, 'DECLINED'));
    assert.ok(stub.text.includes(`DECLINED by \`${wSid}\``), stub.text);
  } finally {
    await srv.close();
  }
});

test('a MID-TURN conductor gets the decline on the plain (unfolded) steering stub', async () => {
  // deliver() picks the plain stub for a caller that is mid-turn (and for the
  // timeout watchdog). The note has to be threaded into BOTH builders or the
  // decline is silently dropped on those paths.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);

    await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster` }, { caller: condSid });
    await waitFor(() => echoWith(worker, DIRECTIVE));
    // Put the CONDUCTOR mid-turn, so delivery takes the live steering path.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: condSid, text: `${DIRECTIVE} thinking` });
    await waitFor(() => cond.status === 'turn');
    // The worker declines.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });

    const stub = await waitFor(() => echoWith(cond, 'get_recent_messages'));
    assert.ok(!stub.text.includes(WAKE_BODY_SEP), `the plain stub carries no folded body: ${stub.text}`);
    assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER));
    assert.equal(stub.text.indexOf('Renewal request DECLINED'), WAKE_CALLBACK_MARKER.length,
      `the note LEADS this stub's summary too, not trailing the "finished its turn" line: ${stub.text}`);
  } finally {
    await srv.close();
  }
});

test('the decline reaches the conductor that ASKED, not another watcher', async () => {
  // Two conductors watching one worker. A target-keyed note goes to whichever is
  // woken first — telling a conductor about a request it never made while the one
  // that did hears nothing.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = async () => (await api(srv.baseUrl, 'POST', '/api/instances',
      { project: 'p', mode: 'bypassPermissions' })).body.sessionId;
    const watcherSid = await spawn();
    const askerSid = await spawn();
    const wSid = await spawn();
    await waitFor(() => [watcherSid, askerSid, wSid]
      .every((s) => instForSession(srv.instances, s)?.status === 'idle'));
    const watcher = instForSession(srv.instances, watcherSid);
    const asker = instForSession(srv.instances, askerSid);

    // The bystander OWNS the worker first, so insertion order would hand it the
    // note. Recorded without arming — the worker's own request turn arms both.
    srv.instances.noteDispatch(watcherSid, wSid);
    await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster` }, { caller: askerSid });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });

    const askerStub = await waitFor(() => echoWith(asker, 'get_recent_messages'));
    const watcherStub = await waitFor(() => echoWith(watcher, 'get_recent_messages'));
    assert.ok(askerStub.text.includes('DECLINED'),
      `the requester must be told: ${askerStub.text}`);
    assert.ok(!watcherStub.text.includes('DECLINED'),
      `the bystander must NOT be told about a request it never made: ${watcherStub.text}`);
  } finally {
    await srv.close();
  }
});

test('a task event while the target is MID-TURN does not fire an armed clear', async () => {
  // The drain trigger is for the drained-IDLE case only. Firing it under an
  // in-flight turn would rotate the context out from under that turn.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);

    await callTool(srv.baseUrl, 'renew_session', { summary: 'MID-TURN-SUMMARY' }, { caller: sid1 });
    // Mid-turn (this fixture's MARK-D turn emits nothing).
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: `${DIRECTIVE} working` });
    await waitFor(() => inst.status === 'turn');

    // A terminal task event arrives mid-turn — the shape the drain trigger watches.
    srv.instances.emit('event', { id: inst.id, ev: { kind: 'system', subtype: 'task_notification' } });
    assert.equal(srv.instances._sessionRenew.pending.get(inst.id)?.state, 'armed',
      'still armed: the clear waits for the turn to end');
    assert.notEqual(inst.backingSessionId, NEW_SID, 'and nothing rotated mid-turn');

    // …and the ordinary turn_end path still fires it.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });
    await waitFor(() => inst.backingSessionId === NEW_SID);
  } finally {
    await srv.close();
  }
});

test('a request whose prompt throws leaves no pending entry to expire', async () => {
  // Otherwise the worker carries a live `requested` entry it was never told about,
  // and its next turn_end reports a decline for a request that never went out.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);
    const realPrompt = worker.prompt.bind(worker);
    worker.prompt = async (text, atts, opts) => {
      if (typeof text === 'string' && text.includes('asking you to renew')) throw new Error('simulated prompt failure');
      return realPrompt(text, atts, opts);
    };

    const { body } = await rpc(srv.baseUrl, 'tools/call', {
      name: 'renew_session', arguments: { sessionId: wSid, directive: `${DIRECTIVE}: roster` },
    }, { caller: condSid });
    assert.equal(body.result.isError, true, `the failure must surface: ${JSON.stringify(body.result)}`);
    assert.match(body.result.content[0].text, /simulated prompt failure/);
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false,
      'the registration is rolled back with the prompt that would have carried it');

    // A later, ordinary turn of that worker must therefore report nothing.
    worker.prompt = realPrompt;
    armWake(srv.instances, condSid, wSid, 600_000);
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' });
    const stub = await waitFor(() => echoWith(cond, 'get_recent_messages'));
    assert.ok(!stub.text.includes('DECLINED'), `no phantom decline: ${stub.text}`);
  } finally {
    await srv.close();
  }
});

test('request() never clobbers a live renewal, and reports whether it replaced a request', async () => {
  // The controller's own guard, at its own surface: the MCP interlock refuses this
  // first, so the guard is the second line — and the handler now reads its verdict
  // instead of prompting a worker whose renewal is already in flight.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);
    const ctl = srv.instances._sessionRenew;

    // A first request registers; a second REPLACES it rather than stacking.
    assert.deepEqual(srv.instances.requestSessionRenew(worker.id, { followUp: 'F1', requestedBy: condSid }),
      { requested: true, rerequested: false });
    assert.deepEqual(srv.instances.requestSessionRenew(worker.id, { followUp: 'F2', requestedBy: condSid }),
      { requested: true, rerequested: true }, 'the second call reports that it replaced one');
    assert.equal(ctl.pending.get(worker.id).state, 'requested');
    assert.equal(ctl.pending.get(worker.id).opts.followUp, 'F2', 'and the newer followUp wins');

    // The worker's own self-call CONSUMES the request — which is not a re-arm.
    assert.deepEqual(srv.instances.armSessionRenew(worker.id, { summary: 'S' }),
      { armed: true, rearmed: false }, 'consuming a request is the transition, not a re-arm');
    assert.deepEqual(srv.instances.armSessionRenew(worker.id, { summary: 'S2' }),
      { armed: true, rearmed: true }, 'a genuine second call in the same turn IS a re-arm');

    // With a renewal armed, a request must be refused rather than resetting the
    // entry to `requested` — which would discard the summary and never fire.
    assert.deepEqual(srv.instances.requestSessionRenew(worker.id, { followUp: 'F3', requestedBy: condSid }),
      { requested: false, rerequested: false });
    const live = ctl.pending.get(worker.id);
    assert.equal(live.state, 'armed', 'the live renewal is untouched');
    assert.equal(live.opts.summary, 'S2', 'and still carries the worker\'s summary');
    assert.equal(live.opts.followUp, 'F2',
      'and the followUp it consumed — the refused request did not overwrite it with F3');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Review round 2: "free" is wider than `status === 'idle'`, and the drain
// trigger's defer half / the dead-caller note drop needed pinning.
// ---------------------------------------------------------------------------

test('an IDLE target that owes a re-invocation turn is still refused', async () => {
  // A status-based readiness check returns on `status` alone, so probe-then-renew_session
  // walks straight into this: a task notification fired mid-turn and no top-level
  // tool_result followed, which means the CLI WILL open a re-invocation turn. That
  // turn ends before any turn the request would get, expiring it as a decline the
  // worker never saw.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);
    // The state an unconsumed mid-turn task_notification leaves behind.
    worker._taskNotificationPending = true;
    assert.equal(worker.status, 'idle', 'precondition: `status` alone says it is free');
    assert.equal(worker.taskNotificationPending, true);

    const busy = await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster` }, { caller: condSid });
    assert.equal(busy.ok, false, `must refuse: ${JSON.stringify(busy)}`);
    assert.equal(busy.code, 'SESSION_BUSY');
    assert.equal(busy.busy, 'task-notification', 'and names the owed re-invocation turn');
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false, 'nothing registered');
    assert.equal(srv.instances._idleHub.hasArmedWake(worker.id), false, 'no wake burned');
  } finally {
    await srv.close();
  }
});

test('an OVERAGE-PARKED target is refused rather than left to the watchdog', async () => {
  // Deterministic, not a race: an overage-stopped worker is `idle`, and prompt()
  // takes the queue branch WITHOUT opening a turn. Accepting the request would
  // report a dispatch for a turn that never runs, so the conductor eats the
  // full watchdog and is told a healthy, merely rate-limited worker "did NOT finish".
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);
    worker._overageQueue.push({ text: 'parked turn', attachments: [], ts: 1 });
    assert.equal(worker.status, 'idle', 'precondition: `status` alone says it is free');

    const busy = await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster` }, { caller: condSid });
    assert.equal(busy.ok, false, `must refuse: ${JSON.stringify(busy)}`);
    assert.equal(busy.code, 'SESSION_BUSY');
    assert.equal(busy.busy, 'overage-queue');
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false, 'nothing registered');
    assert.equal(srv.instances._idleHub.hasArmedWake(worker.id), false, 'no wake burned');
    // …and no request text was written to the worker either.
    assert.equal(echoWith(worker, DIRECTIVE), undefined, 'and the worker was never prompted');
  } finally {
    await srv.close();
  }
});

test('the drain trigger defers while a SECOND background task is still live', async () => {
  // The drain path shares the turn_end path's defer predicate. Without it, the
  // first of two tasks completing fires the /clear and strands the second.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const inst = instForSession(srv.instances, sid1);
    const drain = () => srv.instances.emit('event', { id: inst.id, ev: { kind: 'system', subtype: 'task_updated' } });
    const state = () => srv.instances._sessionRenew.pending.get(inst.id)?.state;

    await callTool(srv.baseUrl, 'renew_session', { summary: 'TWO-TASK-SUMMARY' }, { caller: sid1 });
    // Two backgrounded Agent tasks live while the worker sits idle.
    inst._activeAgentTasks.set('t1', null);
    inst._activeAgentTasks.set('t2', null);
    assert.equal(inst.status, 'idle');

    drain();
    assert.equal(state(), 'armed', 'two tasks live → deferred');
    inst._activeAgentTasks.delete('t1');
    drain();
    assert.equal(state(), 'armed', 'one still live → still deferred');
    assert.notEqual(inst.backingSessionId, NEW_SID, 'and nothing rotated with work in flight');

    // Fully drained → the same one implementation fires.
    inst._activeAgentTasks.delete('t2');
    drain();
    await waitFor(() => inst.backingSessionId === NEW_SID);
    await waitFor(() => echoWith(inst, 'TWO-TASK-SUMMARY'));
  } finally {
    await srv.close();
  }
});

test('a note whose caller has no live subprocess is consumed, not saved for its respawn', async () => {
  // deliver() drops silently when the caller's proc is gone — but respawn reuses the
  // same instance object AND instanceId without purging, so a retained note would
  // resurface as a stale DECLINED on the conductor's next wake, about a request that
  // was already answered.
  const srv = await bootServer({ scenarioPath: SCENARIO_REQUEST });
  mgr = srv.instances;
  try {
    const { condSid, wSid, cond, worker } = await pair(srv);
    const hub = srv.instances._idleHub;

    armWake(srv.instances, condSid, wSid, 600_000);
    srv.instances.noteRenewalDeclined(worker.id, condSid);

    // The conductor's subprocess dies between the turn_end and the delivery microtask.
    const proc = cond.proc;
    cond.proc = null;
    hub.deliver(cond.id, worker.id);
    cond.proc = proc; // …and comes back on the same instanceId, as respawn does.
    assert.equal(hub._takeDecline(worker.id, cond.id), null,
      'the undeliverable note was consumed with the wake it belonged to');

    // Proof of the consequence: the next real wake carries no stale decline.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: 'go1' }, { caller: condSid });
    const stub = await waitFor(() => echoWith(cond, 'get_recent_messages'));
    assert.ok(!stub.text.includes('DECLINED'), `no stale decline after respawn: ${stub.text}`);
  } finally {
    await srv.close();
  }
});

test('a target with LIVE SUBAGENTS is refused on the request path too', async () => {
  // The third clause of the shared predicate, isolated at the MCP surface. It is a
  // POLICY rather than a hazard — an accepted request would still open a turn, arm,
  // defer and fire from the drain — which is exactly why it needs its own pin: the
  // controller-side tests cover the same clause on the /clear path, so without this
  // the request path's use of it could silently revert. The conductor's prescribed
  // trigger (its own idle wake) is gated on this same background work.
  const srv = await bootServer({ scenarioPath: SCENARIO_DECLINE_DEFER });
  mgr = srv.instances;
  try {
    const { condSid, wSid, worker } = await pair(srv);
    // This fixture's MARK-D turn launches a backgrounded Agent task and ends with it
    // live, so the worker lands in the state under test: idle, one subagent running.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: wSid, text: `${DIRECTIVE} start a background agent` });
    await waitFor(() => worker.status === 'idle' && worker.summary().activeAgentTasks === 1);
    assert.equal(worker.taskNotificationPending, false, 'precondition: no owed re-invocation turn');
    assert.equal(worker._overageQueue.length, 0, 'precondition: nothing parked either');

    const busy = await callTool(srv.baseUrl, 'renew_session',
      { sessionId: wSid, directive: `${DIRECTIVE}: roster`, followUp: 'MARK-F: next job' }, { caller: condSid });
    assert.equal(busy.ok, false, `must refuse: ${JSON.stringify(busy)}`);
    assert.equal(busy.code, 'SESSION_BUSY');
    assert.equal(busy.busy, 'subagents', 'and names the live background work');
    assert.equal(busy.status, 'idle', 'while `status` alone would have said it was free');
    assert.equal(srv.instances._sessionRenew.pending.has(worker.id), false, 'nothing registered');
    assert.equal(srv.instances._idleHub.hasArmedWake(worker.id), false, 'no wake burned');
    assert.equal(worker.ringSnapshot().find((ev) => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('asking you to renew')), undefined,
      'and the worker was never prompted with a request');
  } finally {
    await srv.close();
  }
});
