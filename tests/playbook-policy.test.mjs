// The pure policy decision — decide() in src/playbooks.ts. No HTTP, no
// instances, no ledger file: every case is a fixture projection plus a
// definition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/playbooks.ts';
import { pb, pbs, proj, builtins, CLASSIC_RUN } from './playbook-fixtures.mjs';

const PB = await builtins();

function d(toolName, args, events = []) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB });
}

function refusal(res, code) {
  assert.equal(res.ok, false, `expected a refusal, got ok with move ${JSON.stringify(res.move)}`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.reason}`);
  return res;
}

function allowed(res) {
  assert.equal(res.ok, true, `expected ok, got ${res.code}: ${res.reason}`);
  return res;
}

// ── spawn: fails closed, and `require` fills or refuses ─────────────────────

test('spawn into an entry stage is allowed and `require` FILLS the omitted arguments', () => {
  const res = allowed(d('spawn_instance', { playbook: 'classic', stage: 'plan', project: 'demo' }));
  assert.equal(res.patchedArgs.mode, 'plan');
  assert.equal(res.patchedArgs.model, 'planner');
  assert.equal(res.patchedArgs.createWorktree, true);
  assert.deepEqual(res.move, { kind: 'spawn', to: 'plan' });
});

test('a supplied argument that contradicts `require` is refused, not overridden', () => {
  const res = refusal(
    d('spawn_instance', { playbook: 'classic', stage: 'plan', mode: 'bypassPermissions' }),
    'ARG_REQUIRE_CONFLICT');
  assert.match(res.reason, /requires spawn_instance to be called with mode="plan"/);
  assert.match(res.reason, /hard constraint, not a default/);
});

test('`require` is enforced per tool, not once per stage — a second tool has its own constraint', () => {
  const two = pb({
    id: 'two', name: 'Two', description: 'two required args on two tools', entryStages: ['a'],
    stages: {
      a: {
        tools: {
          spawn_instance: { require: { createWorktree: false } },
          set_mode: { require: { mode: 'plan' } },
        },
      },
    },
    transitions: [],
  });
  const P = pbs(two);
  const events = [{ kind: 'spawn', sessionId: 'w-two-0001', playbook: 'two', stage: 'a' }];
  const projection = proj(events);
  // tool 1: filled on the spawn
  const spawned = decide({ toolName: 'spawn_instance', args: { playbook: 'two', stage: 'a' }, projection, playbooks: P });
  assert.equal(allowed(spawned).patchedArgs.createWorktree, false);
  // tool 2: filled on a targeted call
  const filled = decide({ toolName: 'set_mode', args: { sessionId: 'w-two-0001' }, projection, playbooks: P });
  assert.equal(allowed(filled).patchedArgs.mode, 'plan');
  // tool 2: refused on conflict, and the message names the right tool+arg
  const conflict = decide({ toolName: 'set_mode', args: { sessionId: 'w-two-0001', mode: 'ask' }, projection, playbooks: P });
  assert.match(refusal(conflict, 'ARG_REQUIRE_CONFLICT').reason, /set_mode to be called with mode="plan"/);
});

test('spawn_instance is DENIED BY DEFAULT on a stage that omits it — no explicit deny needed', () => {
  // classic's `implement` and `refine` say nothing about spawn_instance.
  for (const stage of ['implement', 'refine']) {
    const res = refusal(d('spawn_instance', { playbook: 'classic', stage }), 'STAGE_NOT_SPAWNABLE');
    assert.match(res.reason, /does not permit spawn_instance/);
    assert.match(res.reason, /Spawnable stages: plan, review/);
  }
});

test('a run-root spawn must name a playbook; an unknown playbook or stage is named as such', () => {
  assert.match(refusal(d('spawn_instance', { stage: 'plan' }), 'PLAYBOOK_UNKNOWN').reason,
    /has no `needs`, so it starts a new run and must name a `playbook`/);
  refusal(d('spawn_instance', { playbook: 'nope', stage: 'plan' }), 'PLAYBOOK_UNKNOWN');
  refusal(d('spawn_instance', { playbook: 'classic', stage: 'nope' }), 'STAGE_UNKNOWN');
  assert.match(refusal(d('spawn_instance', { playbook: 'classic' }), 'STAGE_UNKNOWN').reason,
    /must name the `stage` to enter/);
});

// ── needs: worker provenance, on spawn-entry AND transition-entry ───────────

test('needs is enforced on SPAWN-entry: a reviewer needs an implementer', () => {
  const events = CLASSIC_RUN.slice(0, 2); // planner in `implement`, no reviewer yet
  const missing = refusal(d('spawn_instance', { playbook: 'classic', stage: 'review' }, events), 'NEEDS_UNSATISFIED');
  assert.match(missing.reason, /requires a worker currently in stage 'implement'/);
  assert.match(missing.reason, /needs: \{ "implement": "<sessionId>" \}/);
  // `needs` must not read as if it were `require`.
  assert.match(missing.reason, /names another WORKER/);

  const ok = allowed(d('spawn_instance',
    { playbook: 'classic', stage: 'review', needs: { implement: 'w-planner-1' } }, events));
  assert.equal(ok.patchedArgs.model, 'reviewer');
  assert.equal(ok.patchedArgs.mode, 'bypassPermissions');
});

test('needs is enforced on TRANSITION-entry too, not only on spawn', () => {
  const noReviewer = CLASSIC_RUN.slice(0, 2);
  // implement -> refine is a legal edge, but `refine` needs a reviewer.
  refusal(d('send_prompt', { sessionId: 'w-planner-1', text: 'go', stage: 'refine' }, noReviewer),
    'NEEDS_UNSATISFIED');
  // With the reviewer spawned, the same call is allowed and IS a transition.
  const res = allowed(d('send_prompt',
    { sessionId: 'w-planner-1', text: 'go', stage: 'refine', needs: { review: 'w-review-01' } }, CLASSIC_RUN));
  assert.deepEqual(res.move, { kind: 'transition', from: 'implement', to: 'refine', via: 'send_prompt' });
});

test('needs at:"current" requires the target in that stage NOW and points at at:"ever" when it is not', () => {
  // No reviewer in this fixture, so `review`'s workers:"one" slot is free and the
  // only thing that can refuse the spawn is the unsatisfied `needs`.
  const moved = [
    ...CLASSIC_RUN.slice(0, 2),
    // the implementer has already moved on to refine
    { kind: 'transition', sessionId: 'w-planner-1', from: 'implement', to: 'refine', via: 'send_prompt' },
  ];
  const res = refusal(d('spawn_instance',
    { playbook: 'classic', stage: 'review', needs: { implement: 'w-planner-1' } }, moved), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /to be in stage 'implement' right now, but it is in 'refine'/);
  assert.match(res.reason, /must declare needs\.at:"ever"/);
});

test('needs at:"ever" is satisfied by history, including by a RETIRED worker', () => {
  // split's `implement` needs a worker that has EVER been in `plan`.
  const events = [
    { kind: 'spawn', sessionId: 'w-splitpl-1', playbook: 'split', stage: 'plan' },
    { kind: 'retire', sessionId: 'w-splitpl-1', reason: 'planning done' },
  ];
  allowed(d('spawn_instance',
    { playbook: 'split', stage: 'implement', needs: { plan: 'w-splitpl-1' } }, events));
  // The same retired worker cannot satisfy an at:"current" need (classic's review).
  const cur = [
    { kind: 'spawn', sessionId: 'w-cl-imp-1', playbook: 'classic', stage: 'plan' },
    { kind: 'transition', sessionId: 'w-cl-imp-1', from: 'plan', to: 'implement', via: 'approve_plan' },
    { kind: 'retire', sessionId: 'w-cl-imp-1', reason: 'killed' },
  ];
  assert.match(
    refusal(d('spawn_instance',
      { playbook: 'classic', stage: 'review', needs: { implement: 'w-cl-imp-1' } }, cur), 'NEEDS_UNSATISFIED').reason,
    /retired \(last in 'implement'\)/);
});

test('needs is scoped to one run — a worker from another run cannot satisfy it', () => {
  const twoRuns = [
    ...CLASSIC_RUN,                                                     // run A
    { kind: 'spawn', sessionId: 'w-planner-2', playbook: 'classic', stage: 'plan' },   // run B
    { kind: 'transition', sessionId: 'w-planner-2', from: 'plan', to: 'implement', via: 'approve_plan' },
  ];
  // run B's implementer trying to enter refine on run A's reviewer
  const res = refusal(d('send_prompt',
    { sessionId: 'w-planner-2', text: 'go', stage: 'refine', needs: { review: 'w-review-01' } }, twoRuns),
    'NEEDS_UNSATISFIED');
  assert.match(res.reason, /belongs to a different run/);
});

// Two DIFFERENT mechanisms reject an unknown sessionId, and they live on
// different code paths. On a spawn the playbook-inheritance resolution hits it
// first (it cannot inherit a playbook from a worker it does not know); on a
// transition there is no inheritance step, so the needs check itself must catch
// it. Both are pinned, or the transition path is covered only by accident.
test('SPAWN: an unknown needs ancestor is refused during playbook inheritance', () => {
  const res = refusal(d('spawn_instance',
    { playbook: 'classic', stage: 'review', needs: { implement: 'ghost-000' } }, CLASSIC_RUN.slice(0, 2)),
    'NEEDS_UNSATISFIED');
  assert.match(res.reason, /is not a playbook-tracked worker/);
  assert.match(res.reason, /its playbook and stage are unknown/);
});

test('TRANSITION: an unknown needs target is refused by the needs check itself', () => {
  const res = refusal(d('send_prompt',
    { sessionId: 'w-planner-1', text: 'go', stage: 'refine', needs: { review: 'ghost-000' } },
    CLASSIC_RUN.slice(0, 2)), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /needs\.review names sessionId 'ghost-000', which is not a playbook-tracked worker/);
});

// ── playbook binding + inheritance ─────────────────────────────────────────

test('a non-root spawn inherits its playbook; disagreement is PLAYBOOK_MISMATCH', () => {
  const mixed = [
    { kind: 'spawn', sessionId: 'w-cl-0001', playbook: 'classic', stage: 'plan' },
    { kind: 'spawn', sessionId: 'w-sp-0001', playbook: 'split', stage: 'plan' },
  ];
  // ancestors disagree with each other
  assert.match(refusal(d('spawn_instance',
    { stage: 'implement', needs: { plan: 'w-sp-0001', other: 'w-cl-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /disagree about their playbook \(classic, split\)/);
  // an explicitly supplied playbook contradicting the inherited one
  assert.match(refusal(d('spawn_instance',
    { playbook: 'classic', stage: 'implement', needs: { plan: 'w-sp-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /this spawn inherits 'split'/);
  // naming the inherited playbook is fine
  allowed(d('spawn_instance', { playbook: 'split', stage: 'implement', needs: { plan: 'w-sp-0001' } }, mixed));
});

// ── capacity ───────────────────────────────────────────────────────────────

function capacityPlaybook(workers) {
  return pb({
    id: 'cap', name: 'Cap', description: `workers:${workers}`, entryStages: ['root'],
    stages: {
      root: { tools: { spawn_instance: 'allow' } },
      slot: { needs: [{ stage: 'root' }], workers, tools: { spawn_instance: 'allow' } },
    },
    transitions: [],
  });
}

test('workers:"one" refuses a second live worker in the stage; "many" does not', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-root', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', needs: { root: 'w-cap-root' } },
  ];
  const args = { stage: 'slot', needs: { root: 'w-cap-root' } };
  const one = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('one')) });
  assert.match(refusal(one, 'STAGE_AT_CAPACITY').reason, /declares workers:"one"/);
  const many = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('many')) });
  allowed(many);
});

test('capacity counts LIVE workers, so a retire frees the slot', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-root', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', needs: { root: 'w-cap-root' } },
    { kind: 'retire', sessionId: 'w-cap-a001', reason: 'killed' },
  ];
  allowed(decide({
    toolName: 'spawn_instance',
    args: { stage: 'slot', needs: { root: 'w-cap-root' } },
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')),
  }));
});

test('capacity is scoped to the RUN, not globally — a second run gets its own slot', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-rtA0', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', needs: { root: 'w-cap-rtA0' } },
    { kind: 'spawn', sessionId: 'w-cap-rtB0', playbook: 'cap', stage: 'root' },
  ];
  allowed(decide({
    toolName: 'spawn_instance',
    args: { stage: 'slot', needs: { root: 'w-cap-rtB0' } },
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')),
  }));
});

// ── the tools map: deny, wildcard, precedence, prefix ──────────────────────

test('set_mode is denied in classic\'s plan stage', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  const res = refusal(d('set_mode', { sessionId: 'w-planner-1', mode: 'bypassPermissions' }, events),
    'TOOL_DENIED_IN_STAGE');
  assert.match(res.reason, /set_mode is denied for a worker in stage 'plan' of playbook 'classic'/);
});

test('"*": "deny" reads as an allowlist, and an exact name beats the wildcard', () => {
  const locked = pb({
    id: 'locked', name: 'Locked', description: 'allowlist', entryStages: ['a'],
    stages: { a: { tools: { '*': 'deny', spawn_instance: 'allow', kill_instance: 'allow' } } },
    transitions: [],
  });
  const P = pbs(locked);
  const projection = proj([{ kind: 'spawn', sessionId: 'w-locked-1', playbook: 'locked', stage: 'a' }]);
  // not in the allowlist -> denied via '*'
  refusal(decide({ toolName: 'set_mode', args: { sessionId: 'w-locked-1', mode: 'ask' }, projection, playbooks: P }),
    'TOOL_DENIED_IN_STAGE');
  // exact 'allow' beats the '*' deny
  allowed(decide({ toolName: 'kill_instance', args: { sessionId: 'w-locked-1' }, projection, playbooks: P }));
  // ...including for spawn_instance, whose default would also be deny
  allowed(decide({ toolName: 'spawn_instance', args: { playbook: 'locked', stage: 'a' }, projection, playbooks: P }));
});

test('the mcp__code-conductor__ prefix is normalized before policy lookup', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  refusal(d('mcp__code-conductor__set_mode', { sessionId: 'w-planner-1', mode: 'ask' }, events),
    'TOOL_DENIED_IN_STAGE');
  // and the prefixed spawn_instance still routes to the spawn path
  refusal(d('mcp__code-conductor__spawn_instance', { playbook: 'classic', stage: 'implement' }),
    'STAGE_NOT_SPAWNABLE');
});

test('a worker that is not playbook-tracked is ungoverned', () => {
  const res = allowed(d('merge_worktree', { sessionId: 'not-tracked' }, CLASSIC_RUN));
  assert.deepEqual(res.move, { kind: 'none' });
});

// ── the two scope rules ────────────────────────────────────────────────────
//
// These two tests are the ones that fail if permission and entry conditions are
// read from the wrong stage. Each is built so it passes one way and fails the
// other — a symmetric fixture would be green under either implementation.

test('SCOPE RULE 1: permission is read from the CURRENT stage, not the destination', () => {
  const shape = (aPolicy, bPolicy) => pb({
    id: 'scope', name: 'Scope', description: 'permission scope', entryStages: ['a'],
    stages: {
      a: { tools: { spawn_instance: 'allow', approve_plan: aPolicy } },
      b: { tools: { approve_plan: bPolicy } },
    },
    transitions: [{ from: 'a', to: 'b', on: 'approve_plan' }],
  });
  const projection = proj([{ kind: 'spawn', sessionId: 'w-scope-01', playbook: 'scope', stage: 'a' }]);
  const args = { sessionId: 'w-scope-01' };

  // current ALLOWS, destination DENIES -> allowed (reading the destination would refuse)
  const res = allowed(decide({ toolName: 'approve_plan', args, projection, playbooks: pbs(shape('allow', 'deny')) }));
  assert.deepEqual(res.move, { kind: 'transition', from: 'a', to: 'b', via: 'approve_plan' });

  // current DENIES, destination ALLOWS -> refused (reading the destination would allow)
  refusal(decide({ toolName: 'approve_plan', args, projection, playbooks: pbs(shape('deny', 'allow')) }),
    'TOOL_DENIED_IN_STAGE');
});

test('SCOPE RULE 2: `require` is read from the RESULTING stage, not the current one', () => {
  const scope = pb({
    id: 'scopereq', name: 'ScopeReq', description: 'require scope', entryStages: ['a'],
    stages: {
      a: { tools: { spawn_instance: 'allow', send_prompt: { require: { wait: false } } } },
      b: { tools: { send_prompt: { require: { wait: true } } } },
    },
    transitions: [{ from: 'a', to: 'b' }],
  });
  const projection = proj([{ kind: 'spawn', sessionId: 'w-scopeq-1', playbook: 'scopereq', stage: 'a' }]);
  // Transitioning a -> b: the constraint that applies is b's (wait:true), not a's.
  const res = allowed(decide({
    toolName: 'send_prompt', args: { sessionId: 'w-scopeq-1', text: 'go', stage: 'b' }, projection, playbooks: pbs(scope),
  }));
  assert.equal(res.patchedArgs.wait, true, "`require` must come from the RESULTING stage 'b'");
  // And supplying a's value explicitly now conflicts with b's constraint.
  refusal(decide({
    toolName: 'send_prompt', args: { sessionId: 'w-scopeq-1', text: 'go', stage: 'b', wait: false },
    projection, playbooks: pbs(scope),
  }), 'ARG_REQUIRE_CONFLICT');
});

// ── definition drift (settled: definitions are NOT pinned to a live run) ────

test('a live worker whose stage vanished gets STAGE_UNKNOWN that says the DEFINITION changed', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-drift-01', playbook: 'classic', stage: 'gone' }];
  const res = refusal(d('send_prompt', { sessionId: 'w-drift-01', text: 'hi', stage: 'gone' }, events), 'STAGE_UNKNOWN');
  assert.match(res.reason, /no longer exists in playbook 'classic'/);
  assert.match(res.reason, /the definition was edited while this worker was live/);
  assert.match(res.reason, /not a problem with your call/);
  assert.match(res.reason, /Stages now: plan, implement, review, refine/);
});

test('a live worker whose whole playbook vanished gets PLAYBOOK_UNKNOWN saying the same', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-drift-02', playbook: 'deleted-pb', stage: 'plan' }];
  const res = refusal(d('send_prompt', { sessionId: 'w-drift-02', text: 'hi', stage: 'plan' }, events), 'PLAYBOOK_UNKNOWN');
  assert.match(res.reason, /no longer loaded/);
  assert.match(res.reason, /not pinned/);
});

// ── refusals carry the legal moves ─────────────────────────────────────────

test('every refusal carries the playbook, the stage, and the legal transitions from here', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'classic', stage: 'plan' }];
  const res = refusal(d('set_mode', { sessionId: 'w-planner-1', mode: 'ask' }, events), 'TOOL_DENIED_IN_STAGE');
  assert.equal(res.legalMoves.playbook, 'classic');
  assert.equal(res.legalMoves.stage, 'plan');
  assert.deepEqual(res.legalMoves.transitions, [{ to: 'implement', via: 'approve_plan' }]);
});
