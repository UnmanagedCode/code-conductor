// Self-edges: send_prompt where `stage` equals the worker's CURRENT stage.
//
// Load-bearing rule. send_prompt ALWAYS carries `stage`, so every ordinary
// follow-up prompt to a worker is a self-edge. If a self-edge were checked
// against the edge set, or re-ran the stage's `needs`, then simply talking to a
// worker twice would be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveMove } from '../src/playbooks.ts';
import { pb, pbs, proj, builtins, CLASSIC_RUN } from './playbook-fixtures.mjs';

const PB = await builtins();

function d(toolName, args, events) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB });
}

test('a self-edge is allowed even though no self-transition is declared', () => {
  // classic declares no plan->plan edge; an ordinary follow-up prompt must work.
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  assert.equal(PB.get('classic').transitions.some(t => t.from === t.to), false,
    'premise: classic declares no self-transition');
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'also handle X', stage: 'plan' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
});

test('a self-edge reports kind:"self" — so it is never ledgered as a transition', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'more', stage: 'plan' }, events);
  assert.deepEqual(res.move, { kind: 'self' });
  assert.notEqual(res.move.kind, 'transition');
  // resolveMove agrees: resulting === current, no edge consulted.
  const moved = resolveMove({
    toolName: 'send_prompt', args: { stage: 'plan' }, playbook: PB.get('classic'), currentStage: 'plan',
  });
  assert.deepEqual(moved, { currentStage: 'plan', resultingStage: 'plan', kind: 'self' });
});

test('a self-edge does NOT re-run the stage\'s needs', () => {
  // The worker is in `refine`, whose needs are {review, at:"current"}. Its
  // reviewer has been retired, so the needs are NOT currently satisfiable —
  // an ordinary follow-up prompt must still go through.
  const events = [
    ...CLASSIC_RUN,
    { kind: 'transition', sessionId: 'w-planner-1', from: 'implement', to: 'refine', via: 'send_prompt',
      needs: { review: 'w-review-01' } },
    { kind: 'retire', sessionId: 'w-review-01', reason: 'review done' },
  ];
  assert.deepEqual(PB.get('classic').stages.refine.needs, [{ stage: 'review', at: 'current' }],
    'premise: refine needs a worker currently in review');
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'address comment 3', stage: 'refine' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.equal(res.move.kind, 'self');
  // Re-ENTERING refine from implement with the same broken needs IS refused —
  // proving the exemption is specific to the self-edge, not a blanket skip.
  const reentry = d('send_prompt', { sessionId: 'w-planner-2', text: 'go', stage: 'refine' }, [
    ...events,
    { kind: 'spawn', sessionId: 'w-planner-2', playbook: 'classic', stage: 'plan' },
    { kind: 'transition', sessionId: 'w-planner-2', from: 'plan', to: 'implement', via: 'approve_plan' },
  ]);
  assert.equal(reentry.ok, false);
  assert.equal(reentry.code, 'NEEDS_UNSATISFIED');
});

test('a self-edge still honours the current stage\'s tools deny', () => {
  const locked = pb({
    id: 'locked', name: 'Locked', description: 'no talking', entryStages: ['a'],
    stages: { a: { tools: { spawn_instance: 'allow', send_prompt: 'deny' } } },
    transitions: [],
  });
  const res = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-locked-1', text: 'hi', stage: 'a' },
    projection: proj([{ kind: 'spawn', sessionId: 'w-locked-1', playbook: 'locked', stage: 'a' }]),
    playbooks: pbs(locked),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TOOL_DENIED_IN_STAGE');
});

test('a self-edge still honours the current stage\'s `require` (resulting stage IS current)', () => {
  const pinned = pb({
    id: 'pinned', name: 'Pinned', description: 'pinned args', entryStages: ['a'],
    stages: { a: { tools: { spawn_instance: 'allow', send_prompt: { require: { wait: false } } } } },
    transitions: [],
  });
  const projection = proj([{ kind: 'spawn', sessionId: 'w-pinned-1', playbook: 'pinned', stage: 'a' }]);
  // omitted -> filled in
  const filled = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a' },
    projection, playbooks: pbs(pinned),
  });
  assert.equal(filled.ok, true);
  assert.equal(filled.patchedArgs.wait, false);
  assert.equal(filled.move.kind, 'self');
  // contradicted -> refused, even on a self-edge
  const conflict = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a', wait: true },
    projection, playbooks: pbs(pinned),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'ARG_REQUIRE_CONFLICT');
});

test('a send_prompt naming a stage that does not exist is STAGE_UNKNOWN, not a self-edge', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'hi', stage: 'paln' }, events);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STAGE_UNKNOWN');
  assert.match(res.reason, /'paln' is not a stage of playbook 'classic'/);
});
