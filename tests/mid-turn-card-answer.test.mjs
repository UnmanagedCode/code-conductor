// Regression tests for the bug where a UI card answer (AskUserQuestion /
// plan Approve-Reject) was parked in a browser-local Map instead of sent,
// because public/app.js's sendOrQueuePrompt only sent when the instance was
// idle and otherwise queued for the next `status:'idle'` WS frame.
//
// The gate assumed the `can_use_tool` deny leaves the instance idle before a
// human can click. It does not: the deny releases the tool call, but anything
// already queued in the CLI's stdin — in a conducted session, a wake callback
// from a finished worker — is injected right after and the SAME turn keeps
// running. Answers clicked in that window were withheld and then replayed as
// their own turn afterwards, out of order.
//
// The scenario fixture reproduces exactly that shape: the deny step emits the
// is_error tool_result but NO `result`, so the turn stays open, and `result` is
// emitted only in reaction to the answer prompt. A withheld answer therefore
// means the turn never ends — these tests time out rather than pass vacuously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, userStdinLines } from './helpers.mjs';
import { promises as fs } from 'node:fs';
import { MID_TURN_NOTE, POST_STOP_STEER_NOTE } from '../src/instances.ts';
import { isUserQuestionAnswerText } from '../public/userQuestionAnswers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-canusetool-question-continues.json');

const QUESTIONS = [{
  question: 'Pick a fruit',
  header: 'Fruit',
  multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }],
}];
// Exactly what public/app.js's onUserQuestionSubmit sends for an Apple pick
// (formatUserQuestionAnswers single-question short form).
const ANSWER_TEXT = 'Answer to "Pick a fruit": Apple';
// The wake callback IdleSubscriptionHub.deliver injects when a subscribed
// worker finishes — the thing that keeps the conductor's turn alive.
const WAKE_STUB = 'Worker `abc12345` finished its turn. Call get_recent_messages to inspect the result.';

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
      indexOf(p) { return messages.findIndex(p); },
    }));
  });
}

// Drive the shared sequence up to (but not including) the answer submit:
// prompt → question card → deny → wake callback injected → turn still running.
async function upToOpenQuestion(ctx, c) {
  c.send({ t: 'prompt', id: c.instanceId, text: 'go' });
  const uq = await c.wait(m => m.t === 'event' && m.ev.kind === 'user_question');
  assert.equal(uq.ev.questions[0].question, 'Pick a fruit');

  // The deny lands as an is_error tool_result for the AskUserQuestion tool_use.
  await c.wait(m => m.t === 'event' && m.ev.kind === 'tool_result'
    && m.ev.toolUseId === 'tu_q' && m.ev.isError === true);

  // A wake callback already queued in the CLI's stdin is injected right after
  // the deny — the real internal path, same options IdleSubscriptionHub uses.
  await ctx.instances.get(c.instanceId).prompt(WAKE_STUB, [], {
    internal: true, annotateIfMidTurn: false,
  });
  await c.wait(m => m.t === 'event' && m.ev.kind === 'text_delta'
    && m.ev.text?.includes('Handling the worker result'));
}

test('the can_use_tool deny does NOT leave the instance idle when a message is queued behind it', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let client = null;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = client = await wsClient(ctx.wsUrl);
    c.instanceId = id;
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    await upToOpenQuestion(ctx, c);

    // THE premise the deleted queue was built on, falsified. If this ever goes
    // back to 'idle' here, the gate's assumption held and the bug wasn't real.
    assert.equal(ctx.instances.get(id).status, 'turn',
      'turn must still be running after the deny + injected wake callback');

  } finally {
    if (client) { try { await client.close(); } catch { /* already gone */ } }
    await ctx.close();
  }
});

test('a card answer submitted mid-turn reaches the CLI BEFORE turn_end', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let client = null;
  try {
    const transcriptPath = path.join(ctx.tmpHome, 'transcript.log');
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = client = await wsClient(ctx.wsUrl);
    c.instanceId = id;
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    await upToOpenQuestion(ctx, c);
    assert.equal(ctx.instances.get(id).status, 'turn', 'precondition: still mid-turn');

    // The UI answer, in the exact shape public/app.js now sends it — no
    // status check, no extra fields beyond the composer's own payload.
    c.send({ t: 'prompt', id, text: ANSWER_TEXT });

    // Under the OLD gated client this send never happened, the fake never
    // emitted `result`, and this wait times out.
    const turnEnd = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turnEnd.ev.isError, false);

    // ORDERING INVARIANT: the answer is in the CLI's hands before the turn ends.
    const echoIdx = c.indexOf(m => m.t === 'event' && m.ev.kind === 'user_echo' && m.ev.text === ANSWER_TEXT);
    const endIdx = c.indexOf(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.ok(echoIdx >= 0, 'the answer produced a user_echo');
    assert.ok(echoIdx < endIdx,
      `answer echo (idx ${echoIdx}) must precede turn_end (idx ${endIdx})`);

    // ANNOTATION INVARIANT: two content blocks — MID_TURN_NOTE first, then the
    // user's text verbatim. Fails if a card answer is ever routed through
    // annotateIfMidTurn:false, or if the note is folded into the text.
    const lines = await userStdinLines(transcriptPath);
    const answerLine = lines.find(o =>
      JSON.stringify(o.message.content).includes('Answer to \\"Pick a fruit\\"'));
    assert.ok(answerLine, 'the answer was written to the CLI stdin');
    assert.deepEqual(
      answerLine.message.content,
      [{ type: 'text', text: MID_TURN_NOTE }, { type: 'text', text: ANSWER_TEXT }],
    );

    // E-T3 (card 2026-0183): the same frame on a model that CAN take a mid-turn
    // injection must still arm no stop at all. The interrupt count is what
    // distinguishes "routed live" from "routed unconditionally through the
    // block-edge stop"; the block shape above alone does not.
    const allLines = (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(
      allLines.filter(l => l.type === 'control_request' && l.request?.subtype === 'interrupt').length,
      0, 'an unflagged WS prompt frame arms NO control_request');

    // PAIRING INVARIANT: the note never reaches the text the UI pairs on, so
    // the answer still matches its card.
    const echo = c.messages[echoIdx].ev;
    assert.equal(echo.text, ANSWER_TEXT, 'user_echo carries the bare answer, unannotated');
    assert.equal(isUserQuestionAnswerText(QUESTIONS, echo.text), true,
      'the mid-turn answer still pairs back to its question card');

  } finally {
    // Close the socket HERE, not on the success path: a leaked client keeps handles
    // open, so ctx.close() never completes and a failed assertion reads as a
    // 60s file-level hang instead of a failure.
    if (client) { try { await client.close(); } catch { /* already gone */ } }
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});

// E-T5 (card 2026-0183 Part E) — the same card-answer frame on a model that
// CANNOT take a mid-turn injection. Invariant: it is parked behind exactly one
// block-edge stop, delivered as a fresh turn carrying POST_STOP_STEER_NOTE, and
// the answered turn still reaches a non-error turn_end.
//
// The fixture emits `result` only in reaction to a prompt containing "Answer to",
// so a dropped answer HANGS this test rather than passing green — the strongest
// non-vacuity guarantee available in this suite.
test('a card answer on a model that cannot take a mid-turn injection is deferred, delivered, and still ends the turn', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  let client = null;
  try {
    const transcriptPath = path.join(ctx.tmpHome, 'flagged-card.log');
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.backend = 'ollama';
    inst.model = 'deepseek-v4-flash:0731-cloud';
    inst._refreshModelCapabilities();
    assert.equal(inst.acceptsMidTurnSteering, false, 'the flagged preset resolved');

    const c = client = await wsClient(ctx.wsUrl);
    c.instanceId = id;
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    await upToOpenQuestion(ctx, c);
    assert.equal(inst.status, 'turn', 'precondition: still mid-turn');

    const readLines = async () => (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const users = (ls) => ls.filter(l => l.type === 'user' && l.message?.role === 'user');
    const before = users(await readLines()).length;

    c.send({ t: 'prompt', id, text: ANSWER_TEXT });

    // The wake stub's block is already closed, so the whole sequence — arm, fire,
    // abort, flush, answer — completes without any synthetic boundary event. The
    // parked window is therefore too short to observe, so the deferral is asserted
    // from its RESULT: a block-edge stop was armed and fired. Bounded and asserted
    // FIRST so reverting the routing fails here, fast and legibly, rather than
    // wedging on the fixture's withheld `result`.
    await waitFor(async () => (await readLines()).some(
      l => l.type === 'control_request' && l.request?.subtype === 'interrupt'),
      { timeout: 4000 });

    const turnEnd = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end' && m.ev.isError === false);
    assert.ok(turnEnd, 'the answered turn reached a non-error turn_end');

    const lines = await readLines();
    assert.equal(
      lines.filter(l => l.type === 'control_request' && l.request?.subtype === 'interrupt').length,
      1, 'exactly one block-edge stop');
    const us = users(lines);
    assert.equal(us.length, before + 1, 'the answer went out exactly once');
    assert.deepEqual(
      us[us.length - 1].message.content.filter(b => b.type === 'text').map(b => b.text),
      [POST_STOP_STEER_NOTE, ANSWER_TEXT],
      'delivered as a fresh turn carrying the post-stop note');

  } finally {
    // Close the socket HERE, not on the success path: a leaked client keeps handles
    // open, so ctx.close() never completes and a failed assertion reads as a
    // 60s file-level hang instead of a failure.
    if (client) { try { await client.close(); } catch { /* already gone */ } }
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});
