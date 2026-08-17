// What DRIVES a transition.
//
// An edge with no `on` is driven by send_prompt (which always carries `stage`).
// An edge with `on: "<tool>"` is driven by that tool AND THAT TOOL ONLY, so
// send_prompt cannot sneak a worker past e.g. plan approval.
//
// Scope note: this file pins the DECISION half — that `approve_plan` on a
// `plan` worker decides a transition to `implement`, and that send_prompt cannot
// produce the same move. Actually FIRING the transition on handler success (and
// appending it to the ledger) is the dispatch() wiring, a separate milestone;
// there is nothing to auto-fire from inside a pure function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveMove } from '../src/playbooks.ts';
import { proj, builtins, SOLO_RUN, isLiveFromEvents } from './playbook-fixtures.mjs';

const PB = await builtins();
const solo = PB.get('solo');

function d(toolName, args, events) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB, isLive: isLiveFromEvents(events) });
}

const PLANNER = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];

test('premise: solo declares plan->implement with on:approve_plan and implement->refine with no on', () => {
  const approve = solo.transitions.find(t => t.from === 'plan' && t.to === 'implement');
  assert.equal(approve.on, 'approve_plan');
  const refine = solo.transitions.find(t => t.from === 'implement' && t.to === 'refine');
  assert.equal(refine.on, undefined);
});

test('an edge with NO `on` is driven by send_prompt', () => {
  const res = d('send_prompt',
    { sessionId: 'w-planner-1', text: 'address the review', stage: 'refine', provenance: { review: 'w-review-01' } },
    SOLO_RUN);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'transition', from: 'implement', to: 'refine', via: 'send_prompt' });
});

test('an edge with `on` CANNOT be driven by send_prompt, and the refusal names the driver', () => {
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'just implement it', stage: 'implement' }, PLANNER);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TRANSITION_ILLEGAL');
  assert.match(res.reason, /has via:'approve_plan' — that tool drives it and nothing else can/);
  assert.match(res.reason, /so send_prompt cannot/);
  assert.match(res.reason, /Call approve_plan instead/);
  // the refusal still carries where the worker can legally go
  assert.deepEqual(res.legalMoves.transitions, [{ to: 'implement', via: 'approve_plan' }]);
});

test('the `on` tool decides the transition it drives', () => {
  const res = d('approve_plan', { sessionId: 'w-planner-1' }, PLANNER);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'transition', from: 'plan', to: 'implement', via: 'approve_plan' });
});

test('the `on` tool moves nothing when the worker is not at that edge\'s `from`', () => {
  // approve_plan drives plan->implement only. A worker already in `implement`
  // calling it is an ordinary governed call, not a second transition.
  const events = [
    ...PLANNER,
    { kind: 'transition', sessionId: 'w-planner-1', from: 'plan', to: 'implement', via: 'approve_plan' },
  ];
  const res = d('approve_plan', { sessionId: 'w-planner-1' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'none' });
});

test('a send_prompt to a stage with no edge at all is TRANSITION_ILLEGAL', () => {
  // plan -> review is not an edge in either direction.
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'go review', stage: 'review' }, PLANNER);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TRANSITION_ILLEGAL');
  assert.match(res.reason, /has no transition plan -> review/);
});

test('absence of an edge is a refusal in BOTH directions unless both are declared', () => {
  // solo has implement->refine but deliberately NOT refine->review: the same
  // reviewer is re-prompted, the implementer never becomes a reviewer.
  const events = [
    ...SOLO_RUN,
    { kind: 'transition', sessionId: 'w-planner-1', from: 'implement', to: 'refine', via: 'send_prompt' },
  ];
  const back = d('send_prompt', { sessionId: 'w-planner-1', text: 're-review', stage: 'review' }, events);
  assert.equal(back.ok, false);
  assert.equal(back.code, 'TRANSITION_ILLEGAL');
  // and refine -> implement is likewise not declared
  const fwd = d('send_prompt', { sessionId: 'w-planner-1', text: 'back to work', stage: 'implement' }, events);
  assert.equal(fwd.ok, false);
  assert.equal(fwd.code, 'TRANSITION_ILLEGAL');
});

test('relay: the planner has no outgoing edge, so no tool can move it to implement', () => {
  const relay = PB.get('relay');
  assert.equal(relay.transitions.some(t => t.from === 'plan'), false, 'premise: no edge out of plan');
  const events = [{ kind: 'spawn', sessionId: 'w-splitpl-1', playbook: 'relay', stage: 'plan' }];
  // send_prompt cannot
  const viaPrompt = d('send_prompt', { sessionId: 'w-splitpl-1', text: 'now implement', stage: 'implement' }, events);
  assert.equal(viaPrompt.code, 'TRANSITION_ILLEGAL');
  // approve_plan is DENIED outright in relay.plan. It never drove an edge here,
  // but merely not-moving-the-worker was not enough: the handler flips the
  // instance to bypassPermissions, which is the same write unlock `set_mode`
  // is denied for. The premise "this planner never writes code" is only true
  // with both doors shut.
  const viaApprove = d('approve_plan', { sessionId: 'w-splitpl-1' }, events);
  assert.equal(viaApprove.code, 'TOOL_DENIED_IN_STAGE');
  // and set_mode is denied outright, closing the self-promotion route
  const viaSetMode = d('set_mode', { sessionId: 'w-splitpl-1', mode: 'bypassPermissions' }, events);
  assert.equal(viaSetMode.code, 'TOOL_DENIED_IN_STAGE');
});

test('resolveMove classifies each driver case directly', () => {
  const from = (toolName, args, currentStage) => resolveMove({ toolName, args, playbook: solo, currentStage });
  assert.equal(from('approve_plan', {}, 'plan').kind, 'transition');
  assert.equal(from('approve_plan', {}, 'plan').resultingStage, 'implement');
  assert.equal(from('send_prompt', { stage: 'implement' }, 'plan').illegal.code, 'TRANSITION_ILLEGAL');
  assert.equal(from('send_prompt', { stage: 'refine' }, 'implement').kind, 'transition');
  assert.equal(from('send_prompt', { stage: 'plan' }, 'plan').kind, 'self');
  // a governed tool that drives no edge leaves the worker where it is
  const still = from('get_transcript', {}, 'implement');
  assert.equal(still.kind, 'none');
  assert.equal(still.resultingStage, 'implement');
});
