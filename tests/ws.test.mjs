import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

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
  try {
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    const c = await wsClient(wsUrl);
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

    await c.close();
  } finally { await close(); }
});

test('reconnect mid-stream replays snapshot without duplicating events', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
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
    const c2 = await wsClient(wsUrl);
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
    await c2.close();
  } finally { await close(); }
});

test('subscribe sends only the ring tail, snapped to a turn boundary', async () => {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_SNAPSHOT_TAIL = '12';
  process.env.ORCH_EVENT_RING_CAP = '40';
  const { baseUrl, wsUrl, instances, close } = await setup();
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

    const c = await wsClient(wsUrl);
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
    await c.close();
  } finally {
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
  // (src/instances.js reconstructActiveTasks → src/taskReconstruct.js).
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_SNAPSHOT_TAIL = '8';
  process.env.ORCH_EVENT_RING_CAP = '200'; // no trim — the create stays in the ring, below the tail
  const { baseUrl, wsUrl, instances, close } = await setup();
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

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);

    // The TaskCreate is genuinely below the tail window.
    assert.ok(snap.tailStartSeq > 3, 'tail starts after the task events');
    assert.ok(!snap.events.some(e => e.name === 'TaskCreate'), 'create is not in the tail');
    // …but the in-flight batch is delivered for the panel seed.
    assert.ok(Array.isArray(snap.tasksAtTailStart));
    assert.deepEqual(snap.tasksAtTailStart.map(t => ({ id: t.id, status: t.status, subject: t.subject })),
      [{ id: '1', status: 'in_progress', subject: 'Big batch' }]);
    await c.close();
  } finally {
    await close();
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('two clients on two instances stream concurrently and independently', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const a = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const b = await api(baseUrl, 'POST', '/api/instances', { project: 'b', mode: 'bypassPermissions' });
    const idA = a.body.id, idB = b.body.id;
    await waitFor(() => instances.get(idA).sessionId && instances.get(idB).sessionId);

    const c1 = await wsClient(wsUrl);
    const c2 = await wsClient(wsUrl);
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
    await c1.close();
    await c2.close();
  } finally { await close(); }
});

test('mode switch via WS updates instance.mode and acks', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'mode', id, mode: 'plan', reqId: 'm1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true);
    assert.equal(instances.get(id).mode, 'plan');
    await c.close();
  } finally { await close(); }
});

test('model switch via WS updates instance.model and acks', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'model', id, model: 'claude-sonnet-5[1m]', reqId: 'm1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true);
    assert.equal(instances.get(id).model, 'claude-sonnet-5[1m]');
    await c.close();
  } finally { await close(); }
});

test('model switch via WS with an unknown model acks false', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'model', id, model: 'not-a-model', reqId: 'm2' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm2');
    assert.equal(ack.ok, false);
    await c.close();
  } finally { await close(); }
});

test('turn_notification is broadcast to every connected client (not just subscribers)', async () => {
  // Background instances should still ping the user (via the
  // turn_notification channel) even if the foreground tab is subscribed to a
  // different instance.
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    const subscriber = await wsClient(wsUrl);
    subscriber.send({ t: 'subscribe', id });
    await subscriber.wait(m => m.t === 'snapshot' && m.id === id);

    const bystander = await wsClient(wsUrl); // never subscribes

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

    await subscriber.close();
    await bystander.close();
  } finally { await close(); }
});

test('projects hint is broadcast on instance lifecycle so sidebar session counts refresh', async () => {
  // Regression for "sessions disappear from the sidebar after the live
  // instance is killed". The frontend depends on this broadcast to
  // re-fetch /api/projects and pick up freshly-written session jsonls;
  // without it `summary.count` stays at the page-load value and a
  // project that started with zero on-disk sessions can have its whole
  // Sessions subnode vanish once `liveCount` drops to zero.
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const bystander = await wsClient(wsUrl);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => bystander.messages.some(m => m.t === 'projects'));
    // status flips during spawn + first idle also fire the hint
    await waitFor(() => instances.get(id).status === 'idle');
    const beforeRemove = bystander.messages.length;
    await instances.remove(id);
    await waitFor(() => bystander.messages.slice(beforeRemove).some(m => m.t === 'projects'));
    await bystander.close();
  } finally { await close(); }
});

test('forced interrupt via WS (force:true) returns instance to idle', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup(SCENARIO_INTERRUPT);
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);
    const c = await wsClient(wsUrl);
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
    await c.close();
  } finally { await close(); }
});

test('soft interrupt via WS broadcasts interrupting:true without ending the turn', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup(SCENARIO_INTERRUPT);
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);
    const c = await wsClient(wsUrl);
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
    await c.close();
  } finally { await close(); }
});

test('a client subscribing mid-thinking gets the partial thinking text AND the live token count', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
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

    const c = await wsClient(wsUrl);
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

    await c.close();
  } finally { await close(); }
});

test('a completed thinking block carries no stale live count on a fresh subscribe', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
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

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === id);
    assert.ok(!snap.events.some(e => e.kind === 'system' && e.subtype === 'thinking_tokens'),
      'no thinking_tokens re-attached for a finished block (viewed from disk)');
    // The finished thinking text is still present.
    assert.ok(snap.events.some(e => e.kind === 'thinking_delta' && e.text === 'all done'));

    await c.close();
  } finally { await close(); }
});
