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
