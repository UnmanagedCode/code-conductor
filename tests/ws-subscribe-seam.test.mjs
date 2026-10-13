// The subscribe snapshot/live seam: the snapshot is the ring as of one
// synchronous capture, and every per-instance frame emitted while it is being
// built (reconstructActiveTasks is held open here) follows it, in order. A
// pull-only event fills the ring and the manager stream but no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ws.json');

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}

/** An idle instance with a socket, and its snapshot build held open until `release()`. */
async function heldSubscribe(t, seed = () => {}) {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let c = null;
  t.after(async () => { if (c) await c.close(); await ctx.close(); });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
  const id = created.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  const inst = ctx.instances.get(id);
  inst._emitUi({ kind: 'user_echo', text: 'one' });
  inst._emitUi({ kind: 'user_echo', text: 'two' });
  seed(inst);
  let release;
  const held = new Promise(r => { release = r; });
  let entered;
  const building = new Promise(r => { entered = r; });
  inst.reconstructActiveTasks = () => { entered(); return held; };
  c = await wsClient(ctx.wsUrl);
  c.send({ t: 'subscribe', id, reqId: 'sub' });
  await building;
  return { ctx, c, id, inst, release: () => release([]) };
}

const indexOf = (msgs, pred) => msgs.findIndex(pred);

test('a frame emitted while a snapshot is built arrives after it', async (t) => {
  const { c, id, inst, release } = await heldSubscribe(t);
  inst._emitUi({ kind: 'user_echo', text: 'during' });
  release();
  await c.wait(m => m.t === 'ack' && m.reqId === 'sub');
  await c.wait(m => m.t === 'event' && m.id === id && m.ev.text === 'during');
  const snapAt = indexOf(c.messages, m => m.t === 'snapshot' && m.id === id);
  const evAt = indexOf(c.messages, m => m.t === 'event' && m.id === id && m.ev.text === 'during');
  assert.ok(snapAt !== -1 && snapAt < evAt, `snapshot (${snapAt}) precedes the event (${evAt})`);
  const snap = c.messages[snapAt];
  assert.equal(snap.events.some(e => e.text === 'during'), false, 'the event is not in the snapshot');
  assert.ok(c.messages[evAt].ev._seq > snap.events.at(-1)._seq, 'and continues its seq');
});

test('a delta folded into a tail slot during the build is neither lost nor doubled', async (t) => {
  const block = { kind: 'text_delta', msgId: 'mX', blockIdx: 0 };
  const { c, id, inst, release } = await heldSubscribe(t, (i) => i._emitUi({ ...block, text: 'ab' }));
  inst._emitUi({ ...block, text: 'c' });
  release();
  await c.wait(m => m.t === 'ack' && m.reqId === 'sub');
  const snapAt = indexOf(c.messages, m => m.t === 'snapshot' && m.id === id);
  assert.ok(snapAt !== -1, 'snapshot sent');
  const slot = c.messages[snapAt].events.find(e => e.kind === 'text_delta' && e.msgId === 'mX');
  const after = c.messages.slice(snapAt + 1)
    .filter(m => m.t === 'event' && m.id === id && m.ev.kind === 'text_delta' && m.ev.msgId === 'mX' && m.ev._seq == null)
    .map(m => m.ev.text);
  assert.equal(slot.text + after.join(''), 'abc');
});

test('a reset_snapshot during the build arrives after the snapshot', async (t) => {
  const { c, id, inst, release } = await heldSubscribe(t);
  inst._wipeForResume();
  release();
  await c.wait(m => m.t === 'ack' && m.reqId === 'sub');
  await c.wait(m => m.t === 'reset_snapshot' && m.id === id);
  const snapAt = indexOf(c.messages, m => m.t === 'snapshot' && m.id === id);
  const resetAt = indexOf(c.messages, m => m.t === 'reset_snapshot' && m.id === id);
  assert.ok(snapAt !== -1 && snapAt < resetAt, `snapshot (${snapAt}) precedes reset_snapshot (${resetAt})`);
});

test('a pullOnly event reaches the manager stream but never a socket', async (t) => {
  const { ctx, c, id, inst, release } = await heldSubscribe(t);
  release();
  await c.wait(m => m.t === 'ack' && m.reqId === 'sub');
  const seen = [];
  ctx.instances.on('event', ({ id: from, ev }) => { if (from === id) seen.push(ev.text); });
  inst._emitUi({ kind: 'user_echo', text: 'hidden' }, { replayed: true, pullOnly: true });
  inst._emitUi({ kind: 'user_echo', text: 'shown' });
  await c.wait(m => m.t === 'event' && m.id === id && m.ev.text === 'shown');
  const texts = c.messages.filter(m => m.t === 'event' && m.id === id).map(m => m.ev.text);
  assert.deepEqual(texts, ['shown'], 'only the normal event reaches the socket');
  assert.deepEqual(seen, ['hidden', 'shown'], 'the manager stream sees both');
  assert.ok(inst.ringSnapshot().some(e => e.text === 'hidden'), 'the ring holds the pull-only event');
});

test('a second subscribe on one socket does not start building until the first is sent, and a frame emitted during its build follows it once', async (t) => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let c = null;
  t.after(async () => { if (c) await c.close(); await ctx.close(); });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
  const id = created.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  const inst = ctx.instances.get(id);
  inst._emitUi({ kind: 'user_echo', text: 'one' });
  // Each build gets its own held reconstructActiveTasks.
  const builds = [];
  inst.reconstructActiveTasks = () => {
    let release;
    const held = new Promise(r => { release = r; });
    builds.push(() => release([]));
    return held;
  };
  c = await wsClient(ctx.wsUrl);
  c.send({ t: 'subscribe', id, reqId: 's1' });
  await waitFor(() => builds.length === 1);
  c.send({ t: 'subscribe', id, reqId: 's2' });
  // A socket's messages are dispatched in order, so once this probe is acked the
  // server has run s2's handler up to its first await — far enough to have
  // started build 2 had it not queued behind build 1.
  c.send({ t: 'unsubscribe', id: 'no-such-instance', reqId: 'probe' });
  await c.wait(m => m.t === 'ack' && m.reqId === 'probe');
  assert.equal(builds.length, 1, 'build 2 waits while build 1 is held');
  assert.equal(c.messages.some(m => m.t === 'ack' && m.reqId === 's2'), false, 's2 not acked yet');
  assert.equal(c.messages.some(m => m.t === 'snapshot'), false, 'no snapshot yet');
  builds[0]();
  await c.wait(m => m.t === 'ack' && m.reqId === 's1');
  await waitFor(() => builds.length === 2);
  inst._emitUi({ kind: 'user_echo', text: 'during' });
  builds[1]();
  await c.wait(m => m.t === 'ack' && m.reqId === 's2');
  await c.wait(m => m.t === 'event' && m.id === id && m.ev.text === 'during');
  const snaps = c.messages.map((m, i) => [m, i]).filter(([m]) => m.t === 'snapshot' && m.id === id);
  assert.equal(snaps.length, 2, 'two snapshots');
  for (const [s] of snaps) assert.equal(s.events.some(e => e.text === 'during'), false, 'outside both snapshots');
  const evAts = c.messages.map((m, i) => [m, i]).filter(([m]) => m.t === 'event' && m.id === id && m.ev.text === 'during').map(([, i]) => i);
  assert.equal(evAts.length, 1, 'sent exactly once');
  assert.ok(evAts[0] > snaps[1][1], `the event (${evAts[0]}) follows the second snapshot (${snaps[1][1]})`);
});
