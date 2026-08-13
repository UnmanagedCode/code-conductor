// The pure policy decision — decide() in src/playbooks.ts. No HTTP, no
// instances, no ledger file: every case is a fixture projection plus a
// definition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/playbooks.ts';
import { pb, pbs, proj, builtins, SOLO_RUN } from './playbook-fixtures.mjs';

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
  const res = allowed(d('spawn_instance', { playbook: 'solo', stage: 'plan', project: 'demo' }));
  assert.equal(res.patchedArgs.mode, 'plan');
  assert.equal(res.patchedArgs.createWorktree, true);
  // solo's plan stage deliberately does NOT pin `model`: its worker is the
  // same session that goes on to implement and refine, so pinning the model at
  // the plan stage would pin it for the whole run. Model choice is the
  // conductor's per-task judgment; playbooks enforce structure.
  assert.equal('model' in res.patchedArgs, false);
  assert.deepEqual(res.move, { kind: 'spawn', to: 'plan', playbook: 'solo' });
});

// The contrast with solo above is the whole reason relay CAN pin here: its
// planner is a DIFFERENT worker from the implementer (no edge out of `plan`),
// so the pin binds one worker rather than a whole run.
test('relay\'s plan stage pins the planner role, and refuses a spawn that names another model', () => {
  const res = allowed(d('spawn_instance', { playbook: 'relay', stage: 'plan', project: 'demo' }));
  assert.equal(res.patchedArgs.model, 'planner');
  assert.equal(res.patchedArgs.mode, 'plan');

  const conflict = refusal(
    d('spawn_instance', { playbook: 'relay', stage: 'plan', project: 'demo', model: 'sonnet' }),
    'ARG_PIN_CONFLICT');
  assert.match(conflict.reason, /model/);
});

test('a supplied argument that contradicts `require` is refused, not overridden', () => {
  const res = refusal(
    d('spawn_instance', { playbook: 'solo', stage: 'plan', mode: 'bypassPermissions' }),
    'ARG_PIN_CONFLICT');
  assert.match(res.reason, /requires spawn_instance to be called with mode="plan"/);
  assert.match(res.reason, /hard constraint, not a default/);
});

test('`require` is enforced per tool, not once per stage — a second tool has its own constraint', () => {
  const two = pb({
    id: 'two', name: 'Two', description: 'two required args on two tools', entryStages: ['a'],
    stages: {
      a: {
        tools: {
          spawn_instance: { pin: { createWorktree: false } },
          set_mode: { pin: { mode: 'plan' } },
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
  assert.match(refusal(conflict, 'ARG_PIN_CONFLICT').reason, /set_mode to be called with mode="plan"/);
});

test('spawn_instance is DENIED BY DEFAULT on a stage that omits it — no explicit deny needed', () => {
  // solo's `implement` and `refine` say nothing about spawn_instance.
  for (const stage of ['implement', 'refine']) {
    const res = refusal(d('spawn_instance', { playbook: 'solo', stage }), 'STAGE_NOT_SPAWNABLE');
    assert.match(res.reason, /does not declare spawn_instance/);
    assert.match(res.reason, /Spawnable stages: plan, review/);
  }
});

test('a "*": "allow" wildcard does NOT make a stage spawnable — spawn_instance must be named', () => {
  const wild = pb({
    id: 'wild', name: 'Wild', description: 'wildcard-allow stage', entryStages: ['a'],
    stages: {
      a: { tools: { spawn_instance: 'allow' } },
      b: { tools: { '*': 'allow' } },   // reachable by transition, but never spawnable
    },
    transitions: [{ from: 'a', to: 'b' }],
  });
  const res = refusal(decide({
    toolName: 'spawn_instance', args: { playbook: 'wild', stage: 'b' },
    projection: proj([]), playbooks: pbs(wild),
  }), 'STAGE_NOT_SPAWNABLE');
  assert.match(res.reason, /does not declare spawn_instance/);
  assert.match(res.reason, /Spawnable stages: a\./);
  // The wildcard still governs every OTHER tool in that stage as usual.
  allowed(decide({
    toolName: 'set_mode', args: { sessionId: 'w-wild-001', mode: 'ask' },
    projection: proj([{ kind: 'spawn', sessionId: 'w-wild-001', playbook: 'wild', stage: 'b' }]),
    playbooks: pbs(wild),
  }));
});

test('a run-root spawn must name a playbook; an unknown playbook or stage is named as such', () => {
  const root = refusal(d('spawn_instance', { stage: 'plan' }), 'PLAYBOOK_UNKNOWN');
  // The refusal must name the argument the caller actually passes. `needs` is the
  // STAGE's declaration; the argument was renamed to `provenance`, and a caller
  // acting literally on the old text fails a second time.
  assert.match(root.reason, /has no `provenance`, so it starts a new run and must name a `playbook`/);
  assert.doesNotMatch(root.reason, /has no `needs`/,
    'the refusal must not name `needs` as the argument to pass — no tool accepts it');
  refusal(d('spawn_instance', { playbook: 'nope', stage: 'plan' }), 'PLAYBOOK_UNKNOWN');
  refusal(d('spawn_instance', { playbook: 'solo', stage: 'nope' }), 'STAGE_UNKNOWN');
  assert.match(refusal(d('spawn_instance', { playbook: 'solo' }), 'STAGE_UNKNOWN').reason,
    /must name the `stage` to enter/);
});

// ── the first-spawn refusal has to be recoverable in ONE round-trip ─────────
//
// What is pinned here is the refusal PAYLOAD, computed by calling decide()
// directly — so it holds at either enforcement level, and says nothing about
// which one ships. (Both levels decide and ledger; `enforce` returns this
// payload to the caller, `warn` warns with it and lets the spawn proceed
// untracked.)
//
// A run-root spawn that names no playbook cannot know one without asking, and
// this refusal is the only channel (there is no server→client notification and
// the tool list is fetched once), so it must carry both halves of the answer:
// which playbooks exist AND where each can be entered. `legalMoves` structurally
// cannot say this — it describes edges out of one known stage, and there is no
// stage yet — so it lives in `reason`.

test('the run-root refusal names every playbook WITH its spawnable entry stages', () => {
  const res = refusal(d('spawn_instance', { project: 'demo' }), 'PLAYBOOK_UNKNOWN');
  assert.match(res.reason, /must name a `playbook` and a `stage`/);
  for (const [id, playbook] of PB) {
    assert.match(res.reason, new RegExp(`\\b${id}\\b`), `${id} must be named`);
    const spawnable = playbook.entryStages.filter(
      s => playbook.stages[s].tools['spawn_instance'] !== undefined
        && playbook.stages[s].tools['spawn_instance'] !== 'deny');
    for (const stage of spawnable) {
      assert.match(res.reason, new RegExp(`\\b${stage}\\b`),
        `${id}'s entry stage ${stage} must be named, or the conductor needs a second refusal to find it`);
    }
  }
});

test('acting on that refusal alone yields a LEGAL spawn — no second round-trip', () => {
  // The claim under test is that the hint is actionable, not merely present: parse
  // the first (playbook, stage) pair back out of the text the conductor was given
  // and replay the call. If the hint ever drifts from real stage names, this fails
  // where a substring assertion would not.
  const res = refusal(d('spawn_instance', { project: 'demo' }), 'PLAYBOOK_UNKNOWN');
  const m = /(\w[\w-]*) \(enter at: ([\w-]+)/.exec(res.reason);
  assert.ok(m, `the hint must be machine-parseable; got: ${res.reason}`);
  const [, playbook, stage] = m;
  const retry = allowed(d('spawn_instance', { playbook, stage, project: 'demo' }));
  assert.equal(retry.move.kind, 'spawn');
  assert.deepEqual({ playbook: retry.move.playbook, to: retry.move.to }, { playbook, to: stage });
});

test('naming a playbook but no stage still names that playbook\'s entry stages', () => {
  // The second step of recovery, if the conductor supplies only the playbook.
  assert.match(refusal(d('spawn_instance', { playbook: 'solo' }), 'STAGE_UNKNOWN').reason,
    /can be entered at: plan/);
});

// ── resume of a playbook-tracked worker ─────────────────────────────────────
//
// A RESUME IS NOT A STAGE ENTRY. The binding is already on the session record, so
// it is read from there rather than demanded again — which is what makes the bare
// spawn_instance({resume}) that the SESSION_NOT_LIVE refusal names actually work.
// The worker is coming back to where it already is, so none of the entered-stage
// checks (spawnability, `needs`, capacity, `pin`) apply.

// The planner has been approved into `implement` and then died. `implement` is
// solo's non-entry, NON-SPAWNABLE stage, which is the interesting case: a resume
// has to work there, and an entry check would refuse it.
const RESUMABLE = [
  ...SOLO_RUN.slice(0, 2),
  { kind: 'retire', sessionId: 'w-planner-1', reason: 'subprocess exited' },
];

test('a BARE resume of a playbook-tracked worker is allowed — no playbook/stage needed', () => {
  const res = allowed(d('spawn_instance', { resume: 'w-planner-1' }, RESUMABLE));
  assert.equal(res.move.kind, 'resume');
});

test('a bare resume inherits the RECORDED stage, and spawnability is never consulted', () => {
  // Pins two mutations at once: taking the stage from entryStages (would give
  // 'plan'), and applying isSpawnable to the resume path (would refuse
  // STAGE_NOT_SPAWNABLE, since solo's `implement` declares no spawn_instance).
  const res = allowed(d('spawn_instance', { resume: 'w-planner-1' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'resume', to: 'implement', playbook: 'solo' });
  assert.equal(PB.get('solo').entryStages.includes('implement'), false,
    'the fixture is only meaningful while `implement` is NOT an entry stage');
});

test('a resume does NOT apply the entered-stage `pin` — the args pass through untouched', () => {
  // The highest-value case in this section: relay's `plan` stage pins `model` AND
  // `mode`, and solo's pins createWorktree:true — so routing a resume through
  // applyPin would silently hand a resumed session a brand-new worktree, which no
  // other assertion here would notice.
  const events = [{ kind: 'spawn', sessionId: 'w-relay-p1', playbook: 'relay', stage: 'plan', project: 'demo' }];
  const args = { resume: 'w-relay-p1' };
  const res = allowed(d('spawn_instance', args, events));
  // Identity, not deep-equal: the contract is "unchanged", and deep-equal would
  // still pass on a defensive copy that a later edit could start mutating.
  assert.equal(res.patchedArgs, args, 'patchedArgs must be the caller\'s own args object');
  assert.deepEqual(Object.keys(res.patchedArgs), ['resume']);
  // Guard the premise: relay's plan really does pin, so this test is about the
  // resume path skipping it rather than about a stage with nothing to apply.
  assert.equal(allowed(d('spawn_instance', { playbook: 'relay', stage: 'plan' })).patchedArgs.model, 'planner');
});

test('an explicit binding EQUAL to the record is accepted, and is still a resume', () => {
  // The incident's step 2 (resume + the binding re-stated) must keep working: both
  // the SESSION_NOT_LIVE text and the schema push callers toward re-stating what
  // they know. And it must resolve as a RESUME, not fall back to a run-root spawn
  // — a spawn event here would reset the worker's stageHistory.
  const res = allowed(d('spawn_instance',
    { resume: 'w-planner-1', playbook: 'solo', stage: 'implement' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'resume', to: 'implement', playbook: 'solo' });
});

test('a resume naming a DIFFERENT playbook is PLAYBOOK_MISMATCH, printing both pairs', () => {
  const res = refusal(d('spawn_instance',
    { resume: 'w-planner-1', playbook: 'relay', stage: 'implement' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  // One refusal has to be enough to retry legally, so BOTH halves of the recorded
  // pair and the supplied value appear.
  assert.match(res.reason, /'solo'\/'implement'/, 'the recorded pair must be printed');
  assert.match(res.reason, /'relay'\/'implement'/, 'the supplied pair must be printed');
  assert.match(res.reason, /omit `playbook`\/`stage`, or name the recorded pair/);
});

test('a resume naming a different STAGE under a MATCHING playbook is still a conflict', () => {
  // Pins the independence of the two comparisons — the natural mutation is to
  // compare only `playbook`, which would let this through and re-enter the worker
  // at a stage it never reached.
  const res = refusal(d('spawn_instance',
    { resume: 'w-planner-1', playbook: 'solo', stage: 'review' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /'solo'\/'implement'/);
  assert.match(res.reason, /'solo'\/'review'/);
});

test('a resume naming only a conflicting `stage` is refused with no `playbook` supplied at all', () => {
  refusal(d('spawn_instance', { resume: 'w-planner-1', stage: 'review' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  // …and naming only the matching stage is fine.
  assert.equal(allowed(d('spawn_instance', { resume: 'w-planner-1', stage: 'implement' }, RESUMABLE)).move.kind,
    'resume');
});

test('`provenance` alongside a tracked resume is refused, not silently ignored', () => {
  const res = refusal(d('spawn_instance',
    { resume: 'w-planner-1', provenance: { plan: 'w-review-01' } }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /enters no stage, so it satisfies no `needs` and takes no `provenance`/);
  // An EMPTY provenance map is not a claim about anything, so it resumes.
  assert.equal(allowed(d('spawn_instance', { resume: 'w-planner-1', provenance: {} }, RESUMABLE)).move.kind,
    'resume');
});

test('the two PLAYBOOK_UNKNOWN reasons are distinguishable: untracked resume vs. bare run root', () => {
  // The card's requirement that the refusal say WHICH case it hit. The remedies
  // differ: an untracked session needs a binding declared, a mistyped id needs the
  // full id re-sent — so collapsing these onto one message loses real information.
  const untracked = refusal(d('spawn_instance', { resume: 'w-nobody-01' }, RESUMABLE), 'PLAYBOOK_UNKNOWN');
  assert.match(untracked.reason, /is not playbook-tracked/);
  assert.match(untracked.reason, /takes a complete sessionId; prefixes are not resolved here/);
  assert.match(untracked.reason, /must name a `playbook` and a `stage`/, 'it must still say what to pass');

  const root = refusal(d('spawn_instance', { project: 'demo' }, RESUMABLE), 'PLAYBOOK_UNKNOWN');
  assert.doesNotMatch(root.reason, /is not playbook-tracked/,
    'a spawn with no `resume` must not be described as an untracked resume');
});

test('a resume of an UNTRACKED session that names playbook + stage is still a legal run root', () => {
  // Regression guard: adopting a loose session into a playbook is unchanged, and
  // the resume branch must not swallow ids the ledger knows nothing about.
  const res = allowed(d('spawn_instance',
    { resume: 'w-nobody-01', playbook: 'solo', stage: 'plan' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'spawn', to: 'plan', playbook: 'solo' });
});

test('a resume whose recorded playbook is no longer loaded is refused, naming the cause', () => {
  // Definition drift (settled): definitions are not pinned to a run, so a worker
  // can outlive its own. Without this guard the resume binds to nothing.
  const events = [{ kind: 'spawn', sessionId: 'w-ghost-001', playbook: 'deleted-pb', stage: 'somewhere' }];
  const res = refusal(d('spawn_instance', { resume: 'w-ghost-001' }, events), 'PLAYBOOK_UNKNOWN');
  assert.match(res.reason, /bound to playbook 'deleted-pb', which is no longer loaded/);
  assert.match(res.reason, /definition was removed or renamed/);
});

// ── needs: worker provenance, on spawn-entry AND transition-entry ───────────

test('needs is enforced on SPAWN-entry: a reviewer needs an implementer', () => {
  const events = SOLO_RUN.slice(0, 2); // planner in `implement`, no reviewer yet
  const missing = refusal(d('spawn_instance', { playbook: 'solo', stage: 'review' }, events), 'NEEDS_UNSATISFIED');
  assert.match(missing.reason, /requires a live worker that has passed through stage 'implement'/);
  // The refusal names the ARGUMENT to pass, which is `provenance` — the stage's
  // declaration is `needs`, and telling the caller to pass "needs" would name a
  // key that no tool accepts.
  assert.match(missing.reason, /pass provenance: \{ "implement": "<sessionId>" \}/);

  const ok = allowed(d('spawn_instance',
    { playbook: 'solo', stage: 'review', provenance: { implement: 'w-planner-1' } }, events));
  assert.equal(ok.patchedArgs.model, 'reviewer');
  assert.equal(ok.patchedArgs.mode, 'bypassPermissions');
});

// Same rename-not-alias rule on the call side: `needs` was the argument's old
// name. Passing it must NOT satisfy the stage's needs — a silent acceptance
// would let a spawn skip the provenance edge and land in no run.
test('the retired `needs` argument does not satisfy a stage\'s needs', () => {
  const events = SOLO_RUN.slice(0, 2);
  refusal(d('spawn_instance',
    { playbook: 'solo', stage: 'review', needs: { implement: 'w-planner-1' } }, events),
    'NEEDS_UNSATISFIED');
  // …and the current name does.
  allowed(d('spawn_instance',
    { playbook: 'solo', stage: 'review', provenance: { implement: 'w-planner-1' } }, events));
});

test('needs is enforced on TRANSITION-entry too, not only on spawn', () => {
  const noReviewer = SOLO_RUN.slice(0, 2);
  // implement -> refine is a legal edge, but `refine` needs a reviewer.
  refusal(d('send_prompt', { sessionId: 'w-planner-1', text: 'go', stage: 'refine' }, noReviewer),
    'NEEDS_UNSATISFIED');
  // With the reviewer spawned, the same call is allowed and IS a transition.
  const res = allowed(d('send_prompt',
    { sessionId: 'w-planner-1', text: 'go', stage: 'refine', provenance: { review: 'w-review-01' } }, SOLO_RUN));
  assert.deepEqual(res.move, { kind: 'transition', from: 'implement', to: 'refine', via: 'send_prompt' });
});

// ── the joint C+D invariant ────────────────────────────────────────────────
//
// The single most load-bearing case here. It needs BOTH halves of the change:
// `review.workers:"many"` for the second reviewer to have a slot, and
// `position:["implement","refine"]` for the implementer to still satisfy the
// need once it has moved on. Reverting either one alone fails this test, with a
// different code each time — which is what makes it a real pin rather than a
// pair of assertions that happen to hold.
for (const playbook of ['solo', 'relay']) {
  test(`${playbook}: a second reviewer on another lens is spawnable while the implementer is in refine`, () => {
    const events = [
      { kind: 'spawn', sessionId: 'w-imp-0001', playbook, stage: 'implement' },
      { kind: 'spawn', sessionId: 'w-review-01', playbook, stage: 'review', provenance: { implement: 'w-imp-0001' } },
      // Round 1 relayed: the implementer is now in `refine`, not `implement`.
      { kind: 'transition', sessionId: 'w-imp-0001', from: 'implement', to: 'refine', via: 'send_prompt' },
    ];
    // Mutant `workers:"one"`  => STAGE_AT_CAPACITY (the first reviewer holds it).
    // Mutant position ["implement"] => NEEDS_UNSATISFIED (it is in `refine`).
    const ok = allowed(d('spawn_instance',
      { playbook, stage: 'review', provenance: { implement: 'w-imp-0001' } }, events));
    assert.equal(ok.patchedArgs.model, 'reviewer');
  });
}

// A worker that HAS the provenance but has since moved on. No built-in can
// express this — solo's reviewer never leaves `review`, and relay's planner
// never leaves `plan` — so the position axis gets a fixture of its own.
const MOVER = pb({
  id: 'mover', name: 'Mover', description: 'A worker that walks off its anchor stage.',
  entryStages: ['root'],
  stages: {
    root: { tools: { spawn_instance: 'allow' } },
    other: { needs: [{ stage: 'root' }] },
    strict: { needs: [{ stage: 'root' }], tools: { spawn_instance: 'allow' } },
    wide: { needs: [{ stage: 'root', position: ['root', 'other'] }], tools: { spawn_instance: 'allow' } },
  },
  transitions: [{ from: 'root', to: 'other' }],
});
const MOVED_OFF = [
  { kind: 'spawn', sessionId: 'w-mover-001', playbook: 'mover', stage: 'root' },
  { kind: 'transition', sessionId: 'w-mover-001', from: 'root', to: 'other', via: 'send_prompt' },
];
const mv = (stage, events = MOVED_OFF) => decide({
  toolName: 'spawn_instance',
  args: { playbook: 'mover', stage, provenance: { root: 'w-mover-001' } },
  projection: proj(events), playbooks: pbs(MOVER),
});

test('a position list refuses a stage it does not name, and says which stages it accepts', () => {
  // Provenance passes (it HAS been in `root`) and liveness passes (still live),
  // so position is the only thing that can refuse — which is what makes this a
  // position test rather than an accident of one of the other two checks.
  const res = refusal(mv('strict'), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /accepts worker \S+ only in 'root', but it is in 'other'/);
  // Under an enumeration the fix is usually "add this stage to the list", which
  // a generic refusal cannot say.
  assert.match(res.reason, /add it to that stage's needs\.position/);
  // The same worker, same moment, against a list that DOES name `other`.
  allowed(mv('wide'));
});

test('liveness:"live" refuses a RETIRED worker with NEEDS_WORKER_GONE, not NEEDS_UNSATISFIED', () => {
  // The distinction the code exists to draw: this is not a wiring mistake, the
  // named worker is gone. A mutant folding it back into NEEDS_UNSATISFIED fails
  // on the code; a mutant dropping the liveness check entirely fails on `ok`.
  const cur = [
    { kind: 'spawn', sessionId: 'w-cl-imp-1', playbook: 'solo', stage: 'plan' },
    { kind: 'transition', sessionId: 'w-cl-imp-1', from: 'plan', to: 'implement', via: 'approve_plan' },
    { kind: 'retire', sessionId: 'w-cl-imp-1', reason: 'killed' },
  ];
  const res = refusal(d('spawn_instance',
    { playbook: 'solo', stage: 'review', provenance: { implement: 'w-cl-imp-1' } }, cur), 'NEEDS_WORKER_GONE');
  assert.match(res.reason, /to still be running, but it has retired \(last in 'implement'\)/);
  assert.match(res.reason, /not a wiring mistake/);
});

test('liveness is checked BEFORE position: a worker both gone and moved on reports gone', () => {
  // One worker failing BOTH halves: retired (liveness) and standing in `other`
  // when `strict` accepts only `root` (position). Provenance passes, so the
  // answer is decided purely by which of the two runs first.
  //
  // Swapping the branches yields NEEDS_UNSATISFIED and fails here. Reporting
  // "you did the workflow wrong" for a worker that simply died is the thing
  // this ordering exists to prevent.
  const gone = [...MOVED_OFF, { kind: 'retire', sessionId: 'w-mover-001', reason: 'killed' }];
  const res = refusal(mv('strict', gone), 'NEEDS_WORKER_GONE');
  assert.match(res.reason, /to still be running, but it has retired/);
});

test('liveness:"retired" refuses a live worker and names kill_instance; a retired one satisfies it', () => {
  // Synthetic, because no built-in declares `retired` any more (relay's
  // implement went to "any" so the plan can be forwarded out of a live
  // planner). The branch still exists in decide(), so it still needs
  // behavioural coverage of its own — both halves, so a mutant that deletes
  // the branch and one that refuses unconditionally each fail.
  const strictRetired = pb({
    id: 'gone', name: 'Gone', description: 'The ancestor must be retired.', entryStages: ['root'],
    stages: {
      root: { tools: { spawn_instance: 'allow' } },
      after: {
        needs: [{ stage: 'root', liveness: 'retired' }],
        tools: { spawn_instance: 'allow' },
      },
    },
    transitions: [],
  });
  const pbsGone = pbs(strictRetired);
  const live = [{ kind: 'spawn', sessionId: 'w-root-r001', playbook: 'gone', stage: 'root' }];
  const at = (events) => decide({
    toolName: 'spawn_instance',
    args: { playbook: 'gone', stage: 'after', provenance: { root: 'w-root-r001' } },
    projection: proj(events), playbooks: pbsGone,
  });

  const res = refusal(at(live), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /to be RETIRED before this stage is entered, but it is still running/);
  assert.match(res.reason, /kill_instance/);
  // …and the other half, so a mutant that refuses unconditionally also fails.
  allowed(at([...live, { kind: 'retire', sessionId: 'w-root-r001', reason: 'work done' }]));
});

test('the loose values — liveness:"any" and position:["*"] — each drop exactly one check', () => {
  // Exercised via a synthetic fixture so both axes are pinned in one place:
  // each value is the ABSENCE of a check, which is exactly the kind of branch
  // a mutant deletes quietly.
  const loose = pb({
    id: 'loose', name: 'Loose', description: 'Both axes wide open.', entryStages: ['root'],
    stages: {
      root: { tools: { spawn_instance: 'allow' } },
      moved: { needs: [{ stage: 'root' }], tools: { spawn_instance: 'allow' } },
      sink: {
        needs: [{ stage: 'root', position: ['*'], liveness: 'any' }],
        workers: 'many',
        tools: { spawn_instance: 'allow' },
      },
    },
    transitions: [{ from: 'root', to: 'moved' }],
  });
  const pbs2 = pbs(loose);
  const run = [
    { kind: 'spawn', sessionId: 'w-root-0001', playbook: 'loose', stage: 'root' },
    // position:["*"] — the worker is in `moved`, which `sink`'s list never names.
    { kind: 'transition', sessionId: 'w-root-0001', from: 'root', to: 'moved', via: 'send_prompt' },
  ];
  const at = (events) => decide({
    toolName: 'spawn_instance',
    args: { playbook: 'loose', stage: 'sink', provenance: { root: 'w-root-0001' } },
    projection: proj(events), playbooks: pbs2,
  });
  allowed(at(run));
  // liveness:"any" — and still fine once it is gone.
  allowed(at([...run, { kind: 'retire', sessionId: 'w-root-0001', reason: 'killed' }]));
});

test('needs is scoped to one run — a worker from another run cannot satisfy it', () => {
  const twoRuns = [
    ...SOLO_RUN,                                                     // run A
    { kind: 'spawn', sessionId: 'w-planner-2', playbook: 'solo', stage: 'plan' },   // run B
    { kind: 'transition', sessionId: 'w-planner-2', from: 'plan', to: 'implement', via: 'approve_plan' },
  ];
  // run B's implementer trying to enter refine on run A's reviewer
  const res = refusal(d('send_prompt',
    { sessionId: 'w-planner-2', text: 'go', stage: 'refine', provenance: { review: 'w-review-01' } }, twoRuns),
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
    { playbook: 'solo', stage: 'review', provenance: { implement: 'ghost-000' } }, SOLO_RUN.slice(0, 2)),
    'NEEDS_UNSATISFIED');
  assert.match(res.reason, /is not a playbook-tracked worker/);
  assert.match(res.reason, /its playbook and stage are unknown/);
});

test('TRANSITION: an unknown needs target is refused by the needs check itself', () => {
  const res = refusal(d('send_prompt',
    { sessionId: 'w-planner-1', text: 'go', stage: 'refine', provenance: { review: 'ghost-000' } },
    SOLO_RUN.slice(0, 2)), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /needs\.review names sessionId 'ghost-000', which is not a playbook-tracked worker/);
});

// ── playbook binding + inheritance ─────────────────────────────────────────

test('a non-root spawn inherits its playbook; disagreement is PLAYBOOK_MISMATCH', () => {
  const mixed = [
    { kind: 'spawn', sessionId: 'w-cl-0001', playbook: 'solo', stage: 'plan' },
    { kind: 'spawn', sessionId: 'w-sp-0001', playbook: 'relay', stage: 'plan' },
  ];
  // ancestors disagree with each other
  assert.match(refusal(d('spawn_instance',
    { stage: 'implement', provenance: { plan: 'w-sp-0001', other: 'w-cl-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /disagree about their playbook \(relay, solo\)/);
  // an explicitly supplied playbook contradicting the inherited one
  assert.match(refusal(d('spawn_instance',
    { playbook: 'solo', stage: 'implement', provenance: { plan: 'w-sp-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /this spawn inherits 'relay'/);
  // naming the inherited playbook is fine
  allowed(d('spawn_instance', { playbook: 'relay', stage: 'implement', provenance: { plan: 'w-sp-0001' } }, mixed));
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
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', provenance: { root: 'w-cap-root' } },
  ];
  const args = { stage: 'slot', provenance: { root: 'w-cap-root' } };
  const one = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('one')) });
  assert.match(refusal(one, 'STAGE_AT_CAPACITY').reason, /declares workers:"one"/);
  const many = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('many')) });
  allowed(many);
});

test('capacity counts LIVE workers, so a retire frees the slot', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-root', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', provenance: { root: 'w-cap-root' } },
    { kind: 'retire', sessionId: 'w-cap-a001', reason: 'killed' },
  ];
  allowed(decide({
    toolName: 'spawn_instance',
    args: { stage: 'slot', provenance: { root: 'w-cap-root' } },
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')),
  }));
});

// decideSpawn and decideTargeted each carry their OWN capacity guard. The three
// tests above drive the spawn one; this drives the transition one, which is a
// separate code site and would otherwise stand unguarded.
test('TRANSITION: capacity is enforced on the DESTINATION stage of a transition', () => {
  const capT = pb({
    id: 'capt', name: 'CapT', description: 'transition into a one-worker stage', entryStages: ['root'],
    stages: {
      root: { tools: { spawn_instance: 'allow' } },
      worker: { needs: [{ stage: 'root', position: ['*'], liveness: 'any' }], workers: 'many', tools: { spawn_instance: 'allow' } },
      hold: { workers: 'one' },   // transition-only, single occupant
    },
    transitions: [{ from: 'worker', to: 'hold' }],
  });
  const P = pbs(capT);
  // Two workers of the SAME run sitting in `worker`.
  const twoInWorker = [
    { kind: 'spawn', sessionId: 'w-capt-rt', playbook: 'capt', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-capt-w1', playbook: 'capt', stage: 'worker', provenance: { root: 'w-capt-rt' } },
    { kind: 'spawn', sessionId: 'w-capt-w2', playbook: 'capt', stage: 'worker', provenance: { root: 'w-capt-rt' } },
  ];
  const move = { sessionId: 'w-capt-w2', text: 'take the slot', stage: 'hold' };
  // `hold` empty -> the transition is allowed
  allowed(decide({ toolName: 'send_prompt', args: move, projection: proj(twoInWorker), playbooks: P }));
  // w1 has since transitioned into `hold` -> w2's identical transition is refused
  const occupied = [
    ...twoInWorker,
    { kind: 'transition', sessionId: 'w-capt-w1', from: 'worker', to: 'hold', via: 'send_prompt' },
  ];
  const res = refusal(decide({ toolName: 'send_prompt', args: move, projection: proj(occupied), playbooks: P }),
    'STAGE_AT_CAPACITY');
  assert.match(res.reason, /stage 'hold' declares workers:"one"/);
  // ...and freeing the slot lets it through again
  allowed(decide({
    toolName: 'send_prompt', args: move, playbooks: P,
    projection: proj([...occupied, { kind: 'retire', sessionId: 'w-capt-w1', reason: 'killed' }]),
  }));
});

// The same spawn-vs-transition asymmetry: checkNeeds's playbook check is
// UNREACHABLE from the spawn path (there, playbookId is derived from the
// ancestors, so it always matches) and reachable only on a transition.
test('TRANSITION: a needs target bound to another playbook is PLAYBOOK_MISMATCH', () => {
  const events = [
    ...SOLO_RUN.slice(0, 2),                                                    // solo implementer
    { kind: 'spawn', sessionId: 'w-relay-rv', playbook: 'relay', stage: 'plan' },   // a worker on another playbook
  ];
  const res = refusal(d('send_prompt',
    { sessionId: 'w-planner-1', text: 'go', stage: 'refine', provenance: { review: 'w-relay-rv' } }, events),
    'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /names a worker on playbook 'relay', not 'solo'/);
});

test('capacity is scoped to the RUN, not globally — a second run gets its own slot', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-rtA0', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', provenance: { root: 'w-cap-rtA0' } },
    { kind: 'spawn', sessionId: 'w-cap-rtB0', playbook: 'cap', stage: 'root' },
  ];
  allowed(decide({
    toolName: 'spawn_instance',
    args: { stage: 'slot', provenance: { root: 'w-cap-rtB0' } },
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')),
  }));
});

// ── the tools map: deny, wildcard, precedence, prefix ──────────────────────

test('set_mode is denied in solo\'s plan stage', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];
  const res = refusal(d('set_mode', { sessionId: 'w-planner-1', mode: 'bypassPermissions' }, events),
    'TOOL_DENIED_IN_STAGE');
  assert.match(res.reason, /set_mode is denied for a worker in stage 'plan' of playbook 'solo'/);
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
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];
  refusal(d('mcp__code-conductor__set_mode', { sessionId: 'w-planner-1', mode: 'ask' }, events),
    'TOOL_DENIED_IN_STAGE');
  // and the prefixed spawn_instance still routes to the spawn path
  refusal(d('mcp__code-conductor__spawn_instance', { playbook: 'solo', stage: 'implement' }),
    'STAGE_NOT_SPAWNABLE');
});

test('a worker that is not playbook-tracked is ungoverned', () => {
  const res = allowed(d('sync_worktree', { sessionId: 'not-tracked' }, SOLO_RUN));
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
      a: { tools: { spawn_instance: 'allow', send_prompt: { pin: { wait: false } } } },
      b: { tools: { send_prompt: { pin: { wait: true } } } },
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
  }), 'ARG_PIN_CONFLICT');
});

// ── definition drift (settled: definitions are NOT pinned to a live run) ────

test('a live worker whose stage vanished gets STAGE_UNKNOWN that says the DEFINITION changed', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-drift-01', playbook: 'solo', stage: 'gone' }];
  const res = refusal(d('send_prompt', { sessionId: 'w-drift-01', text: 'hi', stage: 'gone' }, events), 'STAGE_UNKNOWN');
  assert.match(res.reason, /no longer exists in playbook 'solo'/);
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
  const events = [{ kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan' }];
  const res = refusal(d('set_mode', { sessionId: 'w-planner-1', mode: 'ask' }, events), 'TOOL_DENIED_IN_STAGE');
  assert.equal(res.legalMoves.playbook, 'solo');
  assert.equal(res.legalMoves.stage, 'plan');
  assert.deepEqual(res.legalMoves.transitions, [{ to: 'implement', via: 'approve_plan' }]);
});
