// A resume replays the session's jsonl into the ring, but a subscribed client
// gets that history the way a reload does: the live `history_replayed` is its
// cue to re-subscribe, and the pulled snapshot tail plus /lineage-events paging
// carry every replayed event exactly once. The replay is held behind a gate so
// the client is subscribed (to the empty spawning snapshot) before it runs —
// the large-transcript race, made deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { Instance } from '../src/instances.ts';
import { appendModelSwitch } from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const PAIRS = 30;
const SEEDED = /^(prompt|answer)-\d+/;

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

function seededTexts() {
  const out = [];
  for (let i = 0; i < PAIRS; i++) {
    const n = String(i).padStart(2, '0');
    out.push(`prompt-${n}`, `answer-${n}`);
  }
  return out;
}

async function seedJsonl(ctx, project) {
  const sid = randomUUID();
  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, project)));
  await fs.mkdir(dir, { recursive: true });
  const records = [];
  let parent = null;
  for (let i = 0; i < PAIRS; i++) {
    const n = String(i).padStart(2, '0');
    const u = { type: 'user', uuid: `u${n}`, parentUuid: parent, message: { role: 'user', content: `prompt-${n}` } };
    const a = { type: 'assistant', uuid: `a${n}`, parentUuid: u.uuid,
      message: { id: `m${n}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `answer-${n}` }] } };
    records.push(u, a);
    parent = a.uuid;
  }
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { sid, lines: records.length };
}

/** Boot, seed, gate the replay, POST the resume and subscribe before it runs. */
async function resumeBehindGate(t) {
  const prevTail = process.env.ORCH_SNAPSHOT_TAIL;
  process.env.ORCH_SNAPSHOT_TAIL = '12';
  const orig = Instance.prototype.loadHistory;
  let release;
  const gate = new Promise(r => { release = r; });
  Instance.prototype.loadHistory = async function (...args) {
    await gate;
    return orig.apply(this, args);
  };
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let c = null;
  t.after(async () => {
    Instance.prototype.loadHistory = orig;
    if (prevTail === undefined) delete process.env.ORCH_SNAPSHOT_TAIL;
    else process.env.ORCH_SNAPSHOT_TAIL = prevTail;
    if (c) await c.close();
    await ctx.close();
  });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  const { sid, lines } = await seedJsonl(ctx, 'a');
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'a', resume: sid, mode: 'bypassPermissions' });
  const id = created.body.id;
  c = await wsClient(ctx.wsUrl);
  c.send({ t: 'subscribe', id });
  const first = await c.wait(m => m.t === 'snapshot' && m.id === id);
  assert.equal(first.events.some(e => SEEDED.test(e.text ?? '')), false, 'precondition: subscribed before the replay ran');
  release();
  const replayed = await c.wait(m => m.t === 'event' && m.id === id
    && m.ev.kind === 'system' && m.ev.subtype === 'history_replayed');
  return { ctx, c, id, inst: ctx.instances.get(id), lines, replayed };
}

/** Re-send subscribe (what the client does on a live history_replayed) and take the next snapshot. */
async function pull(c, id) {
  const before = c.messages.length;
  c.send({ t: 'subscribe', id });
  await waitFor(() => c.messages.slice(before).find(m => m.t === 'snapshot' && m.id === id));
  const at = c.messages.findIndex((m, i) => i >= before && m.t === 'snapshot' && m.id === id);
  return { snap: c.messages[at], at };
}

test('a client subscribed before the replay gets no replayed history as event frames', async (t) => {
  const { c, id, lines, replayed } = await resumeBehindGate(t);
  const leaked = c.messages.filter(m => m.t === 'event' && m.id === id && SEEDED.test(m.ev.text ?? ''));
  assert.deepEqual(leaked.map(m => m.ev.text), [], 'no replayed event reaches the socket');
  const markers = c.messages.filter(m => m.t === 'event' && m.id === id
    && m.ev.kind === 'system' && m.ev.subtype === 'history_replayed');
  assert.equal(markers.length, 1, 'exactly one live history_replayed');
  assert.equal(replayed.ev.data.count, lines, 'every seeded line replayed');
});

test('the pull after history_replayed serves the tail, and paging reaches the first turn', async (t) => {
  const { ctx, c, id, inst } = await resumeBehindGate(t);
  const { snap } = await pull(c, id);
  assert.equal(snap.events.at(-1)._seq, inst.ringSnapshot().at(-1)._seq, 'the tail ends at the ring head');
  assert.ok(snap.tailStartSeq > 0, 'fixture check: the tail is a strict suffix');

  const pages = [];
  let before = snap.tailStartSeq;
  let segment = null;
  for (let guard = 0; guard < 50; guard++) {
    let q = `limit=7&before=${before}`;
    if (segment != null) q += `&segment=${encodeURIComponent(segment)}`;
    const res = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/lineage-events?${q}`);
    assert.equal(res.status, 200);
    pages.unshift(res.body.events);
    if (!res.body.hasMore || res.body.nextBefore == null) break;
    before = res.body.nextBefore;
    segment = res.body.segment ?? null;
  }
  const texts = [...pages.flat(), ...snap.events].map(e => e.text ?? '').filter(s => SEEDED.test(s));
  assert.deepEqual(texts, seededTexts(), 'pages + tail hold each seeded turn once, in order');
});

test('live events after the pull continue the snapshot seq with no gap or duplicate', async (t) => {
  const { c, id } = await resumeBehindGate(t);
  await waitFor(() => c.messages.find(m => m.t === 'status' && m.id === id && m.status === 'idle'));
  const { snap, at } = await pull(c, id);
  c.send({ t: 'prompt', id, text: 'go' });
  await waitFor(() => c.messages.slice(at).find(m => m.t === 'event' && m.id === id && m.ev.kind === 'turn_end'));
  const live = c.messages.slice(at + 1).filter(m => m.t === 'event' && m.id === id).map(m => m.ev._seq).filter(s => s != null);
  const snapSeqs = snap.events.map(e => e._seq).filter(s => s != null);
  const all = [...snapSeqs, ...live];
  assert.ok(live.length > 0, 'fixture check: the turn streamed');
  for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1], `seq ${all[i]} follows ${all[i - 1]}`);
  assert.equal(live[0], snapSeqs.at(-1) + 1, 'the first live seq continues the snapshot');
});

test('a replay of ledger dividers alone gets no history_replayed, so the dividers stream live', async (t) => {
  const orig = Instance.prototype.loadHistory;
  let release;
  const gate = new Promise(r => { release = r; });
  Instance.prototype.loadHistory = async function (...args) { await gate; return orig.apply(this, args); };
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let c = null;
  t.after(async () => {
    Instance.prototype.loadHistory = orig;
    if (c) await c.close();
    await ctx.close();
  });
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'a' });
  // One assistant line with no content blocks: it replays to no UI event, so
  // replayedCount is 0 while the file exists.
  const sid = randomUUID();
  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, 'a')));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify(
    { type: 'assistant', uuid: 'a1', message: { id: 'm_empty', role: 'assistant', model: 'claude-opus-5', content: [] } },
  ) + '\n');
  const created = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'a', resume: sid, mode: 'bypassPermissions' });
  const id = created.body.id;
  const inst = ctx.instances.get(id);
  const switchId = randomUUID();
  assert.equal(await appendModelSwitch(inst.sessionId, {
    id: switchId, at: '2026-01-01T00:00:00.000Z', segment: sid, afterUuid: null,
    from: 'claude-haiku-4-5', to: 'claude-opus-5', ok: true,
  }), true, 'fixture check: the ledger entry landed');
  c = await wsClient(ctx.wsUrl);
  c.send({ t: 'subscribe', id });
  await c.wait(m => m.t === 'snapshot' && m.id === id);
  release();
  await waitFor(() => inst.status === 'idle');
  assert.ok(inst.ringSnapshot().some(e => e.data?.switchId === switchId), 'fixture check: the replay spliced the divider');
  assert.equal(inst.ringSnapshot().some(e => e.kind === 'system' && e.subtype === 'history_replayed'), false,
    'fixture check: replayedCount 0 — no marker');
  const frame = await c.wait(m => m.t === 'event' && m.id === id && m.ev.data?.switchId === switchId);
  assert.equal(frame.ev.replayed, true, 'the replayed divider itself reached the socket');
});
