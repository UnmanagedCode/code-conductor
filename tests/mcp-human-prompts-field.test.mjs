// The send-time `humanPrompts` field: a conductor send into a conducted worker the
// human has prompted since the conductor's last wake is told so in the tool
// result. The field is a PEEK — the wake still carries the notice — and is
// absent (no key) whenever that pending list is empty.
//
// See ./promptAuthorCase.mjs for the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitFor, instForSession, driveTurn } from './helpers.mjs';
import { setupIdleWake, callTool, unwrap } from './idleWakeCase.mjs';
import { HUMAN_PROMPT_QUOTE_MAX_CHARS, quoteHumanPrompts } from '../src/promptAuthor.ts';
import {
  HUMAN_NOTICE_LEAD, createProject, spawnConductor, spawnWorker, wsPrompt, wakesFor,
} from './promptAuthorCase.mjs';

let instances;
setupIdleWake(c => { ({ instances } = c); });
let seq = 0;
const stdinFile = () => path.join(process.env.PROJECTS_ROOT, '..', `stdin-${++seq}.jsonl`);

async function conducted() {
  await createProject('p');
  const c = await spawnConductor('p');
  const w = await spawnWorker('p', c, stdinFile());
  return { c, w, cInst: instForSession(instances, c), wInst: instForSession(instances, w) };
}

const completions = (c, w) => wakesFor(c, w).filter(ev => !ev.text.includes('did NOT finish'));

test('send_prompt into a turn the human started returns humanPrompts, and the wake still carries the notice', async () => {
  const { c, w, wInst } = await conducted();
  await wsPrompt(w, 'SLOWTURN human asks for X');
  await waitFor(() => wInst.status === 'turn');
  const res = unwrap(await callTool('send_prompt', { sessionId: w, text: 'ABSORB conductor follow-up' }, { caller: c }));
  assert.deepEqual(res.humanPrompts, ['SLOWTURN human asks for X']);
  const wake = await waitFor(() => completions(c, w)[0]);
  assert.ok(wake.text.includes(HUMAN_NOTICE_LEAD), 'the peek left the wake its notice');
});

test('no humanPrompts key once the wake has been delivered, nor on a worker only the conductor prompted', async () => {
  const { c, w, cInst } = await conducted();
  await driveTurn(instances, w, () => wsPrompt(w, 'human turn'));
  await waitFor(() => completions(c, w)[0]);
  await waitFor(() => cInst.status === 'idle');
  const afterWake = unwrap(await driveTurn(instances, w,
    () => callTool('send_prompt', { sessionId: w, text: 'conductor next' }, { caller: c })));
  assert.equal('humanPrompts' in afterWake, false, `delivered wake took the list: ${JSON.stringify(afterWake)}`);
  await waitFor(() => completions(c, w)[1]);
  const conductorOnly = unwrap(await callTool('send_prompt', { sessionId: w, text: 'conductor again' }, { caller: c }));
  assert.equal('humanPrompts' in conductorOnly, false);
});

// The other three conductor sends, each into a turn the human started while a
// question is pending (answer_question needs one; the plan tools need none).
const ANSWER_SENDS = [
  ['answer_question', (c, w) => callTool('answer_question', { sessionId: w, answers: [{ option: 'Apple' }] }, { caller: c })],
  ['approve_plan', (c, w) => callTool('approve_plan', { sessionId: w }, { caller: c })],
  ['reject_plan', (c, w) => callTool('reject_plan', { sessionId: w, feedback: 'ABSORB tighter' }, { caller: c })],
];
for (const [name, send] of ANSWER_SENDS) {
  test(`${name} into a human-prompted turn returns humanPrompts`, async () => {
    const { c, w, wInst, cInst } = await conducted();
    await driveTurn(instances, w, () => callTool('send_prompt', { sessionId: w, text: 'ASKTURN' }, { caller: c }));
    await waitFor(() => completions(c, w)[0]);
    await waitFor(() => cInst.status === 'idle');
    await wsPrompt(w, 'SLOWTURN human weighs in');
    await waitFor(() => wInst.status === 'turn');
    const res = unwrap(await send(c, w));
    assert.notEqual(res.ok, false, JSON.stringify(res));
    assert.deepEqual(res.humanPrompts, ['SLOWTURN human weighs in']);
  });
}

test('a wake held for a mid-turn owner on a non-steerable model still feeds humanPrompts', async () => {
  const { c, w, cInst } = await conducted();
  // The owner's model cannot take a mid-turn injection: a wake reaching it
  // mid-turn is held (IdleSubscriptionHub._deferredWakes) until its own turn_end.
  await callTool('send_prompt', { sessionId: c, text: 'COPEN the conductor stays busy' });
  await waitFor(() => cInst.status === 'turn' && !cInst._quiescence.empty);
  cInst.acceptsMidTurnSteering = false; // after the model report that re-resolves it
  await driveTurn(instances, w, () => wsPrompt(w, 'human while the owner is busy'));
  await waitFor(() => instances._idleHub._deferredWakes.get(cInst.id)?.length === 1);
  assert.equal(cInst.status, 'turn', 'precondition: the owner is still mid-turn');
  const res = unwrap(await callTool('send_prompt', { sessionId: w, text: 'conductor follow-up' }, { caller: c }));
  assert.deepEqual(res.humanPrompts, ['human while the owner is busy']);
});

test('humanPrompts carries the quoted form: a long prompt is cut with its missing-length suffix', async () => {
  const { c, w, wInst } = await conducted();
  const raw = `SLOWTURN ${'x'.repeat(HUMAN_PROMPT_QUOTE_MAX_CHARS + 40)}`;
  await wsPrompt(w, raw);
  await waitFor(() => wInst.status === 'turn');
  const res = unwrap(await callTool('send_prompt', { sessionId: w, text: 'ABSORB conductor follow-up' }, { caller: c }));
  assert.equal(res.humanPrompts.length, 1);
  const [entry] = res.humanPrompts;
  assert.ok(entry.startsWith(raw.slice(0, HUMAN_PROMPT_QUOTE_MAX_CHARS)), entry);
  assert.ok(entry.endsWith(`[+${raw.length - HUMAN_PROMPT_QUOTE_MAX_CHARS} chars — get_transcript has it in full]`), entry);
});

// Hold C's next wake about W: C is mid-turn on a model that cannot take a
// mid-turn injection (see the held-wake case above).
async function holdWakesFor(cInst) {
  await callTool('send_prompt', { sessionId: cInst.sessionId, text: 'COPEN the conductor stays busy' });
  await waitFor(() => cInst.status === 'turn' && !cInst._quiescence.empty);
  cInst.acceptsMidTurnSteering = false;
}

test('a wake held for ANOTHER conductor is not reported to the sender', async () => {
  const { c, w, cInst, wInst } = await conducted();
  const c2 = await spawnConductor('p');
  const c2Inst = instForSession(instances, c2);
  // C2 dispatches to W, so W's turns owe a wake to both conductors.
  await driveTurn(instances, w, () => callTool('send_prompt', { sessionId: w, text: 'brief from C2' }, { caller: c2 }));
  await waitFor(() => completions(c, w)[0] && completions(c2, w)[0]);
  await waitFor(() => cInst.status === 'idle' && c2Inst.status === 'idle');
  await holdWakesFor(cInst);
  await driveTurn(instances, w, () => wsPrompt(w, 'human words held for C'));
  await waitFor(() => instances._idleHub._deferredWakes.get(cInst.id)?.length === 1);
  assert.deepEqual(instances._idleHub._deferredWakes.get(cInst.id)[0].opts.humanPrompts, ['human words held for C'],
    'precondition: C\'s held wake carries the human prompt');
  await waitFor(() => completions(c2, w)[1]);
  assert.equal(wInst.status, 'idle');
  const res = unwrap(await callTool('send_prompt', { sessionId: w, text: 'C2 follows up' }, { caller: c2 }));
  assert.notEqual(res.ok, false, JSON.stringify(res));
  assert.equal('humanPrompts' in res, false, `C's held prompts leaked to C2: ${JSON.stringify(res)}`);
});

test('held-wake prompts come before pending ones, oldest first', async () => {
  const { c, w, cInst, wInst } = await conducted();
  await holdWakesFor(cInst);
  await driveTurn(instances, w, () => wsPrompt(w, 'human A, held'));
  await waitFor(() => instances._idleHub._deferredWakes.get(cInst.id)?.length === 1);
  await wsPrompt(w, 'SLOWTURN human B, pending');
  await waitFor(() => wInst.status === 'turn');
  assert.equal(cInst.status, 'turn', 'precondition: the wake about A is still held');
  const res = unwrap(await callTool('send_prompt', { sessionId: w, text: 'ABSORB conductor follow-up' }, { caller: c }));
  assert.deepEqual(res.humanPrompts, quoteHumanPrompts(['human A, held', 'SLOWTURN human B, pending']));
});
