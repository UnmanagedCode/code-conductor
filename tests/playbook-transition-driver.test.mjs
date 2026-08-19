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
import { pbs, proj, isLiveFromEvents, GATELAB_PB, GATELAB_RUN } from './playbook-fixtures.mjs';

// Driven through GATELAB (tests/playbook-fixtures.mjs), never the shipped
// playbooks/*.json: which edges exist and which carry an `on` is precisely what
// an owner hand-edits, and every case below reads one of those two facts.
// GATELAB gives all three shapes on one graph — `draft -> build` with an `on`
// driver, `build -> amend` with none, and `sealed` with no outgoing edge at all.
const PB = pbs(GATELAB_PB);
const graph = PB.get('gatelab');

function d(toolName, args, events) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB, isLive: isLiveFromEvents(events) });
}

const DRAFTER = [{ kind: 'spawn', sessionId: 'w-drafter-1', playbook: 'gatelab', stage: 'draft' }];

test('premise: gatelab declares draft->build with on:approve_plan and build->amend with no on', () => {
  const driven = graph.transitions.find(t => t.from === 'draft' && t.to === 'build');
  assert.equal(driven.on, 'approve_plan');
  const plain = graph.transitions.find(t => t.from === 'build' && t.to === 'amend');
  assert.equal(plain.on, undefined);
});

test('an edge with NO `on` is driven by send_prompt', () => {
  const res = d('send_prompt',
    { sessionId: 'w-drafter-1', text: 'address the audit', stage: 'amend', provenance: { audit: 'w-auditor-1' } },
    GATELAB_RUN);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'transition', from: 'build', to: 'amend', via: 'send_prompt' });
});

test('an edge with `on` CANNOT be driven by send_prompt, and the refusal names the driver', () => {
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'just build it', stage: 'build' }, DRAFTER);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TRANSITION_ILLEGAL');
  assert.match(res.reason, /has via:'approve_plan' — that tool drives it and nothing else can/);
  assert.match(res.reason, /so send_prompt cannot/);
  assert.match(res.reason, /Call approve_plan instead/);
  // the refusal still carries where the worker can legally go
  assert.deepEqual(res.legalMoves.transitions, [{ to: 'build', via: 'approve_plan' }]);
});

test('the `on` tool decides the transition it drives', () => {
  const res = d('approve_plan', { sessionId: 'w-drafter-1' }, DRAFTER);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'transition', from: 'draft', to: 'build', via: 'approve_plan' });
});

test('the `on` tool moves nothing when the worker is not at that edge\'s `from`', () => {
  // approve_plan drives draft->build only. A worker already in `build` calling
  // it is an ordinary governed call, not a second transition.
  const events = [
    ...DRAFTER,
    { kind: 'transition', sessionId: 'w-drafter-1', from: 'draft', to: 'build', via: 'approve_plan' },
  ];
  const res = d('approve_plan', { sessionId: 'w-drafter-1' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'none' });
});

test('a send_prompt to a stage with no edge at all is TRANSITION_ILLEGAL', () => {
  // draft -> audit is not an edge in either direction.
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'go audit', stage: 'audit' }, DRAFTER);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TRANSITION_ILLEGAL');
  assert.match(res.reason, /has no transition draft -> audit/);
});

test('absence of an edge is a refusal in BOTH directions unless both are declared', () => {
  // gatelab has build->amend but neither amend->audit nor amend->build: an edge
  // declared one way never implies the other.
  const events = [
    ...GATELAB_RUN,
    { kind: 'transition', sessionId: 'w-drafter-1', from: 'build', to: 'amend', via: 'send_prompt' },
  ];
  const back = d('send_prompt', { sessionId: 'w-drafter-1', text: 're-audit', stage: 'audit' }, events);
  assert.equal(back.ok, false);
  assert.equal(back.code, 'TRANSITION_ILLEGAL');
  // and amend -> build is likewise not declared, though build -> amend is
  const fwd = d('send_prompt', { sessionId: 'w-drafter-1', text: 'back to work', stage: 'build' }, events);
  assert.equal(fwd.ok, false);
  assert.equal(fwd.code, 'TRANSITION_ILLEGAL');
});

test('a stage with no outgoing edge cannot be moved by any tool, nor unlock itself', () => {
  assert.equal(graph.transitions.some(t => t.from === 'sealed'), false, 'premise: no edge out of sealed');
  const events = [{ kind: 'spawn', sessionId: 'w-sealed-01', playbook: 'gatelab', stage: 'sealed' }];
  // send_prompt cannot
  const viaPrompt = d('send_prompt', { sessionId: 'w-sealed-01', text: 'now hand off', stage: 'handoff' }, events);
  assert.equal(viaPrompt.code, 'TRANSITION_ILLEGAL');
  // approve_plan is DENIED outright here. It drives no edge out of `sealed`, but
  // merely not-moving-the-worker is not enough: the handler flips the instance to
  // bypassPermissions, the same write unlock `set_mode` is denied for. A stage
  // that must not write is only sealed with both doors shut.
  const viaApprove = d('approve_plan', { sessionId: 'w-sealed-01' }, events);
  assert.equal(viaApprove.code, 'TOOL_DENIED_IN_STAGE');
  // and set_mode is denied outright, closing the self-promotion route
  const viaSetMode = d('set_mode', { sessionId: 'w-sealed-01', mode: 'bypassPermissions' }, events);
  assert.equal(viaSetMode.code, 'TOOL_DENIED_IN_STAGE');
});

test('resolveMove classifies each driver case directly', () => {
  const from = (toolName, args, currentStage) => resolveMove({ toolName, args, playbook: graph, currentStage });
  assert.equal(from('approve_plan', {}, 'draft').kind, 'transition');
  assert.equal(from('approve_plan', {}, 'draft').resultingStage, 'build');
  assert.equal(from('send_prompt', { stage: 'build' }, 'draft').illegal.code, 'TRANSITION_ILLEGAL');
  assert.equal(from('send_prompt', { stage: 'amend' }, 'build').kind, 'transition');
  assert.equal(from('send_prompt', { stage: 'draft' }, 'draft').kind, 'self');
  // a governed tool that drives no edge leaves the worker where it is
  const still = from('get_transcript', {}, 'build');
  assert.equal(still.kind, 'none');
  assert.equal(still.resultingStage, 'build');
});
