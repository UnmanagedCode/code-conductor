// Authorship across a mid-turn steer and a coalesced delivery. A steer carries
// its own sender's author. A coalesced send — parked steers flushed after a
// block-edge stop, or the overage queue's combined resume — is ONE CLI line and
// carries ONE marker: human if any part is the human's, else conductor if any
// part is the conductor's.
//
// See ./promptAuthorCase.mjs for the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitFor, instForSession } from './helpers.mjs';
import { setupIdleWake, callTool, unwrap } from './idleWakeCase.mjs';
import { addCustomModel } from '../src/appSettings.ts';
import { POST_STOP_STEER_NOTE } from '../src/instances.ts';
import {
  HUMAN_MARK, CONDUCTOR_MARK, createProject, spawnConductor, spawnWorker,
  wsPrompt, stdinUserLines, textBlocks, lastText, lineWith, echoWith,
} from './promptAuthorCase.mjs';

let instances;
setupIdleWake(c => { ({ instances } = c); });
let seq = 0;
const stdinFile = () => path.join(process.env.PROJECTS_ROOT, '..', `stdin-${++seq}.jsonl`);

async function conducted() {
  await createProject('p');
  const c = await spawnConductor('p');
  const wFile = stdinFile();
  const w = await spawnWorker('p', c, wFile);
  return { c, w, wFile, wInst: instForSession(instances, w) };
}

test('a human WS steer into a running conductor turn is written human', async () => {
  const { c, w, wFile, wInst } = await conducted();
  await callTool('send_prompt', { sessionId: w, text: 'SLOWTURN from the conductor' }, { caller: c });
  await waitFor(() => wInst.status === 'turn');
  await wsPrompt(w, 'ABSORB the human steers');
  assert.equal(wInst.status, 'turn', 'precondition: the steer landed mid-turn');
  assert.equal(echoWith(w, 'ABSORB the human steers').author, 'human');
  assert.equal(echoWith(w, 'SLOWTURN from the conductor').author, 'conductor', 'the turn it joined keeps its own author');
  const line = await waitFor(async () => lineWith(await stdinUserLines(wFile), 'ABSORB the human steers'));
  assert.equal(lastText(line), HUMAN_MARK);
});

// A worker on a model that cannot take a mid-turn injection, parked mid-text-block
// on an open turn, so every send parks until the block-edge stop.
const FLAGGED_MODEL = 'cc-test-author-steer-optout:cloud';
async function flaggedOpenTurn() {
  const fx = await conducted();
  await addCustomModel({ label: 'Author steer opt-out (test)', model: FLAGGED_MODEL, backend: 'ollama',
    contextWindow: 256_000, midTurnSteering: false });
  fx.wInst.backend = 'ollama';
  fx.wInst.model = FLAGGED_MODEL;
  fx.wInst._refreshModelCapabilities();
  assert.equal(fx.wInst.acceptsMidTurnSteering, false, 'precondition: flagged');
  await callTool('send_prompt', { sessionId: fx.w, text: 'OPENTURN' }, { caller: fx.c });
  await waitFor(() => fx.wInst.status === 'turn' && !fx.wInst._quiescence.empty);
  return fx;
}
const blockStop = (inst) => inst._handleStdoutLine(JSON.stringify(
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));

// The ONE line the parked steers flushed as.
async function flushedLine(fx) {
  assert.equal(fx.wInst.steerPending, true, 'precondition: steers parked');
  blockStop(fx.wInst);
  return waitFor(async () => (await stdinUserLines(fx.wFile)).find(l => textBlocks(l)[0] === POST_STOP_STEER_NOTE));
}

test('parked steers from the conductor and the human flush as one line written human', async () => {
  const fx = await flaggedOpenTurn();
  await callTool('send_prompt', { sessionId: fx.w, text: 'conductor parked steer' }, { caller: fx.c });
  await wsPrompt(fx.w, 'human parked steer');
  const line = await flushedLine(fx);
  assert.ok(textBlocks(line).some(t => t.includes('conductor parked steer') && t.includes('human parked steer')),
    'both steers rode one line');
  assert.equal(lastText(line), HUMAN_MARK);
  assert.equal(echoWith(fx.w, 'human parked steer').author, 'human');
});

test('parked steers from the conductor alone flush as one line written conductor', async () => {
  const fx = await flaggedOpenTurn();
  await callTool('send_prompt', { sessionId: fx.w, text: 'first parked brief' }, { caller: fx.c });
  await callTool('send_prompt', { sessionId: fx.w, text: 'second parked brief' }, { caller: fx.c });
  const line = await flushedLine(fx);
  assert.equal(lastText(line), CONDUCTOR_MARK);
  assert.equal(echoWith(fx.w, 'second parked brief').author, 'conductor');
});

test('the overage queue\'s combined resume is written human when the human queued a part', async () => {
  const { c, w, wFile, wInst } = await conducted();
  const realGate = wInst._overageGate;
  wInst._overageGate = () => ({ active: true, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
  try {
    const sent = unwrap(await callTool('send_prompt', { sessionId: w, text: 'queued conductor brief' }, { caller: c }));
    assert.notEqual(sent.ok, false, JSON.stringify(sent));
    await wsPrompt(w, 'queued human words');
    assert.equal(wInst._overageQueue.length, 2, 'precondition: both sends queued');
  } finally {
    wInst._overageGate = realGate;
  }
  instances._overageResume.run(wInst, wInst.id);
  const line = await waitFor(async () => lineWith(await stdinUserLines(wFile), 'queued human words'));
  assert.ok(textBlocks(line).some(t => t.includes('queued conductor brief')), 'one combined line');
  assert.equal(lastText(line), HUMAN_MARK);
  assert.equal(echoWith(w, 'queued human words').author, 'human');
});
