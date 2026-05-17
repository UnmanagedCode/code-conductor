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
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'default' });
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
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'default' });
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

test('two clients on two instances stream concurrently and independently', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup();
  try {
    const a = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'default' });
    const b = await api(baseUrl, 'POST', '/api/instances', { project: 'b', mode: 'default' });
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
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'mode', id, mode: 'acceptEdits', reqId: 'm1' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true);
    assert.equal(instances.get(id).mode, 'acceptEdits');
    await c.close();
  } finally { await close(); }
});

test('interrupt via WS returns instance to idle', async () => {
  const { baseUrl, wsUrl, instances, close } = await setup(SCENARIO_INTERRUPT);
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'default' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).sessionId);
    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    // First turn completes.
    c.send({ t: 'prompt', id, text: 'one' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    // Second turn (slow); interrupt it.
    c.send({ t: 'prompt', id, text: 'two please be slow' });
    await waitFor(() => instances.get(id).status === 'turn');
    c.send({ t: 'interrupt', id });
    await waitFor(() => instances.get(id).status === 'idle');
    await c.close();
  } finally { await close(); }
});
