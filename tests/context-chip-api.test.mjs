// The context chip end to end on a real in-process server with the fake CLI:
// REST set/clear, the `chip` frame and snapshot field, and the composer-only,
// exactly-once consumption through the WS `prompt` frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, userStdinLines } from './helpers.mjs';
import { MID_TURN_NOTE } from '../src/instances.ts';
import { CHIP_MARKER, composeChipMessage } from '../shared/contextChip.ts';

const SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-basic.json');

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.once('open', () => resolve({
      ws, messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(p, timeout = 4000) { return waitFor(() => messages.find(p), { timeout }); },
      chips() { return messages.filter(m => m.t === 'chip').map(m => m.chip); },
      acks() { return messages.filter(m => m.t === 'ack'); },
    }));
  });
}

const textsOf = (o) => (typeof o.message.content === 'string' ? [o.message.content]
  : o.message.content.filter(b => b.type === 'text').map(b => b.text))
  .filter(t => t !== MID_TURN_NOTE);

// One server, one idle session, and the CLI stdin transcript; `run` gets the
// helpers. Every client opened through `connect` is closed on the way out.
async function withSession(run) {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const clients = [];
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  try {
    const transcript = path.join(ctx.tmpHome, 'stdin.log');
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'chip' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'chip', mode: 'bypassPermissions' });
    if (!r.body?.id) throw new Error('spawn failed: ' + JSON.stringify(r));
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    const sid = inst.sessionId;
    const connect = async () => {
      const c = await wsClient(ctx.wsUrl);
      clients.push(c);
      c.send({ t: 'subscribe', id });
      await c.wait(m => m.t === 'snapshot');
      return c;
    };
    const put = (title = 'sel', data = 'body') => api(ctx.baseUrl, 'PUT', `/api/sessions/${sid}/chip`, { title, data });
    const del = (q = '') => api(ctx.baseUrl, 'DELETE', `/api/sessions/${sid}/chip${q}`);
    const stdin = async () => (await userStdinLines(transcript).catch(() => [])).flatMap(textsOf);
    await run({ ctx, id, inst, sid, connect, put, del, stdin });
  } finally {
    for (const c of clients) { try { await c.close(); } catch { /* gone */ } }
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT; else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    await ctx.close();
  }
}

// Invariant (7): a chip can only be set on a live session; refusals carry their code.
test('PUT on an unknown session → 404 SESSION_NOT_LIVE; a bad body → 400 INVALID_ARGUMENT', async () => {
  await withSession(async ({ ctx, sid, put, del }) => {
    const unknown = await api(ctx.baseUrl, 'PUT', '/api/sessions/00000000-0000-4000-8000-000000000000/chip', { title: 't', data: 'd' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'SESSION_NOT_LIVE');
    const gone = await api(ctx.baseUrl, 'DELETE', '/api/sessions/00000000-0000-4000-8000-000000000000/chip');
    assert.equal(gone.status, 404);
    const bad = await api(ctx.baseUrl, 'PUT', `/api/sessions/${sid}/chip`, { title: '', data: 'd' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ARGUMENT');
    const badRev = await del('?rev=abc');
    assert.equal(badRev.status, 400);
    assert.equal(badRev.body.code, 'INVALID_ARGUMENT');
    assert.equal((await put()).status, 200);
  });
});

// Invariants (1, 3): every subscriber sees a set live, a replacement replaces it,
// and a client subscribing later gets the current chip in its snapshot.
test('PUT sends a chip frame to every subscriber; a second PUT replaces it; a late subscriber snapshot carries it', async () => {
  await withSession(async ({ connect, put }) => {
    const a = await connect();
    const b = await connect();
    const first = await put('one', 'd1');
    assert.equal(first.status, 200);
    assert.equal(first.body.chip.title, 'one');
    await a.wait(m => m.t === 'chip' && m.chip?.title === 'one');
    await b.wait(m => m.t === 'chip' && m.chip?.title === 'one');
    const second = await put('two', 'd2');
    assert.ok(second.body.chip.rev > first.body.chip.rev);
    await a.wait(m => m.t === 'chip' && m.chip?.title === 'two');
    const late = await connect();
    const snap = late.messages.find(m => m.t === 'snapshot');
    assert.deepEqual(snap.chip, second.body.chip);
  });
});

// Invariants (2, 4): a clear reaches every subscriber, and a × naming a stale
// rev leaves the replacement in place.
test('DELETE sends chip:null to both clients; DELETE ?rev=stale → cleared:false and the chip is kept', async () => {
  await withSession(async ({ connect, put, del, inst }) => {
    const a = await connect();
    const b = await connect();
    const old = (await put('old', 'd')).body.chip;
    const cur = (await put('new', 'd')).body.chip;
    const stale = await del(`?rev=${old.rev}`);
    assert.deepEqual([stale.status, stale.body.cleared], [200, false]);
    assert.equal(inst.contextChip.get().rev, cur.rev);
    const ok = await del(`?rev=${cur.rev}`);
    assert.equal(ok.body.cleared, true);
    for (const c of [a, b]) await waitFor(() => c.chips().at(-1) === null);
    await put('again', 'd');
    assert.equal((await del()).body.cleared, true, 'no rev clears unconditionally');
    assert.equal((await del()).body.cleared, false);
  });
});

// Invariant (5): the composer's send carries the chip first — block, blank line,
// typed text — as ONE stdin message, then every client sees the chip cleared.
test('a prompt frame with chip=rev writes one stdin message: block + blank line + typed text, then sends chip:null', async () => {
  await withSession(async ({ connect, put, stdin, id }) => {
    const a = await connect();
    const chip = (await put('sel', 'line1\nline2')).body.chip;
    await a.wait(m => m.t === 'chip' && m.chip?.rev === chip.rev);
    a.send({ t: 'prompt', id, text: 'explain this', chip: chip.rev, reqId: 'r1' });
    await a.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(a.acks().at(-1).ok, true);
    await waitFor(async () => (await stdin()).length >= 1);
    assert.deepEqual(await stdin(), [composeChipMessage(chip, 'explain this')]);
    await waitFor(() => a.chips().at(-1) === null);
  });
});

// Invariant (5): a chip with nothing typed is a valid send — the block alone.
test('empty text + chip sends the block alone', async () => {
  await withSession(async ({ connect, put, stdin, id }) => {
    const a = await connect();
    const chip = (await put('sel', 'x')).body.chip;
    a.send({ t: 'prompt', id, text: '', chip: chip.rev, reqId: 'r1' });
    await a.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(a.acks().at(-1).ok, true);
    await waitFor(async () => (await stdin()).length >= 1);
    assert.deepEqual(await stdin(), [composeChipMessage(chip, '')]);
  });
});

// Invariant (exactly once): two clients sending the same rev deliver the chip once.
test('two sockets send the same rev → exactly one stdin message carries the marker', async () => {
  await withSession(async ({ connect, put, stdin, id, inst }) => {
    const a = await connect();
    const b = await connect();
    const chip = (await put('sel', 'x')).body.chip;
    a.send({ t: 'prompt', id, text: 'from a', chip: chip.rev, reqId: 'a1' });
    b.send({ t: 'prompt', id, text: 'from b', chip: chip.rev, reqId: 'b1' });
    await a.wait(m => m.t === 'ack' && m.reqId === 'a1');
    await b.wait(m => m.t === 'ack' && m.reqId === 'b1');
    await waitFor(async () => (await stdin()).length >= 2);
    const lines = await stdin();
    assert.equal(lines.filter(t => t.includes(CHIP_MARKER)).length, 1);
    assert.equal(lines.length, 2);
    assert.equal(inst.contextChip.get(), null);
  });
});

// Invariant (decision 2): a stale rev goes text only and leaves the replacement
// pending; a stale rev with nothing to send acks ok:false and writes nothing.
test('a stale rev with text sends text only; a stale rev with empty text acks ok:false and writes nothing', async () => {
  await withSession(async ({ connect, put, stdin, id, inst }) => {
    const a = await connect();
    const old = (await put('old', 'x')).body.chip;
    const cur = (await put('new', 'y')).body.chip;
    a.send({ t: 'prompt', id, text: 'typed', chip: old.rev, reqId: 'r1' });
    await a.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(a.acks().at(-1).ok, true);
    await waitFor(async () => (await stdin()).length >= 1);
    assert.deepEqual(await stdin(), ['typed']);
    assert.equal(inst.contextChip.get().rev, cur.rev, 'the replacement stays pending');

    a.send({ t: 'prompt', id, text: '', chip: old.rev, reqId: 'r2' });
    const ack = await a.wait(m => m.t === 'ack' && m.reqId === 'r2');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /context chip changed/);
    assert.deepEqual(await stdin(), ['typed'], 'nothing more was written');
    assert.equal(inst.contextChip.get().rev, cur.rev);
  });
});

// Invariant (6): only a frame that names the chip consumes it — the cards and
// the bridge send a bare prompt frame, and promptOrQueueSteer (MCP send_prompt's
// path) never touches the slot. A non-integer chip is refused.
test('a prompt frame without chip, and promptOrQueueSteer, leave the chip set and carry no marker', async () => {
  await withSession(async ({ connect, put, stdin, id, inst }) => {
    const a = await connect();
    const chip = (await put('sel', 'x')).body.chip;
    a.send({ t: 'prompt', id, text: 'bare', reqId: 'r1' });
    await a.wait(m => m.t === 'ack' && m.reqId === 'r1');
    await waitFor(async () => (await stdin()).length >= 1);
    await waitFor(() => inst.status === 'idle');
    await inst.promptOrQueueSteer('via mcp path', [], { author: 'human' });
    await waitFor(async () => (await stdin()).length >= 2);
    const lines = await stdin();
    assert.ok(lines.every(t => !t.includes(CHIP_MARKER)));
    assert.equal(inst.contextChip.get().rev, chip.rev);

    a.send({ t: 'prompt', id, text: 'x', chip: 'nope', reqId: 'r2' });
    const ack = await a.wait(m => m.t === 'ack' && m.reqId === 'r2');
    assert.equal(ack.ok, false);
    assert.equal((await stdin()).length, 2);
  });
});

// Invariant: a send that throws gives the chip back (nothing delivered it).
test('promptOrQueueSteer throwing restores the chip', async () => {
  await withSession(async ({ connect, put, id, inst }) => {
    const a = await connect();
    const chip = (await put('sel', 'x')).body.chip;
    inst.promptOrQueueSteer = async () => { throw new Error('rewriting'); };
    a.send({ t: 'prompt', id, text: 'hi', chip: chip.rev, reqId: 'r1' });
    const ack = await a.wait(m => m.t === 'ack' && m.reqId === 'r1');
    assert.equal(ack.ok, false);
    assert.equal(inst.contextChip.get().rev, chip.rev, 'chip is back');
  });
});

// Invariant (7): the session's real end drops the chip, and a chip cannot be
// set on a session that is no longer live.
test('exit drops the chip; PUT after exit → 404', async () => {
  await withSession(async ({ connect, put, inst, sid, ctx }) => {
    const a = await connect();
    await put('sel', 'x');
    await a.wait(m => m.t === 'chip' && m.chip);
    await inst.kill();
    await waitFor(() => inst.contextChip.get() === null);
    await waitFor(() => ctx.instances.liveForSession(sid) === null);
    const r = await put();
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'SESSION_NOT_LIVE');
  });
});

// Invariant: a dead status inside a relaunch window (rewind, prune, a restart
// model switch) is not the session's end — the chip survives it; a relaunch that
// ends with no process is the end, and drops it.
test('a dead status while _relaunching keeps the chip; the window ending with no process drops it', async () => {
  await withSession(async ({ put, inst }) => {
    await put('sel', 'x');
    inst._beginRelaunch();
    await inst.kill();
    await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');
    assert.equal(inst.contextChip.get()?.title, 'sel', 'kept across the window');
    inst._endRelaunch();
    assert.equal(inst.contextChip.get(), null, 'dropped when the window ends with no process');
  });
});
