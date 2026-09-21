// Card 2026-0183 Part E — the web UI's own injection path.
//
// The composer, the plan Approve/Reject card and the AskUserQuestion card all
// funnel through ONE WS frame (`{t:'prompt'}` → src/wsHub.ts), which called
// inst.prompt() directly with no status test and no capability test. So on a
// model declaring midTurnSteering:false all three human surfaces were silently
// swallowed — send_prompt's fix (card 2026-0182) is never on this path. The frame
// now routes through Instance.promptOrQueueSteer.
//
// Real WS client, real frames; boundary events are driven synthetically via
// inst._handleStdoutLine() only where the fixture cannot produce them, so nothing
// depends on subprocess timing. E-T3 (the unflagged pin) lives with the other
// card-answer invariants in tests/mid-turn-card-answer.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { POST_STOP_STEER_NOTE } from '../src/instances.ts';
import { addCustomModel } from '../src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 'open text' leaves a text block OPEN, so nothing can fire at a block edge until
// one is injected; the control:interrupt turn is what lets the aborted turn emit a
// result (without it the session never leaves 'turn' and the test dies on the
// runner's per-file timeout, reading as a flake).
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-deferred-steer-sites.json');
// A controlled model carrying the opt-out, registered into the isolated settings
// store by each flagged fixture below — deliberately NOT a curated preset, so a
// change to the curated model list cannot break this test.
const FLAGGED_MODEL = 'cc-test-steer-optout:cloud';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let ctx, baseUrl, wsUrl, instances, home, transcriptPath;
let seq = 0;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, wsUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  transcriptPath = path.join(home, `ws-stdin-${++seq}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  await addCustomModel({
    label: 'Steer opt-out (test)', model: FLAGGED_MODEL, backend: 'ollama',
    contextWindow: 256_000, midTurnSteering: false,
  });
});
// Registered by flaggedMidBlockOverWs and closed here, NOT on each test's success
// path: a leaked WS client keeps handles open, so `after`'s ctx.close() never
// completes and EVERY regression this file catches manifests as a process hang
// instead of a failing assertion.
const openClients = [];
afterEach(async () => {
  for (const c of openClients.splice(0)) { try { await c.close(); } catch { /* already gone */ } }
  await instances.shutdown();
  delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  await rmrf(home);
});

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.once('open', () => resolve({
      ws, messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      // Counts from `from` so a later frame's ack is never satisfied by an
      // earlier frame's (subscribe is itself acked).
      waitAck(from) { return waitFor(() => messages.slice(from).find(m => m.t === 'ack')); },
      wait(p) { return waitFor(() => messages.find(p)); },
    }));
  });
}

async function stdinLines() {
  try {
    return (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
const userLinesIn = (lines) => lines.filter(l => l.type === 'user' && l.message?.role === 'user');
const textsOf = (line) => line.message.content.filter(b => b.type === 'text').map(b => b.text);
const blockStop = (inst, index = 0) => inst._handleStdoutLine(JSON.stringify(
  { type: 'stream_event', event: { type: 'content_block_stop', index } }));

// A FLAGGED instance left mid-text-block, with a live subscribed WS client.
async function flaggedMidBlockOverWs() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'w' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'w', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  inst.backend = 'ollama';
  inst.model = FLAGGED_MODEL;
  inst._refreshModelCapabilities();
  assert.equal(inst.acceptsMidTurnSteering, false, 'the controlled opt-out row resolved');

  const c = await wsClient(wsUrl);
  openClients.push(c);
  c.send({ t: 'subscribe', id: inst.id });
  await c.wait(m => m.t === 'snapshot');
  c.send({ t: 'prompt', id: inst.id, text: 'open text' });
  await c.wait(m => m.t === 'event' && m.ev?.kind === 'text_delta');
  assert.equal(inst.status, 'turn', 'precondition: mid-turn with an OPEN text block');
  return { c, inst };
}

test('E-T1 a WS prompt frame into a flagged mid-turn instance defers to a post-stop turn', async () => {
  // Invariant: the frame writes nothing at frame time, arms exactly ONE
  // block-edge stop, and delivers the composer text as a fresh turn whose blocks
  // are exactly [POST_STOP_STEER_NOTE, text].
  const { c, inst } = await flaggedMidBlockOverWs();
  const TEXT = 'STEER FROM THE COMPOSER';
  const mark = c.messages.length;
  c.send({ t: 'prompt', id: inst.id, text: TEXT });
  await c.waitAck(mark);

  assert.equal(inst.steerPending, true, 'parked, not sent');
  let lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0, 'mid-block ⇒ nothing fired yet');
  assert.equal(userLinesIn(lines).length, 1, 'only the original prompt reached the CLI');
  assert.ok(!JSON.stringify(lines).includes(TEXT),
    'the composer text was NOT injected into the running turn');

  // The fixture's control:interrupt turn ends the aborted turn on its own, so the
  // steer flushes with no synthetic result injection.
  blockStop(inst);
  assert.equal(inst._interruptFired, true, 'the stop fired at the boundary');
  await waitFor(async () => userLinesIn(await stdinLines()).length === 2);

  lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
  assert.deepEqual(textsOf(userLinesIn(lines)[1]), [POST_STOP_STEER_NOTE, TEXT],
    'the note rides as its OWN leading block, then the verbatim composer text');
});

test('E-T2 the frame ack resolves while the steer is still parked, not at the block edge', async () => {
  // Invariant: `{t:'ack', ok:true}` arrives while the steer is parked and BEFORE
  // any boundary event. public/ws.js rejects a pending ack after 10s and
  // sendCardAnswer's onFail re-opens the card, so an ack that waited on the
  // unbounded block-edge stop would make every deferred card answer falsely
  // report failure.
  const { c, inst } = await flaggedMidBlockOverWs();
  const mark = c.messages.length;
  c.send({ t: 'prompt', id: inst.id, text: 'ACK ME NOW' });
  const ack = await c.waitAck(mark);
  assert.equal(ack.ok, true, 'the frame was acked');
  assert.equal(inst.steerPending, true, 'acked while the steer is STILL parked');
  assert.equal(inst._interruptFired, false, 'acked before any block edge landed');
  assert.ok(!JSON.stringify(await stdinLines()).includes('ACK ME NOW'),
    'and before the text reached the CLI');
});

test('E-T4 attachments survive the deferred path', async () => {
  // Invariant: a frame carrying one attachment lands on the POST-STOP turn with
  // its `Attached file:` line present. Without the attachments plumb-through into
  // PendingSteer the file is silently dropped.
  const { c, inst } = await flaggedMidBlockOverWs();
  const mark = c.messages.length;
  c.send({
    t: 'prompt', id: inst.id, text: 'look at this',
    attachments: [{ name: 'tiny.png', mediaType: 'image/png', dataBase64: PNG_1PX }],
  });
  await c.waitAck(mark);
  assert.equal(inst.steerPending, true);

  blockStop(inst);
  await waitFor(async () => userLinesIn(await stdinLines()).length === 2);

  const texts = textsOf(userLinesIn(await stdinLines())[1]);
  assert.deepEqual(texts.slice(0, 2), [POST_STOP_STEER_NOTE, 'look at this']);
  assert.ok(texts.some(t => /^Attached file: `.*tiny\.png`$/m.test(t)),
    `the attachment rode along on the post-stop turn; got ${JSON.stringify(texts)}`);
});
