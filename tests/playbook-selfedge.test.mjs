// Self-edges: send_prompt where `stage` equals the worker's CURRENT stage.
//
// Load-bearing rule. send_prompt ALWAYS carries `stage`, so every ordinary
// follow-up prompt to a worker is a self-edge. If a self-edge were checked
// against the edge set, or re-ran the stage's `needs`, then simply talking to a
// worker twice would be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveMove } from '../src/playbooks.ts';
import { pb, pbs, proj, builtins, SOLO_RUN, isLiveFromEvents } from './playbook-fixtures.mjs';

const PB = await builtins();

function d(toolName, args, events) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB, isLive: isLiveFromEvents(events) });
}

test('a self-edge is allowed even though no self-transition is declared', () => {
  // solo declares no plan->plan edge; an ordinary follow-up prompt must work.
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];
  assert.equal(PB.get('solo').transitions.some(t => t.from === 'plan' && t.to === 'plan'), false,
    'premise: solo declares no plan->plan self-loop');
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'also handle X', stage: 'plan' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
});

// ── recorded vs unrecorded, the two branches ────────────────────────────────
//
// Declaring a self-loop changes exactly one thing: the move is ledgered. Both
// halves are asserted against the SAME playbook, so a mutant that records every
// self-edge fails the second half and one that records none fails the first.
// Either mutant survives a one-sided test, which is why this is not one.

test('a DECLARED self-loop reports recorded:true; an undeclared one does not', () => {
  const solo = PB.get('solo');
  assert.equal(solo.transitions.some(t => t.from === 'refine' && t.to === 'refine'), true,
    'premise: solo declares refine->refine');
  assert.equal(solo.transitions.some(t => t.from === 'plan' && t.to === 'plan'), false,
    'premise: solo declares no plan->plan');

  const declared = resolveMove({
    toolName: 'send_prompt', args: { stage: 'refine' }, playbook: solo, currentStage: 'refine',
  });
  assert.deepEqual(declared,
    { currentStage: 'refine', resultingStage: 'refine', kind: 'self', recorded: true });

  const undeclared = resolveMove({
    toolName: 'send_prompt', args: { stage: 'plan' }, playbook: solo, currentStage: 'plan',
  });
  assert.deepEqual(undeclared, { currentStage: 'plan', resultingStage: 'plan', kind: 'self' });
});

test('decide() carries the self-loop through as a from===to move the gate can ledger', () => {
  // The gate writes from `move`, so `recorded` alone is not enough: the move has
  // to carry the endpoints too, or commitMove has nothing to append.
  const events = [
    ...SOLO_RUN,
    { kind: 'transition', sessionId: 'w-planner-1', from: 'implement', to: 'refine', via: 'send_prompt',
      provenance: { review: 'w-review-01' } },
  ];
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'round 2', stage: 'refine' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move,
    { kind: 'self', from: 'refine', to: 'refine', via: 'send_prompt', recorded: true });
  // Still a self-edge, NOT a transition — legality never went through the edge
  // set, which is what keeps the follow-up prompt unconditional.
  assert.equal(res.move.kind, 'self');

  // …and the undeclared branch stays a bare self with nothing to write.
  const plain = d('send_prompt', { sessionId: 'w-planner-1', text: 'more', stage: 'plan' },
    [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }]);
  assert.deepEqual(plain.move, { kind: 'self' });
});

test('a DECLARED self-loop still skips needs and capacity', () => {
  // The gating question, held apart from the recording question. `hold` declares
  // an unsatisfiable need AND workers:"one" with its slot already taken, so if a
  // declared self-loop were routed through the transition branch this call would
  // be refused twice over. It must be allowed.
  const loop = pb({
    id: 'loop', name: 'Loop', description: 'a stage that talks to itself', entryStages: ['root'],
    stages: {
      root: { tools: { spawn_instance: 'allow' } },
      hold: { needs: [{ stage: 'root' }], tools: { spawn_instance: 'allow' } },
    },
    transitions: [{ from: 'root', to: 'hold' }, { from: 'hold', to: 'hold' }],
  });
  const events = [
    { kind: 'spawn', sessionId: 'w-loop-root', playbook: 'loop', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-loop-hold', playbook: 'loop', stage: 'hold', provenance: { root: 'w-loop-root' } },
    // The need is now unsatisfiable: `hold` requires a LIVE worker in `root`.
    { kind: 'retire', sessionId: 'w-loop-root', reason: 'gone' },
  ];
  const res = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-loop-hold', text: 'again', stage: 'hold' },
    projection: proj(events), playbooks: pbs(loop), isLive: isLiveFromEvents(events),
  });
  assert.equal(res.ok, true, `a declared self-loop must not be gated; got ${res.code}: ${res.reason}`);
  assert.equal(res.move.recorded, true);
  // Proof the need really is unsatisfiable — otherwise the case above is vacuous.
  const enteringEvents = [...events,
    { kind: 'spawn', sessionId: 'w-loop-2nd', playbook: 'loop', stage: 'root', provenance: { root: 'w-loop-root' } }];
  const entering = decide({
    toolName: 'send_prompt',
    args: { sessionId: 'w-loop-2nd', text: 'in', stage: 'hold', provenance: { root: 'w-loop-root' } },
    projection: proj(enteringEvents),
    playbooks: pbs(loop), isLive: isLiveFromEvents(enteringEvents),
  });
  assert.equal(entering.ok, false, 'premise: entering `hold` fresh IS refused');
  assert.equal(entering.code, 'NEEDS_WORKER_GONE');
});

test('a self-edge does NOT re-run the stage\'s needs', () => {
  // The worker is in `refine`, whose needs are a LIVE worker in `review`. Its
  // reviewer has been retired, so the needs are NOT currently satisfiable —
  // an ordinary follow-up prompt must still go through.
  const events = [
    ...SOLO_RUN,
    { kind: 'transition', sessionId: 'w-planner-1', from: 'implement', to: 'refine', via: 'send_prompt',
      provenance: { review: 'w-review-01' } },
    { kind: 'retire', sessionId: 'w-review-01', reason: 'review done' },
  ];
  assert.deepEqual(PB.get('solo').stages.refine.needs,
    [{ stage: 'review', position: ['review'], liveness: 'live' }],
    'premise: refine needs a worker currently in review');
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'address comment 3', stage: 'refine' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.equal(res.move.kind, 'self');
  // Re-ENTERING refine from implement with the same broken needs IS refused —
  // proving the exemption is specific to the self-edge, not a blanket skip.
  const reentry = d('send_prompt', { sessionId: 'w-planner-2', text: 'go', stage: 'refine' }, [
    ...events,
    { kind: 'spawn', sessionId: 'w-planner-2', playbook: 'solo', stage: 'plan' },
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
  const lockedEvents = [{ kind: 'spawn', sessionId: 'w-locked-1', playbook: 'locked', stage: 'a' }];
  const res = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-locked-1', text: 'hi', stage: 'a' },
    projection: proj(lockedEvents),
    playbooks: pbs(locked), isLive: isLiveFromEvents(lockedEvents),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TOOL_DENIED_IN_STAGE');
});

test('a self-edge still honours the current stage\'s `require` (resulting stage IS current)', () => {
  const pinned = pb({
    id: 'pinned', name: 'Pinned', description: 'pinned args', entryStages: ['a'],
    stages: { a: { tools: { spawn_instance: 'allow', send_prompt: { pin: { wait: false } } } } },
    transitions: [],
  });
  const pinnedEvents = [{ kind: 'spawn', sessionId: 'w-pinned-1', playbook: 'pinned', stage: 'a' }];
  const projection = proj(pinnedEvents);
  const isLive = isLiveFromEvents(pinnedEvents);
  // omitted -> filled in
  const filled = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a' },
    projection, playbooks: pbs(pinned), isLive,
  });
  assert.equal(filled.ok, true);
  assert.equal(filled.patchedArgs.wait, false);
  assert.equal(filled.move.kind, 'self');
  // contradicted -> refused, even on a self-edge
  const conflict = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a', wait: true },
    projection, playbooks: pbs(pinned), isLive,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'ARG_PIN_CONFLICT');
});

test('a send_prompt naming a stage that does not exist is STAGE_UNKNOWN, not a self-edge', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];
  const res = d('send_prompt', { sessionId: 'w-planner-1', text: 'hi', stage: 'paln' }, events);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STAGE_UNKNOWN');
  assert.match(res.reason, /'paln' is not a stage of playbook 'solo'/);
});
