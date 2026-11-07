// Self-edges: send_prompt where `stage` equals the worker's CURRENT stage.
//
// Load-bearing rule. send_prompt ALWAYS carries `stage`, so every ordinary
// follow-up prompt to a worker is a self-edge. If a self-edge were checked
// against the edge set, or re-ran the stage's `needs`, then simply talking to a
// worker twice would be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveMove } from '../src/playbooks.ts';
import { pb, pbs, proj, isLiveFromEvents, GATELAB_PB, GATELAB_RUN, bindRow, moveRow, exitRow } from './playbook-fixtures.mjs';

// Driven through GATELAB (tests/playbook-fixtures.mjs), never through the
// shipped playbooks/*.json: those are hand-editable, and both branches below
// turn on whether a self-loop is DECLARED, which is exactly the kind of value an
// owner may move. GATELAB declares `amend -> amend` and no `draft -> draft`.
const PB = pbs(GATELAB_PB);

function d(toolName, args, events) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB, isLive: isLiveFromEvents(events) });
}

test('a self-edge is allowed even though no self-transition is declared', () => {
  // gatelab declares no draft->draft edge; an ordinary follow-up prompt must work.
  const events = [bindRow('w-drafter-1', 'gatelab', 'draft')];
  assert.equal(PB.get('gatelab').transitions.some(t => t.from === 'draft' && t.to === 'draft'), false,
    'premise: gatelab declares no draft->draft self-loop');
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'also handle X', stage: 'draft' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
});

// ── declared vs undeclared: no difference ───────────────────────────────────
//
// A declared self-loop is a no-op: it resolves exactly like an undeclared
// self-edge, so the gate writes the same row for both (no `move`). Both halves
// are asserted against the SAME playbook.

test('a DECLARED self-loop resolves exactly like an undeclared self-edge (bare `self`, nothing to record)', () => {
  const graph = PB.get('gatelab');
  assert.equal(graph.transitions.some(t => t.from === 'amend' && t.to === 'amend'), true,
    'premise: gatelab declares amend->amend');
  assert.equal(graph.transitions.some(t => t.from === 'draft' && t.to === 'draft'), false,
    'premise: gatelab declares no draft->draft');

  const declared = resolveMove({
    toolName: 'send_prompt', args: { stage: 'amend' }, playbook: graph, currentStage: 'amend',
  });
  assert.deepEqual(declared, { currentStage: 'amend', resultingStage: 'amend', kind: 'self' });

  const undeclared = resolveMove({
    toolName: 'send_prompt', args: { stage: 'draft' }, playbook: graph, currentStage: 'draft',
  });
  assert.deepEqual(undeclared, { currentStage: 'draft', resultingStage: 'draft', kind: 'self' });
});

test('decide() hands the gate a bare self move for a declared self-loop and an undeclared one alike', () => {
  const events = [
    ...GATELAB_RUN,
    moveRow('w-drafter-1', 'build', 'amend', { tool: 'send_prompt', provenance: { audit: 'w-auditor-1' } }),
  ];
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'round 2', stage: 'amend' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'self' });

  const plain = d('send_prompt', { sessionId: 'w-drafter-2', text: 'more', stage: 'draft' },
    [bindRow('w-drafter-2', 'gatelab', 'draft')]);
  assert.deepEqual(plain.move, { kind: 'self' });
});

test('a DECLARED self-loop still skips needs and capacity', () => {
  // `hold` declares
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
    bindRow('w-loop-root', 'loop', 'root'),
    bindRow('w-loop-hold', 'loop', 'hold', { provenance: { root: 'w-loop-root' } }),
    // The need is now unsatisfiable: `hold` requires a LIVE worker in `root`.
    exitRow('w-loop-root'),
  ];
  const res = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-loop-hold', text: 'again', stage: 'hold' },
    projection: proj(events), playbooks: pbs(loop), isLive: isLiveFromEvents(events),
  });
  assert.equal(res.ok, true, `a declared self-loop must not be gated; got ${res.code}: ${res.reason}`);
  assert.deepEqual(res.move, { kind: 'self' });
  // Proof the need really is unsatisfiable — otherwise the case above is vacuous.
  const enteringEvents = [...events,
    bindRow('w-loop-2nd', 'loop', 'root', { provenance: { root: 'w-loop-root' } })];
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
  // The worker is in `amend`, whose needs are a LIVE worker in `audit`. Its
  // auditor has been retired, so the needs are NOT currently satisfiable —
  // an ordinary follow-up prompt must still go through.
  const events = [
    ...GATELAB_RUN,
    moveRow('w-drafter-1', 'build', 'amend', { tool: 'send_prompt', provenance: { audit: 'w-auditor-1' } }),
    exitRow('w-auditor-1'),
  ];
  assert.deepEqual(PB.get('gatelab').stages.amend.needs,
    [{ stage: 'audit', position: ['audit'], liveness: 'live' }],
    'premise: amend needs a worker currently in audit');
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'address comment 3', stage: 'amend' }, events);
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  assert.equal(res.move.kind, 'self');
  // Re-ENTERING amend from build with the same broken needs IS refused —
  // proving the exemption is specific to the self-edge, not a blanket skip.
  const reentry = d('send_prompt', { sessionId: 'w-drafter-2', text: 'go', stage: 'amend' }, [
    ...events,
    bindRow('w-drafter-2', 'gatelab', 'draft'),
    moveRow('w-drafter-2', 'draft', 'build', { tool: 'approve_plan' }),
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
  const lockedEvents = [bindRow('w-locked-1', 'locked', 'a')];
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
    stages: { a: { tools: { spawn_instance: 'allow', send_prompt: { pin: { idleTimeoutSeconds: 10 } } } } },
    transitions: [],
  });
  const pinnedEvents = [bindRow('w-pinned-1', 'pinned', 'a')];
  const projection = proj(pinnedEvents);
  const isLive = isLiveFromEvents(pinnedEvents);
  // omitted -> filled in
  const filled = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a' },
    projection, playbooks: pbs(pinned), isLive,
  });
  assert.equal(filled.ok, true);
  assert.equal(filled.patchedArgs.idleTimeoutSeconds, 10);
  assert.equal(filled.move.kind, 'self');
  // contradicted -> refused, even on a self-edge
  const conflict = decide({
    toolName: 'send_prompt', args: { sessionId: 'w-pinned-1', text: 'hi', stage: 'a', idleTimeoutSeconds: 20 },
    projection, playbooks: pbs(pinned), isLive,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'ARG_PIN_CONFLICT');
});

test('a send_prompt naming a stage that does not exist is STAGE_UNKNOWN, not a self-edge', () => {
  const events = [bindRow('w-drafter-1', 'gatelab', 'draft')];
  const res = d('send_prompt', { sessionId: 'w-drafter-1', text: 'hi', stage: 'drfat' }, events);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STAGE_UNKNOWN');
  assert.match(res.reason, /'drfat' is not a stage of playbook 'gatelab'/);
});
