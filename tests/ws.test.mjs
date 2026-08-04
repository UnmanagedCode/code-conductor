import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_NORMAL = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_INTERRUPT = path.join(__dirname, 'fixtures', 'scenario-instance.json');

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())); }
      catch { messages.push(raw.toString()); }
    });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) {
        return waitFor(() => messages.find(predicate), { timeout });
      },
    }));
    ws.once('error', reject);
  });
}

async function setup(scenario = SCENARIO_NORMAL) {
  const ctx = await bootServer({ scenarioPath: scenario });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'b' });
  return ctx;
}

test('subscribe sends snapshot then live events', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id, reqId: 'r1' });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.equal(snap.status, 'idle');
    assert.ok(Array.isArray(snap.events));
    // Snapshot is empty before any prompt — real claude doesn't emit init until first user message.
    assert.equal(snap.events.length, 0, 'snapshot empty before first prompt');
    await c.wait(m => m.t === 'ack' && m.reqId === 'r1' && m.ok);

    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    const liveKinds = c.messages.filter(m => m.t === 'event' && m.id === id).map(m => m.ev.kind);
    assert.ok(liveKinds.includes('text_delta'));
    assert.ok(liveKinds.includes('tool_use'));
    assert.ok(liveKinds.includes('tool_result'));
    assert.ok(liveKinds.includes('turn_end'));
    // The init system event arrives in the live stream after the first prompt.
    assert.ok(liveKinds.includes('system'), 'init delivered after first prompt');

  } finally {
    if (c) await c.close();
    await close();
  }
});

test('reconnect mid-stream replays snapshot without duplicating events', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c2 = null;
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    const c1 = await wsClient(wsUrl);
    c1.send({ t: 'subscribe', id });
    await c1.wait(m => m.t === 'snapshot' && m.id === id);
    c1.send({ t: 'prompt', id, text: 'one' });
    await c1.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    const c1Events = c1.messages.filter(m => m.t === 'event' && m.id === id).map(m => m.ev);
    await c1.close();

    // New tab connects: snapshot should include the same events.
    c2 = await wsClient(wsUrl);
    c2.send({ t: 'subscribe', id });
    const snap = await c2.wait(m => m.t === 'snapshot' && m.id === id);
    const snapKinds = snap.events.map(e => e.kind);
    const c1Kinds = c1Events.map(e => e.kind);
    for (const k of c1Kinds) {
      assert.ok(snapKinds.includes(k), `snapshot missing ${k}`);
    }
    // No duplicate by _seq within the snapshot.
    const seqs = snap.events.map(e => e._seq);
    assert.equal(new Set(seqs).size, seqs.length, 'snapshot _seq unique');

    // Now drive another prompt — live events should pick up where snapshot left off.
    const beforeLive = c2.messages.length;
    c2.send({ t: 'prompt', id, text: 'two' });
    await c2.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    const newLive = c2.messages.slice(beforeLive).filter(m => m.t === 'event' && m.id === id);
    const maxSnapSeq = Math.max(...seqs);
    for (const m of newLive) {
      assert.ok(m.ev._seq > maxSnapSeq, `live _seq ${m.ev._seq} must exceed maxSnapSeq ${maxSnapSeq}`);
    }
  } finally {
    if (c2) await c2.close();
    await close();
  }
});

test('subscribe sends only the ring tail, snapped to a turn boundary', async () => {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_SNAPSHOT_TAIL = '12';
  process.env.ORCH_EVENT_RING_CAP = '40';
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    // Synthesize a long history: a user_echo every 5th event.
    const inst = instances.get(id);
    for (let i = 0; i < 100; i++) {
      inst._emitUi(i % 5 === 0
        ? { kind: 'user_echo', text: `prompt ${i / 5}` }
        : { kind: 'text_delta', msgId: 'mT', blockIdx: 0, text: `e${i}` });
    }

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.ok(snap.events.length <= 12, `tail-only snapshot (${snap.events.length} > 12)`);
    assert.ok(snap.events.length > 0);
    // Window start snapped forward to a turn boundary.
    assert.equal(snap.events[0].kind, 'user_echo');
    // Frame metadata for the lazy-load affordance.
    assert.equal(snap.tailStartSeq, snap.events[0]._seq);
    assert.ok(snap.tailStartSeq > 0, 'older history exists below the tail');
    assert.equal(typeof snap.trimmedBefore, 'number');
    // Tail is the NEWEST slice.
    const ring = inst.ringSnapshot();
    assert.equal(snap.events[snap.events.length - 1]._seq, ring[ring.length - 1]._seq);
  } finally {
    if (c) await c.close();
    await close();
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('snapshot carries tasksAtTailStart for a batch created below the tail', async () => {
  // A still-incomplete batch whose TaskCreate sits below the ring tail must be
  // recoverable by the client panel via the snapshot's tasksAtTailStart seed
  // (src/instances.ts reconstructActiveTasks → src/taskReconstruct.ts).
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  process.env.ORCH_EVENT_RING_CAP = '200'; // no trim — the create stays in the ring, below the tail
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);
    const inst = instances.get(id);

    // Open an in-flight batch at the very start of history…
    inst._emitUi({ kind: 'user_echo', text: 'start' });
    inst._emitUi({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tc', input: { subject: 'Big batch' } });
    inst._emitUi({ kind: 'tool_result', toolUseId: 'tc', content: 'Task #1 created successfully: Big batch', isError: false });
    inst._emitUi({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu', input: { taskId: '1', status: 'in_progress' } });
    // …then a long tail of unrelated turns that pushes the batch below the tail.
    for (let i = 0; i < 30; i++) {
      inst._emitUi(i % 5 === 0
        ? { kind: 'user_echo', text: `turn ${i / 5}` }
        : { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: `e${i}` });
    }

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);

    // The TaskCreate is genuinely below the tail window.
    assert.ok(snap.tailStartSeq > 3, 'tail starts after the task events');
    assert.ok(!snap.events.some(e => e.name === 'TaskCreate'), 'create is not in the tail');
    // …but the in-flight batch is delivered for the panel seed.
    assert.ok(Array.isArray(snap.tasksAtTailStart));
    assert.deepEqual(snap.tasksAtTailStart.map(t => ({ id: t.id, status: t.status, subject: t.subject })),
      [{ id: '1', status: 'in_progress', subject: 'Big batch' }]);
  } finally {
    if (c) await c.close();
    await close();
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('snapshot carries lastContextUsage when the tail holds no message_start', async () => {
  // The ctx chip is fed ONLY by message_start (public/usage.js) and the client
  // rebuilds its UsageTracker from the snapshot tail alone. A turn whose final
  // text block is longer than the tail leaves the tail's quiescent snap with
  // nowhere to cut but past the whole block — dropping every message_start — so
  // the reading has to ride the frame as a field instead. This is the shape a
  // long single-block answer produces in production (observed at 800-2000
  // consecutive text_deltas on an ollama-backed session).
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_SNAPSHOT_TAIL = '4';
  process.env.ORCH_EVENT_RING_CAP = '200'; // no trim — the message_start stays in the ring, below the tail
  const { baseUrl, wsUrl, instances, close } = await setup();
  // Closed in `finally`, not after the asserts: a failing assert would otherwise
  // skip the close and leave bootServer's teardown waiting on a live socket, so
  // the regression would surface as a test-file timeout instead of a diff.
  let c = null;
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);
    const inst = instances.get(id);

    // A turn: message_start carrying the context size, then one unbroken text
    // block long enough to push it below the tail, then the turn footer.
    inst._emitUi({ kind: 'user_echo', text: 'write me an essay' });
    inst._emitUi({ kind: 'message_start', msgId: 'm1', model: 'glm-5.2',
      usage: { input_tokens: 79167, output_tokens: 0 } });
    for (let i = 0; i < 20; i++) {
      inst._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: `w${i} ` });
    }
    inst._emitUi({ kind: 'text_end', msgId: 'm1', blockIdx: 0 });
    inst._emitUi({ kind: 'turn_end', subtype: 'success' });

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);

    // The bug's precondition: the tail genuinely has no message_start to replay.
    assert.ok(!snap.events.some(e => e.kind === 'message_start'),
      'precondition: message_start must be below the tail for this test to mean anything');
    // …so the frame carries the reading instead. Survives turn_end deliberately:
    // between turns is exactly when a reload would otherwise show `ctx —`.
    assert.deepEqual(snap.lastContextUsage, { input_tokens: 79167, output_tokens: 0 });
  } finally {
    if (c) await c.close();
    await close();
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('lastContextUsage tracks the newest message_start and is cleared by a rewind wipe', async () => {
  const { baseUrl, instances, close } = await setup();
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);
    const inst = instances.get(id);

    assert.equal(inst.lastContextUsage, null, 'null before the first message_start');
    inst._emitUi({ kind: 'message_start', msgId: 'm1', usage: { input_tokens: 100 } });
    inst._emitUi({ kind: 'message_start', msgId: 'm2', usage: { input_tokens: 200 } });
    assert.deepEqual(inst.lastContextUsage, { input_tokens: 200 }, 'last value wins');
    inst._emitUi({ kind: 'turn_end', subtype: 'success' });
    assert.deepEqual(inst.lastContextUsage, { input_tokens: 200 },
      'survives turn_end (unlike the thinking counter) — the reading is still valid between turns');

    // A rewind/respawn rewrites the prefix in place, so the stale reading must go.
    // (A fork needs no reset — it builds a new Instance, and the forked-from
    // session keeps running with its own value.)
    inst._wipeForResume();
    assert.equal(inst.lastContextUsage, null, 'cleared by _wipeForResume');
  } finally { await close(); }
});

// ── seeding the reading from jsonl replay (card 2026-0026) ──────────────────

// The replay path emits no `message_start` of its own, so before this a resumed
// session had nothing to latch and read `ctx —` until its first live turn.
// loadHistory now replays the jsonl's own reading as one synthetic,
// non-retained `message_start`.
const CTX_USAGE = { input_tokens: 2, cache_read_input_tokens: 79165, cache_creation_input_tokens: 0, output_tokens: 500 };

// Materialize a resumable jsonl at the cwd-encoded path loadHistory reads.
// `content` defaults to a real text block so the line actually replays; pass []
// for the degenerate "usage but nothing to replay" case.
async function seedResumableJsonl(ctx, project, { content = [{ type: 'text', text: 'prior answer' }], usage = CTX_USAGE, model = 'claude-opus-5' } = {}) {
  const sid = randomUUID();
  const cwd = path.join(ctx.projectsRoot, project);
  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'earlier prompt' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_prior', role: 'assistant', model, content, usage } },
  ];
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return sid;
}

test('a resumed session carries its ctx reading before taking any live turn', async () => {
  const ctx = await setup();
  const { baseUrl, wsUrl, instances, close } = ctx;
  let c = null;
  try {
    const sid = await seedResumableJsonl(ctx, 'a');
    const created = await api(baseUrl, 'POST', '/api/instances',
      { project: 'a', resume: sid, mode: 'bypassPermissions' });
    const id = created.body.id;
    // Reaching 'idle' IS the replay barrier — spawn() awaits loadHistory before
    // flipping the status, so asserting straight after gives a diff on
    // regression rather than a polling timeout.
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    // The headline acceptance criterion: populated with no prompt ever sent.
    assert.deepEqual(inst.lastContextUsage, CTX_USAGE,
      'seeded from the jsonl, not from a live turn');

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.deepEqual(snap.lastContextUsage, CTX_USAGE, 'rides the snapshot frame as before');
    // Non-retained: it must never reach `conversation.apply` through a replay.
    assert.ok(!snap.events.some(e => e.kind === 'message_start'),
      'the synthetic event is kept OUT of events[]');
    assert.ok(!inst.ring.buf.some(e => e.kind === 'message_start'),
      'and out of the ring — so it can never become the ring head and fake a history_gap');
    assert.ok(snap.events.some(e => e.kind === 'text_delta'),
      'precondition: the real history did replay into the ring');
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('the replayed reading reaches an already-subscribed client (the rewind/respawn case)', async () => {
  // A rewind/respawn wipes the value and broadcasts reset_snapshot BEFORE
  // loadHistory replays, so a field-only fix could never reach a client that is
  // already subscribed. The live `event` frame is what closes that gap.
  const ctx = await setup();
  const { baseUrl, wsUrl, instances, close } = ctx;
  let c = null;
  try {
    const sid = await seedResumableJsonl(ctx, 'a');
    const created = await api(baseUrl, 'POST', '/api/instances',
      { project: 'a', resume: sid, mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot' && m.id === id);

    // Exactly what rewindToUserMessage / respawn do around the replay.
    inst._wipeForResume();
    assert.equal(inst.lastContextUsage, null, 'the wipe clears it first');
    await inst.loadHistory(sid);

    const frame = await c.wait(m => m.t === 'event' && m.id === id && m.ev.kind === 'message_start');
    assert.equal(frame.ev.replayed, true, 'flagged so EventLog.push declines to retain it');
    assert.deepEqual(frame.ev.usage, CTX_USAGE);
    assert.equal(frame.ev._seq, undefined, 'seq-less — it got no ring slot');
    assert.equal('model' in frame.ev, false,
      'model deliberately omitted so the instance tagged model owns the window denominator');
    assert.deepEqual(inst.lastContextUsage, CTX_USAGE, 're-seeded by the replay');
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('a non-retained replay event does not disturb the ring seq or the archive seam', async () => {
  const ctx = await setup();
  const { baseUrl, instances, close } = ctx;
  try {
    const sid = await seedResumableJsonl(ctx, 'a');
    const created = await api(baseUrl, 'POST', '/api/instances',
      { project: 'a', resume: sid, mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    assert.deepEqual(inst.lastContextUsage, CTX_USAGE, 'precondition: the replay seeded');

    // idleSubscriptions.ts arms on ring.nextSeq as its "activity since arm"
    // marker, so a retained synthetic event would have looked like new activity.
    const seqBefore = inst.ring.nextSeq;
    inst._emitUi({ kind: 'message_start', msgId: 'm_x', usage: CTX_USAGE, replayed: true });
    assert.equal(inst.ring.nextSeq, seqBefore, 'declined events do not advance nextSeq');
    // …while a genuine live message_start still is retained.
    inst._emitUi({ kind: 'message_start', msgId: 'm_y', usage: { input_tokens: 5 } });
    assert.equal(inst.ring.nextSeq, seqBefore + 1, 'the live kind is unaffected');
  } finally { await close(); }
});

test('no reading is replayed when the jsonl has usage but nothing to replay', async () => {
  // The `replayedCount > 0` guard: it is what makes the synthetic event provably
  // never the first thing a client sees, so it can't strip the conversation's
  // empty-state placeholder (see tests/transcript-context-usage.test.mjs).
  const ctx = await setup();
  const { baseUrl, instances, close } = ctx;
  try {
    const cwd = path.join(ctx.projectsRoot, 'a');
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    const sid = randomUUID();
    // An assistant line carrying usage but zero content blocks replays to no
    // UI events at all, so replayedCount stays 0.
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify(
      { type: 'assistant', uuid: 'a1', message: { id: 'm_empty', role: 'assistant', model: 'claude-opus-5', content: [], usage: CTX_USAGE } },
    ) + '\n');

    const created = await api(baseUrl, 'POST', '/api/instances',
      { project: 'a', resume: sid, mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    assert.equal(inst.ring.buf.length, 0, 'precondition: nothing replayed');
    assert.equal(inst.lastContextUsage, null, 'so no reading is seeded either');
  } finally { await close(); }
});

test('two clients on two instances stream concurrently and independently', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c1 = null, c2 = null;
  try {
    const a = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const b = await api(baseUrl, 'POST', '/api/instances', { project: 'b', mode: 'bypassPermissions' });
    const idA = a.body.id, idB = b.body.id;
    await waitFor(() => instances.get(idA).sessionId && instances.get(idB).sessionId);

    c1 = await wsClient(wsUrl);
    c2 = await wsClient(wsUrl);
    c1.send({ t: 'subscribe', id: idA });
    c2.send({ t: 'subscribe', id: idB });
    await c1.wait(m => m.t === 'snapshot' && m.id === idA);
    await c2.wait(m => m.t === 'snapshot' && m.id === idB);

    c1.send({ t: 'prompt', id: idA, text: 'A go' });
    c2.send({ t: 'prompt', id: idB, text: 'B go' });

    await c1.wait(m => m.t === 'event' && m.id === idA && m.ev.kind === 'turn_end');
    await c2.wait(m => m.t === 'event' && m.id === idB && m.ev.kind === 'turn_end');

    // Client 1 must not have received any event for instance B (and vice versa).
    for (const m of c1.messages) {
      if (m.t === 'event') assert.equal(m.id, idA, 'c1 only sees idA events');
    }
    for (const m of c2.messages) {
      if (m.t === 'event') assert.equal(m.id, idB, 'c2 only sees idB events');
    }
  } finally {
    if (c1) await c1.close();
    if (c2) await c2.close();
    await close();
  }
});

test('mode switch via WS updates instance.mode and acks', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'mode', id, mode: 'plan', reqId: 'm1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true);
    assert.equal(instances.get(id).mode, 'plan');
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('model switch via WS updates instance.model and acks', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    // The client sends a BARE version id; the server applies the catalog launch
    // tag (Sonnet 5 has none — it is natively 1M).
    c.send({ t: 'model', id, model: 'claude-sonnet-5', reqId: 'm1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true);
    assert.equal(instances.get(id).model, 'claude-sonnet-5');
    assert.equal(instances.get(id).contextWindowTokens, 1_000_000);
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('model switch via WS with an unknown model acks false', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'model', id, model: 'not-a-model', reqId: 'm2' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm2');
    assert.equal(ack.ok, false);
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('turn_notification is broadcast to every connected client (not just subscribers)', async () => {
  // Background instances should still ping the user (via the
  // turn_notification channel) even if the foreground tab is subscribed to a
  // different instance.
  const { baseUrl, wsUrl, instances, close } = await setup();
  let subscriber = null, bystander = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    subscriber = await wsClient(wsUrl);
    subscriber.send({ t: 'subscribe', id });
    await subscriber.wait(m => m.t === 'snapshot' && m.id === id);

    bystander = await wsClient(wsUrl); // never subscribes

    subscriber.send({ t: 'prompt', id, text: 'go' });
    await subscriber.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    await waitFor(() => bystander.messages.some(m => m.t === 'turn_notification' && m.id === id));

    const subNote = subscriber.messages.find(m => m.t === 'turn_notification' && m.id === id);
    const byNote = bystander.messages.find(m => m.t === 'turn_notification' && m.id === id);
    assert.ok(subNote, 'subscriber received turn_notification');
    assert.ok(byNote, 'bystander received turn_notification');
    assert.equal(byNote.project, 'a');
    assert.equal(byNote.isError, false);

    // The bystander stays quiet on the per-instance event channel.
    const byEvents = bystander.messages.filter(m => m.t === 'event');
    assert.equal(byEvents.length, 0);

  } finally {
    if (subscriber) await subscriber.close();
    if (bystander) await bystander.close();
    await close();
  }
});

test('projects hint is broadcast on instance lifecycle so sidebar session counts refresh', async () => {
  // Regression for "sessions disappear from the sidebar after the live
  // instance is killed". The frontend depends on this broadcast to
  // re-fetch /api/projects and pick up freshly-written session jsonls;
  // without it `summary.count` stays at the page-load value and a
  // project that started with zero on-disk sessions can have its whole
  // Sessions subnode vanish once `liveCount` drops to zero.
  const { baseUrl, wsUrl, instances, close } = await setup();
  let bystander = null;
  try {
    bystander = await wsClient(wsUrl);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => bystander.messages.some(m => m.t === 'projects'));
    // status flips during spawn + first idle also fire the hint
    await waitFor(() => instances.get(id).status === 'idle');
    const beforeRemove = bystander.messages.length;
    await instances.remove(id);
    await waitFor(() => bystander.messages.slice(beforeRemove).some(m => m.t === 'projects'));
  } finally {
    if (bystander) await bystander.close();
    await close();
  }
});

test('forced interrupt via WS (force:true) returns instance to idle', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup(SCENARIO_INTERRUPT);
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);
    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    // First turn completes.
    c.send({ t: 'prompt', id, text: 'one' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    // Second turn (slow); force-interrupt it.
    c.send({ t: 'prompt', id, text: 'two please be slow' });
    await waitFor(() => instances.get(id).status === 'turn');
    c.send({ t: 'interrupt', id, force: true });
    await waitFor(() => instances.get(id).status === 'idle');
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('soft interrupt via WS broadcasts interrupting:true without ending the turn', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup(SCENARIO_INTERRUPT);
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);
    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'prompt', id, text: 'one' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    c.send({ t: 'prompt', id, text: 'two please be slow' });
    await waitFor(() => instances.get(id).status === 'turn');

    // Soft interrupt — no force field.
    c.send({ t: 'interrupt', id });
    await c.wait(m => m.t === 'status' && m.id === id && m.interrupting === true);
    // Still in turn (soft does not sever it), flag set server-side.
    assert.equal(instances.get(id).status, 'turn');
    assert.equal(instances.get(id).interrupting, true);
  } finally {
    if (c) await c.close();
    await close();
  }
});

test('a client subscribing mid-thinking gets the partial thinking text AND the live token count', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    // Drive the instance into a mid-thinking state: an OPEN thinking block
    // whose per-token deltas + thinking_tokens counter stream like ollama.
    // (Direct _emitUi is the same funnel the live stdout path uses.)
    inst._emitUi({ kind: 'user_echo', text: 'reason about it' });
    inst._emitUi({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
    for (let i = 0; i < 8; i++) {
      inst._emitUi({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: `part${i} ` });
      inst._emitUi({ kind: 'system', subtype: 'thinking_tokens',
        data: { estimated_tokens: (i + 1) * 3 } });
    }
    // No thinking_end yet — the block is still streaming.
    assert.equal(inst.liveThinkingTokens, 24, 'server holds the latest count in O(1)');

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);

    // Partial thinking text is present (via the coalesced ring slot).
    const delta = snap.events.find(e => e.kind === 'thinking_delta' && e.msgId === 'm1');
    assert.ok(delta, 'the open thinking block is in the snapshot');
    assert.equal(delta.text, 'part0 part1 part2 part3 part4 part5 part6 part7 ',
      'full accumulated partial text from one coalesced slot');
    // Only ONE thinking_delta slot for the block (no per-token ring flood).
    assert.equal(snap.events.filter(e => e.kind === 'thinking_delta' && e.msgId === 'm1').length, 1);

    // The current token count rides the snapshot as a trailing seq-less event,
    // AFTER the open block so the client applies it to the reconstructed block.
    const tok = snap.events.find(e => e.kind === 'system' && e.subtype === 'thinking_tokens');
    assert.ok(tok, 'live token count re-attached to the snapshot');
    assert.equal(tok.data.estimated_tokens, 24);
    assert.equal(tok._seq, undefined, 'seq-less: never enters dedup/paging');
    const tokIdx = snap.events.indexOf(tok);
    const deltaIdx = snap.events.indexOf(delta);
    assert.ok(tokIdx > deltaIdx, 'count comes after the block it annotates');
    // tailStartSeq is computed from ring events, unperturbed by the trailing synthetic.
    assert.equal(snap.tailStartSeq, snap.events[0]._seq);

  } finally {
    if (c) await c.close();
    await close();
  }
});

test('a completed thinking block carries no stale live count on a fresh subscribe', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    inst._emitUi({ kind: 'user_echo', text: 'reason then finish' });
    inst._emitUi({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
    inst._emitUi({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'all done' });
    inst._emitUi({ kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: 500 } });
    inst._emitUi({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0 });
    // Block closed → the ephemeral count is cleared.
    assert.equal(inst.liveThinkingTokens, null, 'count cleared on thinking_end');

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.ok(!snap.events.some(e => e.kind === 'system' && e.subtype === 'thinking_tokens'),
      'no thinking_tokens re-attached for a finished block (viewed from disk)');
    // The finished thinking text is still present.
    assert.ok(snap.events.some(e => e.kind === 'thinking_delta' && e.text === 'all done'));

  } finally {
    if (c) await c.close();
    await close();
  }
});

test('a closed REDACTED thinking block keeps its token count on a fresh subscribe', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    // Redacted shape: counters stream but no thinking text ever arrives, so
    // content_block_stop yields thinking_redacted + thinking_end (parser.ts).
    inst._emitUi({ kind: 'user_echo', text: 'think privately' });
    inst._emitUi({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
    for (const n of [50, 200, 450]) {
      inst._emitUi({ kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: n } });
    }
    inst._emitUi({ kind: 'thinking_redacted', msgId: 'm1', blockIdx: 0 });
    inst._emitUi({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0 });
    assert.equal(inst.liveThinkingTokens, null, 'ephemeral count still cleared on thinking_end');

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);

    // No re-attached counter (the block is closed) — the estimate rides the
    // retained redacted slot instead, which is what survives the switch.
    assert.ok(!snap.events.some(e => e.kind === 'system' && e.subtype === 'thinking_tokens'),
      'no seq-less counter re-attached for a closed block');
    const red = snap.events.find(e => e.kind === 'thinking_redacted' && e.msgId === 'm1');
    assert.ok(red, 'the redacted block is in the snapshot');
    assert.equal(red.estimatedTokens, 450, 'final estimate stamped on the retained slot');
    assert.ok(red._seq !== undefined, 'the redacted slot is retained and seq-stamped');

  } finally {
    if (c) await c.close();
    await close();
  }
});

test('a redacted block with no counter frames carries no estimatedTokens', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  let c = null;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    // This is the jsonl-replay shape (src/transcript.ts): the CLI never
    // persists counter frames, so nothing stale may be stamped.
    inst._emitUi({ kind: 'user_echo', text: 'replayed turn' });
    inst._emitUi({ kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: 999 } });
    inst._emitUi({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0 });
    inst._emitUi({ kind: 'thinking_redacted', msgId: 'm1', blockIdx: 0 });
    inst._emitUi({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0 });

    c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    const red = snap.events.find(e => e.kind === 'thinking_redacted' && e.msgId === 'm1');
    assert.ok(red, 'the redacted block is in the snapshot');
    // NB: this assertion is rename-blind — it would also pass if the field
    // were renamed and never written. Its protection against that comes from
    // the `=== 450` assertion in the preceding test, the only place the
    // SERVER-side write of this field name is pinned (the client-side read is
    // pinned separately in tests/thinking-tokens.test.mjs). Don't delete that
    // one as redundant.
    assert.equal(red.estimatedTokens, undefined,
      'thinking_start cleared the stale counter — no carry-over from a prior block');

  } finally {
    if (c) await c.close();
    await close();
  }
});
