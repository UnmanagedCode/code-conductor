// The owner's wake after a turn the HUMAN prompted: every turn-ending stub —
// folded, plain (delivered live into a mid-turn owner), INTERRUPTED and EXITED —
// opens its summary with a notice quoting the human's words. The heartbeat
// neither carries the notice nor uses it up. A conductor-started turn's stub is
// unchanged, and the human prompts are reported to the next wake only — each
// list belongs to the wake it travels with.
//
// See ./promptAuthorCase.mjs for the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitFor, instForSession, driveTurn } from './helpers.mjs';
import { setupIdleWake, callTool, findInterruptedStubFor } from './idleWakeCase.mjs';
import { parseWakeCallback, WAKE_BODY_SEP } from '../shared/wakeCallback.ts';
import {
  HUMAN_NOTICE_LEAD, createProject, spawnConductor, spawnWorker, spawnHand, wsPrompt, wakesFor,
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
// The (n+1)th completion wake about `w` in C's ring, once it lands.
const nthCompletion = (c, w, n) => waitFor(() => completions(c, w)[n]);
const summaryOf = (ev) => parseWakeCallback(ev.text).summary;

test('a human-prompted turn wakes the owner with the notice first, quoting the prompt', async () => {
  const { c, w } = await conducted();
  await driveTurn(instances, w, () => wsPrompt(w, 'please rename the module\nand keep the tests'));
  const wake = await nthCompletion(c, w, 0);
  const summary = summaryOf(wake);
  assert.ok(summary.startsWith(HUMAN_NOTICE_LEAD), `summary opens with the notice: ${summary}`);
  assert.ok(summary.includes('> please rename the module\n> and keep the tests'),
    `every quoted line is prefixed: ${summary}`);
  assert.ok(wake.text.includes(WAKE_BODY_SEP), 'still the folded stub');
  assert.ok(summary.includes(`Worker \`${w}\` finished its turn.`), 'the usual report follows the notice');
});

test('a conductor-started turn\'s stub is byte-identical to the plain report', async () => {
  const { c, w } = await conducted();
  await driveTurn(instances, w, () => callTool('send_prompt', { sessionId: w, text: 'conductor brief' }, { caller: c }));
  const wake = await nthCompletion(c, w, 0);
  assert.equal(summaryOf(wake),
    `Worker \`${w}\` finished its turn. Its recent output is folded in below (equivalent to a default `
    + `\`mcp__code-conductor__get_recent_messages({sessionId:"${w}"})\` call), so you do NOT need to `
    + 'call get_recent_messages again — read it and decide the next step.');
  assert.doesNotMatch(wake.text, /HUMAN/);
});

test('conductor, human, conductor turns: only the human turn\'s wake carries the notice', async () => {
  const { c, w, cInst } = await conducted();
  const steps = [
    () => callTool('send_prompt', { sessionId: w, text: 'brief one' }, { caller: c }),
    () => wsPrompt(w, 'human in the middle'),
    () => callTool('send_prompt', { sessionId: w, text: 'brief two' }, { caller: c }),
  ];
  for (const [i, step] of steps.entries()) {
    await driveTurn(instances, w, step);
    await nthCompletion(c, w, i);
    await waitFor(() => cInst.status === 'idle');
  }
  const noticed = completions(c, w).map(ev => summaryOf(ev).startsWith(HUMAN_NOTICE_LEAD));
  assert.deepEqual(noticed, [false, true, false]);
  assert.ok(summaryOf(completions(c, w)[1]).includes('> human in the middle'));
});

test('a human steer into a running conductor turn puts the notice on that turn\'s wake', async () => {
  const { c, w, wInst } = await conducted();
  await callTool('send_prompt', { sessionId: w, text: 'SLOWTURN conductor work' }, { caller: c });
  await waitFor(() => wInst.status === 'turn');
  await wsPrompt(w, 'ABSORB human correction');
  const summary = summaryOf(await nthCompletion(c, w, 0));
  assert.ok(summary.startsWith(HUMAN_NOTICE_LEAD), summary);
  assert.ok(summary.includes('> ABSORB human correction'), summary);
  assert.ok(!summary.includes('SLOWTURN conductor work'), 'the conductor\'s own brief is not quoted');
});

test('the plain stub delivered live into a mid-turn owner carries the notice', async () => {
  const { c, w, cInst } = await conducted();
  await callTool('send_prompt', { sessionId: c, text: 'CSLOW keep the conductor busy' });
  await waitFor(() => cInst.status === 'turn');
  await driveTurn(instances, w, () => wsPrompt(w, 'human while the conductor works'));
  const wake = await nthCompletion(c, w, 0);
  assert.ok(!wake.text.includes(WAKE_BODY_SEP), 'precondition: the plain (live) stub');
  assert.ok(summaryOf(wake).startsWith(HUMAN_NOTICE_LEAD), summaryOf(wake));
  assert.ok(summaryOf(wake).includes('> human while the conductor works'));
});

test('a heartbeat mid human turn carries no notice and leaves it for the final wake', async () => {
  const { c, w, wInst } = await conducted();
  await callTool('set_idle_timeout', { sessionId: w, timeoutSeconds: 1 }, { caller: c });
  await wsPrompt(w, 'LONGTURN human asks for a long job');
  await waitFor(() => wInst.status === 'turn');
  const beat = await waitFor(() => wakesFor(c, w).find(ev => ev.text.includes('did NOT finish')));
  assert.doesNotMatch(beat.text, /HUMAN/, 'the heartbeat carries no notice');
  const final = summaryOf(await nthCompletion(c, w, 0));
  assert.ok(final.startsWith(HUMAN_NOTICE_LEAD), `the final wake still has it: ${final}`);
  assert.ok(final.includes('> LONGTURN human asks for a long job'));
});

test('a force-interrupted human turn\'s INTERRUPTED stub carries the notice', async () => {
  const { c, w, wInst } = await conducted();
  await wsPrompt(w, 'OPENTURN human starts something');
  await waitFor(() => wInst.status === 'turn' && !wInst._quiescence.empty);
  await waitFor(() => instances.hasArmedWake(wInst.id));
  await wInst.interrupt({ force: true });
  const stub = await waitFor(() => findInterruptedStubFor(instForSession(instances, c), w));
  const summary = summaryOf(stub);
  assert.ok(summary.startsWith(HUMAN_NOTICE_LEAD), summary);
  assert.ok(summary.includes('> OPENTURN human starts something'));
  assert.match(summary, /was INTERRUPTED/);
});

test('a human turn whose CLI exits on its own: the EXITED stub carries the notice', async () => {
  const { c, w, wInst } = await conducted();
  await wsPrompt(w, 'OPENTURN human before the crash');
  await waitFor(() => wInst.status === 'turn' && !wInst._quiescence.empty);
  await waitFor(() => instances.hasArmedWake(wInst.id));
  wInst.proc.stderr.write('fatal: gone\n');
  await waitFor(() => wInst._stderr.includes('fatal: gone'));
  wInst.proc.kill('SIGKILL');
  const stub = await waitFor(() => wakesFor(c, w).find(ev => ev.text.includes('EXITED')));
  const summary = summaryOf(stub);
  assert.ok(summary.startsWith(HUMAN_NOTICE_LEAD), summary);
  assert.ok(summary.includes('> OPENTURN human before the crash'));
});

test('a hand-spawned session the conductor dispatched to gets no notice for a human prompt', async () => {
  await createProject('p');
  const c = await spawnConductor('p');
  const h = await spawnHand('p', stdinFile());
  await driveTurn(instances, h, () => callTool('send_prompt', { sessionId: h, text: 'dispatch to hand' }, { caller: c }));
  await nthCompletion(c, h, 0);
  await waitFor(() => instForSession(instances, c).status === 'idle');
  await driveTurn(instances, h, () => wsPrompt(h, 'human into the hand-spawned session'));
  const wake = await nthCompletion(c, h, 1);
  assert.doesNotMatch(wake.text, /HUMAN/, 'no authorship outside conducted workers');
});

// A conducted worker whose owner is gone: its turns arm no wake, so nothing will
// ever report its human prompts — the record must not outlive the turn.
async function orphaned() {
  const { c, w, cInst, wInst } = await conducted();
  await instances.remove(cInst.id);
  assert.equal(instances.byId.has(cInst.id), false, 'precondition: the owner is gone');
  assert.equal(instances.byId.has(wInst.id), true, 'precondition: the worker outlives it');
  return { c, w, wInst };
}

test('no armed wake: a human turn its CLI dies in keeps no human prompts', async () => {
  const { w, wInst } = await orphaned();
  // Non-temp, as a promoted conducted worker is: its exit leaves it listed, so
  // no purge clears the hub for it.
  wInst.temp = false;
  await wsPrompt(w, 'OPENTURN nobody is watching');
  await waitFor(() => wInst.status === 'turn' && !wInst._quiescence.empty);
  assert.equal(instances.hasArmedWake(wInst.id), false, 'precondition: nothing armed');
  wInst.proc.stderr.write('fatal: gone\n');
  await waitFor(() => wInst._stderr.includes('fatal: gone'));
  wInst.proc.kill('SIGKILL');
  await waitFor(() => wInst.status === 'crashed' || wInst.status === 'exited');
  assert.equal(instances.byId.has(wInst.id), true, 'precondition: the exited worker is still listed');
  assert.deepEqual(instances.pendingHumanPrompts(wInst.id), []);
});

test('no armed wake: a human turn a commanded stop interrupts keeps no human prompts', async () => {
  const { w, wInst } = await orphaned();
  await wsPrompt(w, 'OPENTURN nobody is watching');
  await waitFor(() => wInst.status === 'turn' && !wInst._quiescence.empty);
  assert.equal(instances.hasArmedWake(wInst.id), false, 'precondition: nothing armed');
  const ended = waitFor(() => wInst.ringSnapshot().some(e => e.kind === 'turn_end'));
  wInst.interruptTurnForStop();
  await ended;
  assert.equal(wInst._stopInterruptedTurn, true, 'precondition: the stop-interrupted turn_end');
  assert.deepEqual(instances.pendingHumanPrompts(wInst.id), []);
});
