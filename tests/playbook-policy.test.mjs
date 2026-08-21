// The pure policy decision — decide() in src/playbooks.ts. No HTTP, no
// instances, no ledger file: every case is a fixture projection plus a
// definition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/playbooks.ts';
import {
  pb, pbs, proj, builtins, isLiveFromEvents, GATELAB_PB, GATELAB_RUN,
} from './playbook-fixtures.mjs';
import { resolvePolicy } from '../src/playbooks.ts';

// decide() is driven through GATELAB, a test-only graph (tests/playbook-fixtures.mjs),
// never through the shipped playbooks/*.json — those are hand-editable by their
// owner, so restating their pins, stage names or `needs` here would make an
// ordinary edit redden this file. The one claim that is genuinely ABOUT the
// built-ins is at the bottom, and reads their definitions rather than copying
// them.
// A second graph, so the cross-playbook cases (inheritance disagreement,
// PLAYBOOK_MISMATCH) have something to disagree WITH. Deliberately minimal: its
// only job is to be a different id whose stage names overlap GATELAB's.
const OTHERLAB = pb({
  id: 'otherlab', name: 'Otherlab', description: 'A second graph, for mismatch cases.',
  entryStages: ['draft'],
  stages: {
    draft: { tools: { spawn_instance: 'allow' } },
    build: { needs: [{ stage: 'draft' }], tools: { spawn_instance: 'allow' } },
  },
  transitions: [],
});
const PB = pbs(GATELAB_PB, OTHERLAB);

function d(toolName, args, events = []) {
  return decide({ toolName, args, projection: proj(events), playbooks: PB, isLive: isLiveFromEvents(events) });
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
  const res = allowed(d('spawn_instance', { playbook: 'gatelab', stage: 'draft', project: 'demo' }));
  assert.equal(res.patchedArgs.mode, 'ask');
  assert.equal(res.patchedArgs.createWorktree, true);
  // A stage pins what it pins and nothing more: `draft` names no `model`, so
  // none is invented. (The mirror — a stage that DOES pin one — is the next test.)
  assert.equal('model' in res.patchedArgs, false);
  assert.deepEqual(res.move, { kind: 'spawn', to: 'draft', playbook: 'gatelab' });
});

test('a stage that pins a role fills it in, and refuses a spawn that names another model', () => {
  const args = { playbook: 'gatelab', stage: 'audit', project: 'demo',
    provenance: { build: 'w-drafter-1' } };
  const res = allowed(d('spawn_instance', args, GATELAB_RUN.slice(0, 2)));
  assert.equal(res.patchedArgs.model, 'reviewer');
  assert.equal(res.patchedArgs.mode, 'bypassPermissions');

  const conflict = refusal(
    d('spawn_instance', { ...args, model: 'sonnet' }, GATELAB_RUN.slice(0, 2)),
    'ARG_PIN_CONFLICT');
  assert.match(conflict.reason, /model/);
});

test('a supplied argument that contradicts `require` is refused, not overridden', () => {
  const res = refusal(
    d('spawn_instance', { playbook: 'gatelab', stage: 'draft', mode: 'bypassPermissions' }),
    'ARG_PIN_CONFLICT');
  assert.match(res.reason, /requires spawn_instance to be called with mode="ask"/);
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
  const isLive = isLiveFromEvents(events);
  // tool 1: filled on the spawn
  const spawned = decide({ toolName: 'spawn_instance', args: { playbook: 'two', stage: 'a' }, projection, playbooks: P, isLive });
  assert.equal(allowed(spawned).patchedArgs.createWorktree, false);
  // tool 2: filled on a targeted call
  const filled = decide({ toolName: 'set_mode', args: { sessionId: 'w-two-0001' }, projection, playbooks: P, isLive });
  assert.equal(allowed(filled).patchedArgs.mode, 'plan');
  // tool 2: refused on conflict, and the message names the right tool+arg
  const conflict = decide({ toolName: 'set_mode', args: { sessionId: 'w-two-0001', mode: 'ask' }, projection, playbooks: P, isLive });
  assert.match(refusal(conflict, 'ARG_PIN_CONFLICT').reason, /set_mode to be called with mode="plan"/);
});

test('spawn_instance is DENIED BY DEFAULT on a stage that omits it — no explicit deny needed', () => {
  // `build` and `amend` say nothing about spawn_instance. The recovery list is
  // derived from the graph rather than restated, so it follows a fixture edit.
  const spawnable = Object.keys(GATELAB_PB.stages)
    .filter(n => { const t = GATELAB_PB.stages[n].tools ?? {}; return t.spawn_instance !== undefined && t.spawn_instance !== 'deny'; });
  assert.ok(spawnable.length > 0, 'premise: the fixture has spawnable stages to offer');
  for (const stage of ['build', 'amend']) {
    const res = refusal(d('spawn_instance', { playbook: 'gatelab', stage }), 'STAGE_NOT_SPAWNABLE');
    assert.match(res.reason, /does not declare spawn_instance/);
    for (const s of spawnable) {
      assert.match(res.reason, new RegExp(`Spawnable stages:[^.]*\\b${s}\\b`),
        `the recovery list must name '${s}'`);
    }
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
    projection: proj([]), playbooks: pbs(wild), isLive: isLiveFromEvents([]),
  }), 'STAGE_NOT_SPAWNABLE');
  assert.match(res.reason, /does not declare spawn_instance/);
  assert.match(res.reason, /Spawnable stages: a\./);
  // The wildcard still governs every OTHER tool in that stage as usual.
  const wildEvents = [{ kind: 'spawn', sessionId: 'w-wild-001', playbook: 'wild', stage: 'b' }];
  allowed(decide({
    toolName: 'set_mode', args: { sessionId: 'w-wild-001', mode: 'ask' },
    projection: proj(wildEvents),
    playbooks: pbs(wild), isLive: isLiveFromEvents(wildEvents),
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
  refusal(d('spawn_instance', { playbook: 'gatelab', stage: 'nope' }), 'STAGE_UNKNOWN');
  assert.match(refusal(d('spawn_instance', { playbook: 'gatelab' }), 'STAGE_UNKNOWN').reason,
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

test('naming a playbook but no stage names its entry stages, and ONLY those', () => {
  // The second step of recovery, if the conductor supplies only the playbook.
  // Read off the graph, so a fixture edit moves the expectation with it — but
  // asserted as the WHOLE list, not stage by stage: a per-stage membership check
  // is satisfied by any over-inclusive list, so advertising a stage a run cannot
  // actually start in would read as correct. The trailing literal is what closes
  // that direction. `Stages now:` in the definition-drift block below is exact
  // the same way. `Spawnable stages:` is NOT, where it is read off gatelab
  // above — that one is a per-stage loop, and its over-report direction is
  // pinned on the `wild` fixture instead, whose smaller graph lets the list be
  // matched whole.
  assert.notDeepEqual([...GATELAB_PB.entryStages].sort(), Object.keys(GATELAB_PB.stages).sort(),
    'premise: the fixture has non-entry stages, or over-reporting is unobservable here');
  const reason = refusal(d('spawn_instance', { playbook: 'gatelab' }), 'STAGE_UNKNOWN').reason;
  assert.match(reason,
    new RegExp(`can be entered at: ${GATELAB_PB.entryStages.join(', ')} \\(or a stage`),
    `the offered list must be exactly the entry stages; got: ${reason}`);
});

// ── resume of a playbook-tracked worker ─────────────────────────────────────
//
// A RESUME IS NOT A STAGE ENTRY. The binding is already on the session record, so
// it is read from there rather than demanded again — which is what makes the bare
// spawn_instance({resume}) that the SESSION_NOT_LIVE refusal names actually work.
// The worker is coming back to where it already is, so none of the entered-stage
// checks (spawnability, `needs`, capacity, `pin`) apply.

// The drafter has been approved into `build` and then died. `build` is a
// non-entry, NON-SPAWNABLE stage, which is the interesting case: a resume has to
// work there, and an entry check would refuse it.
const RESUMABLE = [
  ...GATELAB_RUN.slice(0, 2),
  { kind: 'retire', sessionId: 'w-drafter-1', reason: 'subprocess exited' },
];

test('a BARE resume of a playbook-tracked worker is allowed — no playbook/stage needed', () => {
  const res = allowed(d('spawn_instance', { resume: 'w-drafter-1' }, RESUMABLE));
  assert.equal(res.move.kind, 'resume');
});

test('a bare resume inherits the RECORDED stage, and spawnability is never consulted', () => {
  // Pins two mutations at once: taking the stage from entryStages (would give
  // 'draft'), and applying isSpawnable to the resume path (would refuse
  // STAGE_NOT_SPAWNABLE, since `build` declares no spawn_instance).
  const res = allowed(d('spawn_instance', { resume: 'w-drafter-1' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'resume', to: 'build', playbook: 'gatelab' });
  assert.equal(PB.get('gatelab').entryStages.includes('build'), false,
    'the fixture is only meaningful while `build` is NOT an entry stage');
});

test('a resume does NOT apply the entered-stage `pin` — the args pass through untouched', () => {
  // The highest-value case in this section: `sealed` pins createWorktree:true, so
  // routing a resume through applyPin would silently hand a resumed session a
  // brand-new worktree, which no other assertion here would notice.
  const events = [{ kind: 'spawn', sessionId: 'w-sealed-p1', playbook: 'gatelab', stage: 'sealed', project: 'demo' }];
  const args = { resume: 'w-sealed-p1' };
  const res = allowed(d('spawn_instance', args, events));
  // Identity, not deep-equal: the contract is "unchanged", and deep-equal would
  // still pass on a defensive copy that a later edit could start mutating.
  assert.equal(res.patchedArgs, args, 'patchedArgs must be the caller\'s own args object');
  assert.deepEqual(Object.keys(res.patchedArgs), ['resume']);
  // Guard the premise: `sealed` really does pin, so this test is about the resume
  // path skipping it rather than about a stage with nothing to apply.
  assert.equal(allowed(d('spawn_instance', { playbook: 'gatelab', stage: 'sealed' })).patchedArgs.createWorktree, true);
});

test('an explicit binding EQUAL to the record is accepted, and is still a resume', () => {
  // The incident's step 2 (resume + the binding re-stated) must keep working: both
  // the SESSION_NOT_LIVE text and the schema push callers toward re-stating what
  // they know. And it must resolve as a RESUME, not fall back to a run-root spawn
  // — a spawn event here would reset the worker's stageHistory.
  const res = allowed(d('spawn_instance',
    { resume: 'w-drafter-1', playbook: 'gatelab', stage: 'build' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'resume', to: 'build', playbook: 'gatelab' });
});

test('a resume naming a DIFFERENT playbook is PLAYBOOK_MISMATCH, printing both pairs', () => {
  const res = refusal(d('spawn_instance',
    { resume: 'w-drafter-1', playbook: 'mover', stage: 'build' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  // One refusal has to be enough to retry legally, so BOTH halves of the recorded
  // pair and the supplied value appear.
  assert.match(res.reason, /'gatelab'\/'build'/, 'the recorded pair must be printed');
  assert.match(res.reason, /'mover'\/'build'/, 'the supplied pair must be printed');
  assert.match(res.reason, /omit `playbook`\/`stage`, or name the recorded pair/);
});

test('a resume naming a different STAGE under a MATCHING playbook is still a conflict', () => {
  // Pins the independence of the two comparisons — the natural mutation is to
  // compare only `playbook`, which would let this through and re-enter the worker
  // at a stage it never reached.
  const res = refusal(d('spawn_instance',
    { resume: 'w-drafter-1', playbook: 'gatelab', stage: 'audit' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /'gatelab'\/'build'/);
  assert.match(res.reason, /'gatelab'\/'audit'/);
});

test('a resume naming only a conflicting `stage` is refused with no `playbook` supplied at all', () => {
  refusal(d('spawn_instance', { resume: 'w-drafter-1', stage: 'audit' }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  // …and naming only the matching stage is fine.
  assert.equal(allowed(d('spawn_instance', { resume: 'w-drafter-1', stage: 'build' }, RESUMABLE)).move.kind,
    'resume');
});

test('`provenance` alongside a tracked resume is refused, not silently ignored', () => {
  const res = refusal(d('spawn_instance',
    { resume: 'w-drafter-1', provenance: { draft: 'w-auditor-1' } }, RESUMABLE), 'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /enters no stage, so it satisfies no `needs` and takes no `provenance`/);
  // An EMPTY provenance map is not a claim about anything, so it resumes.
  assert.equal(allowed(d('spawn_instance', { resume: 'w-drafter-1', provenance: {} }, RESUMABLE)).move.kind,
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
    { resume: 'w-nobody-01', playbook: 'gatelab', stage: 'draft' }, RESUMABLE));
  assert.deepEqual(res.move, { kind: 'spawn', to: 'draft', playbook: 'gatelab' });
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

test('needs is enforced on SPAWN-entry: an auditor needs a builder', () => {
  const events = GATELAB_RUN.slice(0, 2); // drafter in `build`, no auditor yet
  const missing = refusal(d('spawn_instance', { playbook: 'gatelab', stage: 'audit' }, events), 'NEEDS_UNSATISFIED');
  assert.match(missing.reason, /requires a live worker that has passed through stage 'build'/);
  // The refusal names the ARGUMENT to pass, which is `provenance` — the stage's
  // declaration is `needs`, and telling the caller to pass "needs" would name a
  // key that no tool accepts.
  assert.match(missing.reason, /pass provenance: \{ "build": "<sessionId>" \}/);

  const ok = allowed(d('spawn_instance',
    { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-drafter-1' } }, events));
  assert.equal(ok.patchedArgs.model, 'reviewer');
  assert.equal(ok.patchedArgs.mode, 'bypassPermissions');
});

// Same rename-not-alias rule on the call side: `needs` was the argument's old
// name. Passing it must NOT satisfy the stage's needs — a silent acceptance
// would let a spawn skip the provenance edge and land in no run.
test('the retired `needs` argument does not satisfy a stage\'s needs', () => {
  const events = GATELAB_RUN.slice(0, 2);
  refusal(d('spawn_instance',
    { playbook: 'gatelab', stage: 'audit', needs: { build: 'w-drafter-1' } }, events),
    'NEEDS_UNSATISFIED');
  // …and the current name does.
  allowed(d('spawn_instance',
    { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-drafter-1' } }, events));
});

test('needs is enforced on TRANSITION-entry too, not only on spawn', () => {
  const noAuditor = GATELAB_RUN.slice(0, 2);
  // build -> amend is a legal edge, but `amend` needs an auditor.
  refusal(d('send_prompt', { sessionId: 'w-drafter-1', text: 'go', stage: 'amend' }, noAuditor),
    'NEEDS_UNSATISFIED');
  // With the auditor spawned, the same call is allowed and IS a transition.
  const res = allowed(d('send_prompt',
    { sessionId: 'w-drafter-1', text: 'go', stage: 'amend', provenance: { audit: 'w-auditor-1' } }, GATELAB_RUN));
  assert.deepEqual(res.move, { kind: 'transition', from: 'build', to: 'amend', via: 'send_prompt' });
});

// ── the joint capacity + position invariant ────────────────────────────────
//
// The single most load-bearing case here. It needs BOTH halves at once:
// `audit.workers:"many"` for a second lens to have a slot, and
// `position:["build","amend"]` for the builder to still satisfy the need once it
// has moved on. Reverting either one alone fails this test, with a different code
// each time — which is what makes it a real pin rather than a pair of assertions
// that happen to hold.
test('a second lens is spawnable while the worker it audits has moved on to amend', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-imp-0001', playbook: 'gatelab', stage: 'draft' },
    { kind: 'transition', sessionId: 'w-imp-0001', from: 'draft', to: 'build', via: 'approve_plan' },
    { kind: 'spawn', sessionId: 'w-audit-01', playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-imp-0001' } },
    // Round 1 relayed: the builder is now in `amend`, not `build`.
    { kind: 'transition', sessionId: 'w-imp-0001', from: 'build', to: 'amend', via: 'send_prompt' },
  ];
  // Mutant `workers:"one"`      => STAGE_AT_CAPACITY (the first lens holds it).
  // Mutant position ["build"]   => NEEDS_UNSATISFIED (it is in `amend`).
  const ok = allowed(d('spawn_instance',
    { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-imp-0001' } }, events));
  assert.equal(ok.patchedArgs.model, 'reviewer');
});

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
  projection: proj(events), playbooks: pbs(MOVER), isLive: isLiveFromEvents(events),
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
    { kind: 'spawn', sessionId: 'w-cl-imp-1', playbook: 'gatelab', stage: 'draft' },
    { kind: 'transition', sessionId: 'w-cl-imp-1', from: 'draft', to: 'build', via: 'approve_plan' },
    { kind: 'retire', sessionId: 'w-cl-imp-1', reason: 'killed' },
  ];
  const res = refusal(d('spawn_instance',
    { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-cl-imp-1' } }, cur), 'NEEDS_WORKER_GONE');
  assert.match(res.reason, /to still be running, but it has no running process \(last known stage 'build'\)/);
  assert.match(res.reason, /not a wiring mistake/);
});

// The oracle is CONSULTED, not read off the projection's own retire/spawn
// fold: a projection containing a `retire` event for the target is exactly
// the fixture the OLD live:boolean field would have answered from, so an
// isLive stub that disagrees with it is what proves decide() no longer reads
// that fold at all (mutant: falling back to a projection-derived liveness bit
// instead of calling isLive would flip one or both of these two assertions).
test('needs.liveness:"live" is answered from isLive(), not from the projection\'s retire event', () => {
  const cur = [
    { kind: 'spawn', sessionId: 'w-cl-imp-1', playbook: 'gatelab', stage: 'draft' },
    { kind: 'transition', sessionId: 'w-cl-imp-1', from: 'draft', to: 'build', via: 'approve_plan' },
    { kind: 'retire', sessionId: 'w-cl-imp-1', reason: 'killed' },
  ];
  const args = { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w-cl-imp-1' } };
  const projection = proj(cur);
  // The ledger recorded a retire, but the oracle says the worker IS live —
  // this must be ALLOWED, which a projection-derived `live` bit could never do.
  allowed(decide({ toolName: 'spawn_instance', args, projection, playbooks: PB, isLive: () => true }));
  // And the mirror, on the identical projection: the oracle says NOT live.
  refusal(decide({ toolName: 'spawn_instance', args, projection, playbooks: PB, isLive: () => false }),
    'NEEDS_WORKER_GONE');
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
  assert.match(res.reason, /to still be running, but it has no running process/);
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
    projection: proj(events), playbooks: pbsGone, isLive: isLiveFromEvents(events),
  });

  const res = refusal(at(live), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /to be RETIRED before this stage is entered, but it is still running/);
  assert.match(res.reason, /kill_instance/);
  // …and the other half, so a mutant that refuses unconditionally also fails.
  allowed(at([...live, { kind: 'retire', sessionId: 'w-root-r001', reason: 'work done' }]));

  // Same fixture PROJECTION both times (no retire event either way) — only the
  // oracle differs. Proves needs.liveness:"retired" reads isLive(), not a
  // projection-derived bit: a mutant reading the fold instead would answer both
  // of these identically (both "spawned, never retired" -> still running).
  const projection = proj(live);
  refusal(decide({
    toolName: 'spawn_instance',
    args: { playbook: 'gone', stage: 'after', provenance: { root: 'w-root-r001' } },
    projection, playbooks: pbsGone, isLive: () => true,
  }), 'NEEDS_UNSATISFIED');
  allowed(decide({
    toolName: 'spawn_instance',
    args: { playbook: 'gone', stage: 'after', provenance: { root: 'w-root-r001' } },
    projection, playbooks: pbsGone, isLive: () => false,
  }));
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
    projection: proj(events), playbooks: pbs2, isLive: isLiveFromEvents(events),
  });
  allowed(at(run));
  // liveness:"any" — and still fine once it is gone.
  allowed(at([...run, { kind: 'retire', sessionId: 'w-root-0001', reason: 'killed' }]));
});

test('needs is scoped to one run — a worker from another run cannot satisfy it', () => {
  const twoRuns = [
    ...GATELAB_RUN,                                                  // run A
    { kind: 'spawn', sessionId: 'w-drafter-2', playbook: 'gatelab', stage: 'draft' },   // run B
    { kind: 'transition', sessionId: 'w-drafter-2', from: 'draft', to: 'build', via: 'approve_plan' },
  ];
  // run B's builder trying to enter amend on run A's auditor
  const res = refusal(d('send_prompt',
    { sessionId: 'w-drafter-2', text: 'go', stage: 'amend', provenance: { audit: 'w-auditor-1' } }, twoRuns),
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
    { playbook: 'gatelab', stage: 'audit', provenance: { build: 'ghost-000' } }, GATELAB_RUN.slice(0, 2)),
    'NEEDS_UNSATISFIED');
  assert.match(res.reason, /is not a playbook-tracked worker/);
  assert.match(res.reason, /its playbook and stage are unknown/);
});

test('TRANSITION: an unknown needs target is refused by the needs check itself', () => {
  const res = refusal(d('send_prompt',
    { sessionId: 'w-drafter-1', text: 'go', stage: 'amend', provenance: { audit: 'ghost-000' } },
    GATELAB_RUN.slice(0, 2)), 'NEEDS_UNSATISFIED');
  assert.match(res.reason, /needs\.audit names sessionId 'ghost-000', which is not a playbook-tracked worker/);
});

// ── playbook binding + inheritance ─────────────────────────────────────────

test('a non-root spawn inherits its playbook; disagreement is PLAYBOOK_MISMATCH', () => {
  const mixed = [
    { kind: 'spawn', sessionId: 'w-cl-0001', playbook: 'gatelab', stage: 'draft' },
    { kind: 'spawn', sessionId: 'w-sp-0001', playbook: 'otherlab', stage: 'draft' },
  ];
  // ancestors disagree with each other
  assert.match(refusal(d('spawn_instance',
    { stage: 'build', provenance: { draft: 'w-sp-0001', other: 'w-cl-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /disagree about their playbook \(gatelab, otherlab\)/);
  // an explicitly supplied playbook contradicting the inherited one
  assert.match(refusal(d('spawn_instance',
    { playbook: 'gatelab', stage: 'build', provenance: { draft: 'w-sp-0001' } }, mixed), 'PLAYBOOK_MISMATCH').reason,
    /this spawn inherits 'otherlab'/);
  // naming the inherited playbook is fine
  allowed(d('spawn_instance', { playbook: 'otherlab', stage: 'build', provenance: { draft: 'w-sp-0001' } }, mixed));
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
  const isLive = isLiveFromEvents(events);
  const one = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('one')), isLive });
  const oneReason = refusal(one, 'STAGE_AT_CAPACITY').reason;
  assert.match(oneReason, /declares workers:"one"/);
  assert.match(oneReason, /w-cap-a0/, 'the refusal names the blocking sessionId, not just the code');
  const many = decide({ toolName: 'spawn_instance', args, projection: proj(events), playbooks: pbs(capacityPlaybook('many')), isLive });
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
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')), isLive: isLiveFromEvents(events),
  }));
});

// The oracle is CONSULTED, not merely folded from the ledger's own events: a
// stub isLive independent of the projection's retire/spawn history is what
// tells apart "capacity reads isLive()" from "capacity still reads a ledger
// bit that happens to agree with it here".
test('workers:"one" capacity is answered from isLive(), not from ledger retire/spawn history', () => {
  const events = [
    { kind: 'spawn', sessionId: 'w-cap-root', playbook: 'cap', stage: 'root' },
    { kind: 'spawn', sessionId: 'w-cap-a001', playbook: 'cap', stage: 'slot', provenance: { root: 'w-cap-root' } },
  ];
  const args = { stage: 'slot', provenance: { root: 'w-cap-root' } };
  const projection = proj(events);
  // The ledger never retired w-cap-a001, but the oracle says it is not live —
  // capacity must free the slot anyway (mutant: reading a ledger-derived flag
  // instead of calling isLive would refuse this as STAGE_AT_CAPACITY). `root`
  // must stay live so this exercises capacity, not the ancestor's own `needs`
  // liveness check.
  allowed(decide({
    toolName: 'spawn_instance', args, projection, playbooks: pbs(capacityPlaybook('one')),
    isLive: sid => sid === 'w-cap-root',
  }));
  // And the mirror: the oracle says everyone is live, so the slot is held
  // (mutant: ignoring isLive and always allowing would pass the first half
  // too, so the sessionId-naming assertion below is what catches that).
  const res = refusal(decide({
    toolName: 'spawn_instance', args, projection, playbooks: pbs(capacityPlaybook('one')),
    isLive: () => true,
  }), 'STAGE_AT_CAPACITY');
  assert.match(res.reason, /w-cap-a0/);
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
  allowed(decide({
    toolName: 'send_prompt', args: move, projection: proj(twoInWorker), playbooks: P,
    isLive: isLiveFromEvents(twoInWorker),
  }));
  // w1 has since transitioned into `hold` -> w2's identical transition is refused
  const occupied = [
    ...twoInWorker,
    { kind: 'transition', sessionId: 'w-capt-w1', from: 'worker', to: 'hold', via: 'send_prompt' },
  ];
  const res = refusal(decide({
    toolName: 'send_prompt', args: move, projection: proj(occupied), playbooks: P,
    isLive: isLiveFromEvents(occupied),
  }), 'STAGE_AT_CAPACITY');
  assert.match(res.reason, /stage 'hold' declares workers:"one"/);
  assert.match(res.reason, /w-capt-w/, 'the refusal names the blocking sessionId, not just the code');
  // ...and freeing the slot lets it through again
  const freed = [...occupied, { kind: 'retire', sessionId: 'w-capt-w1', reason: 'killed' }];
  allowed(decide({
    toolName: 'send_prompt', args: move, playbooks: P,
    projection: proj(freed), isLive: isLiveFromEvents(freed),
  }));
});

// The same spawn-vs-transition asymmetry: checkNeeds's playbook check is
// UNREACHABLE from the spawn path (there, playbookId is derived from the
// ancestors, so it always matches) and reachable only on a transition.
test('TRANSITION: a needs target bound to another playbook is PLAYBOOK_MISMATCH', () => {
  const events = [
    ...GATELAB_RUN.slice(0, 2),                                                       // gatelab builder
    { kind: 'spawn', sessionId: 'w-other-01', playbook: 'otherlab', stage: 'draft' },  // a worker on another playbook
  ];
  const res = refusal(d('send_prompt',
    { sessionId: 'w-drafter-1', text: 'go', stage: 'amend', provenance: { audit: 'w-other-01' } }, events),
    'PLAYBOOK_MISMATCH');
  assert.match(res.reason, /names a worker on playbook 'otherlab', not 'gatelab'/);
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
    projection: proj(events), playbooks: pbs(capacityPlaybook('one')), isLive: isLiveFromEvents(events),
  }));
});

// ── the tools map: deny, wildcard, precedence, prefix ──────────────────────

test('a stage that denies a tool refuses it, and the reason names the stage and playbook', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-sealed-01', playbook: 'gatelab', stage: 'sealed' }];
  const res = refusal(d('set_mode', { sessionId: 'w-sealed-01', mode: 'bypassPermissions' }, events),
    'TOOL_DENIED_IN_STAGE');
  assert.match(res.reason, /set_mode is denied for a worker in stage 'sealed' of playbook 'gatelab'/);
});

test('"*": "deny" reads as an allowlist, and an exact name beats the wildcard', () => {
  const locked = pb({
    id: 'locked', name: 'Locked', description: 'allowlist', entryStages: ['a'],
    stages: { a: { tools: { '*': 'deny', spawn_instance: 'allow', kill_instance: 'allow' } } },
    transitions: [],
  });
  const P = pbs(locked);
  const lockedEvents = [{ kind: 'spawn', sessionId: 'w-locked-1', playbook: 'locked', stage: 'a' }];
  const projection = proj(lockedEvents);
  const isLive = isLiveFromEvents(lockedEvents);
  // not in the allowlist -> denied via '*'
  refusal(decide({ toolName: 'set_mode', args: { sessionId: 'w-locked-1', mode: 'ask' }, projection, playbooks: P, isLive }),
    'TOOL_DENIED_IN_STAGE');
  // exact 'allow' beats the '*' deny
  allowed(decide({ toolName: 'kill_instance', args: { sessionId: 'w-locked-1' }, projection, playbooks: P, isLive }));
  // ...including for spawn_instance, whose default would also be deny
  allowed(decide({ toolName: 'spawn_instance', args: { playbook: 'locked', stage: 'a' }, projection, playbooks: P, isLive }));
});

test('the mcp__code-conductor__ prefix is normalized before policy lookup', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-sealed-01', playbook: 'gatelab', stage: 'sealed' }];
  refusal(d('mcp__code-conductor__set_mode', { sessionId: 'w-sealed-01', mode: 'ask' }, events),
    'TOOL_DENIED_IN_STAGE');
  // and the prefixed spawn_instance still routes to the spawn path
  refusal(d('mcp__code-conductor__spawn_instance', { playbook: 'gatelab', stage: 'build' }),
    'STAGE_NOT_SPAWNABLE');
});

test('a worker that is not playbook-tracked is ungoverned', () => {
  const res = allowed(d('sync_worktree', { sessionId: 'not-tracked' }, GATELAB_RUN));
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
  const scopeEvents = [{ kind: 'spawn', sessionId: 'w-scope-01', playbook: 'scope', stage: 'a' }];
  const projection = proj(scopeEvents);
  const isLive = isLiveFromEvents(scopeEvents);
  const args = { sessionId: 'w-scope-01' };

  // current ALLOWS, destination DENIES -> allowed (reading the destination would refuse)
  const res = allowed(decide({ toolName: 'approve_plan', args, projection, playbooks: pbs(shape('allow', 'deny')), isLive }));
  assert.deepEqual(res.move, { kind: 'transition', from: 'a', to: 'b', via: 'approve_plan' });

  // current DENIES, destination ALLOWS -> refused (reading the destination would allow)
  refusal(decide({ toolName: 'approve_plan', args, projection, playbooks: pbs(shape('deny', 'allow')), isLive }),
    'TOOL_DENIED_IN_STAGE');
});

test('SCOPE RULE 2: `require` is read from the RESULTING stage, not the current one', () => {
  const scope = pb({
    id: 'scopereq', name: 'ScopeReq', description: 'require scope', entryStages: ['a'],
    stages: {
      a: { tools: { spawn_instance: 'allow', send_prompt: { pin: { subscribe: false } } } },
      b: { tools: { send_prompt: { pin: { subscribe: true } } } },
    },
    transitions: [{ from: 'a', to: 'b' }],
  });
  const scopereqEvents = [{ kind: 'spawn', sessionId: 'w-scopeq-1', playbook: 'scopereq', stage: 'a' }];
  const projection = proj(scopereqEvents);
  const isLive = isLiveFromEvents(scopereqEvents);
  // Transitioning a -> b: the constraint that applies is b's (subscribe:true), not a's.
  const res = allowed(decide({
    toolName: 'send_prompt', args: { sessionId: 'w-scopeq-1', text: 'go', stage: 'b' }, projection, playbooks: pbs(scope), isLive,
  }));
  assert.equal(res.patchedArgs.subscribe, true, "`require` must come from the RESULTING stage 'b'");
  // And supplying a's value explicitly now conflicts with b's constraint.
  refusal(decide({
    toolName: 'send_prompt', args: { sessionId: 'w-scopeq-1', text: 'go', stage: 'b', subscribe: false },
    projection, playbooks: pbs(scope), isLive,
  }), 'ARG_PIN_CONFLICT');
});

// ── definition drift (settled: definitions are NOT pinned to a live run) ────

test('a live worker whose stage vanished gets STAGE_UNKNOWN that says the DEFINITION changed', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-drift-01', playbook: 'gatelab', stage: 'gone' }];
  const res = refusal(d('send_prompt', { sessionId: 'w-drift-01', text: 'hi', stage: 'gone' }, events), 'STAGE_UNKNOWN');
  assert.match(res.reason, /no longer exists in playbook 'gatelab'/);
  assert.match(res.reason, /the definition was edited while this worker was live/);
  assert.match(res.reason, /not a problem with your call/);
  // The recovery list is the graph's own stage set, read rather than restated.
  assert.match(res.reason, new RegExp(`Stages now: ${Object.keys(GATELAB_PB.stages).join(', ')}`));
});

test('a live worker whose whole playbook vanished gets PLAYBOOK_UNKNOWN saying the same', () => {
  const events = [{ kind: 'spawn', sessionId: 'w-drift-02', playbook: 'deleted-pb', stage: 'plan' }];
  const res = refusal(d('send_prompt', { sessionId: 'w-drift-02', text: 'hi', stage: 'plan' }, events), 'PLAYBOOK_UNKNOWN');
  assert.match(res.reason, /no longer loaded/);
  assert.match(res.reason, /not pinned/);
});

// ── refusals carry the legal moves ─────────────────────────────────────────

test('every refusal carries the playbook, the stage, and the legal transitions from here', () => {
  // `draft` both denies a tool and has an outgoing edge, so the transitions list
  // is non-empty — an empty one would pass a mutant that always returned [].
  const events = [{ kind: 'spawn', sessionId: 'w-drafter-1', playbook: 'gatelab', stage: 'draft' }];
  const res = refusal(d('set_mode', { sessionId: 'w-drafter-1', mode: 'ask' }, events), 'TOOL_DENIED_IN_STAGE');
  assert.equal(res.legalMoves.playbook, 'gatelab');
  assert.equal(res.legalMoves.stage, 'draft');
  assert.deepEqual(res.legalMoves.transitions, [{ to: 'build', via: 'approve_plan' }]);
});

// ── the forward SOURCE is a second policy subject ───────────────────────────
//
// `send_prompt({forward:{sessionId}})` READS the source worker's recent output
// (selectRecentMessages — the same selection get_recent_messages returns), so
// the source is checked against ITS OWN current stage's policy for
// `get_recent_messages`. Permission only: no move, no `needs`, no `pin`.
//
// No built-in denies that read, so the vocabulary can only be proven on a
// synthetic playbook — which is what makes this block the difference between the
// change and a no-op.

const GUARD = pb({
  id: 'guard', name: 'Guard', description: 'forward-source permission fixture',
  entryStages: ['open', 'vault', 'quiet', 'guarded'],
  stages: {
    open: { tools: { spawn_instance: 'allow' } },
    vault: { tools: { spawn_instance: 'allow', get_recent_messages: 'deny' } },
    quiet: { tools: { spawn_instance: 'allow', send_prompt: 'deny' } },
    guarded: { tools: { spawn_instance: 'allow', '*': 'deny' } },
    pinned: {
      tools: { spawn_instance: 'allow', get_recent_messages: { pin: { count: 3 } } },
      needs: [{ stage: 'open', liveness: 'any' }],
    },
    sink: { tools: { spawn_instance: 'allow' }, needs: [{ stage: 'open', liveness: 'any' }] },
  },
  transitions: [],
});

const GUARD_RUN = [
  { kind: 'spawn', sessionId: 'w-open-0001', playbook: 'guard', stage: 'open' },
  { kind: 'spawn', sessionId: 'w-vault-001', playbook: 'guard', stage: 'vault' },
  { kind: 'spawn', sessionId: 'w-quiet-001', playbook: 'guard', stage: 'quiet' },
  { kind: 'spawn', sessionId: 'w-guarded-1', playbook: 'guard', stage: 'guarded' },
  { kind: 'spawn', sessionId: 'w-pinned-01', playbook: 'guard', stage: 'pinned',
    provenance: { open: 'w-open-0001' } },
  { kind: 'spawn', sessionId: 'w-sink-0001', playbook: 'guard', stage: 'sink',
    provenance: { open: 'w-open-0001' } },
];

// A send to the `sink` worker (whose own stage permits everything), forwarding
// from `source` — so every refusal in this block is about the SOURCE unless the
// case deliberately changes the target.
function fwd(target, source, events = GUARD_RUN) {
  return decide({
    toolName: 'send_prompt',
    args: { sessionId: target, text: 'go', stage: 'sink', ...(source !== undefined && { forward: source }) },
    projection: proj(events),
    playbooks: pbs(GUARD),
    isLive: isLiveFromEvents(events),
  });
}

test('a forward from a stage that DENIES get_recent_messages is refused', () => {
  const res = refusal(fwd('w-sink-0001', { sessionId: 'w-vault-001' }), 'FORWARD_DENIED_IN_STAGE');
  assert.match(res.reason, /w-vault-/, 'the refusal names the SOURCE, not just the target');
  assert.match(res.reason, /vault/);
  assert.match(res.reason, /get_recent_messages/);
  assert.match(res.reason, /Drop `forward`/, 'and both ways out');
});

test('a forward from a stage that permits the read is allowed — the check is per-source, not blanket', () => {
  allowed(fwd('w-sink-0001', { sessionId: 'w-open-0001' }));
});

test('a source denial is a DIFFERENT refusal from a target denial', () => {
  // Target `quiet` denies send_prompt on itself; its source is unimpeachable.
  const target = refusal(fwd('w-quiet-001', { sessionId: 'w-open-0001' }), 'TOOL_DENIED_IN_STAGE');
  assert.ok(!target.reason.includes('w-open-0'), 'a target denial names no source');
  const source = refusal(fwd('w-sink-0001', { sessionId: 'w-vault-001' }), 'FORWARD_DENIED_IN_STAGE');
  assert.match(source.reason, /w-vault-/);
});

test('ORDERING: a TRACKED target\'s own permission answers first, even with a denied source', () => {
  // "You may not call send_prompt on this worker at all" subsumes any
  // argument-level objection, and reporting it first costs one round-trip.
  refusal(fwd('w-quiet-001', { sessionId: 'w-vault-001' }), 'TOOL_DENIED_IN_STAGE');
});

test('ORDERING: an UNTRACKED target does not exempt the source — the hole\'s sharpest form', () => {
  const res = refusal(fwd('w-nobody-tgt', { sessionId: 'w-vault-001' }), 'FORWARD_DENIED_IN_STAGE');
  assert.deepEqual(res.legalMoves, { playbook: null, stage: null, transitions: [] },
    'a stageless target refuses with the shape decideSpawn already uses');
});

test('an UNTRACKED source is ungoverned, mirroring the untracked-target rule', () => {
  allowed(fwd('w-sink-0001', { sessionId: 'w-nobody' }));
});

test('a malformed `forward` is the HANDLER\'s refusal — policy mints no argument check', () => {
  allowed(fwd('w-sink-0001', {}));
  allowed(fwd('w-sink-0001', { sessionId: 123 }));
  allowed(fwd('w-sink-0001', { sessionId: '' }));
  allowed(fwd('w-sink-0001', undefined));
});

test('definition drift on the SOURCE passes — an unresolvable stage lands where an unauthored one does', () => {
  const drifted = [
    ...GUARD_RUN,
    { kind: 'spawn', sessionId: 'w-ghost-001', playbook: 'deleted-pb', stage: 'gone' },
    { kind: 'spawn', sessionId: 'w-ghost-002', playbook: 'guard', stage: 'gone' },
  ];
  allowed(fwd('w-sink-0001', { sessionId: 'w-ghost-001' }, drifted));
  allowed(fwd('w-sink-0001', { sessionId: 'w-ghost-002' }, drifted));
});

test('a `pin` on the source\'s get_recent_messages is not a denial — only the deny/allow axis is read', () => {
  const res = allowed(fwd('w-sink-0001', { sessionId: 'w-pinned-01' }));
  assert.equal('count' in res.patchedArgs, false,
    "the source's pin must not be applied to the send_prompt call's arguments");
});

test('a "*": "deny" wildcard denies the forwarded read too', () => {
  refusal(fwd('w-sink-0001', { sessionId: 'w-guarded-1' }), 'FORWARD_DENIED_IN_STAGE');
});

// ── the shipped built-ins: the ONE claim that is genuinely about them ───────
//
// Every mechanism above rides GATELAB, so nothing here fails when the owner
// hand-edits playbooks/*.json. What still has to hold of the shipped graphs is
// that their own instructions stay legal under their own gate: relay's
// `implement` and `review` descriptions both instruct a send_prompt({forward})
// out of the planner, and solo's refine round forwards the reviewer's findings
// back. A built-in that denied `get_recent_messages` anywhere would break itself.
//
// Stated as the property rather than as three worked examples, so it covers
// every stage of every built-in — including ones added later — instead of the
// four a hand-written run happened to name. The deny/allow mechanism itself is
// exhaustively pinned on GUARD above.
test('no built-in stage denies get_recent_messages, so no built-in forward is refused by its own gate', async () => {
  const shipped = await builtins();
  let checked = 0;
  for (const playbook of shipped.values()) {
    for (const [name, stage] of Object.entries(playbook.stages)) {
      assert.notEqual(resolvePolicy(stage, 'get_recent_messages'), 'deny',
        `${playbook.id}.${name} denies get_recent_messages — a forward out of a worker in that stage ` +
        'would be refused FORWARD_DENIED_IN_STAGE, and the stage descriptions instruct exactly that forward.');
      checked++;
    }
  }
  // Guards the loop against a refactor that stopped finding stages.
  assert.ok(checked >= 4, `expected to check several stages, checked ${checked}`);
});

test('cross-run forwarding is LEGAL, deliberately', () => {
  // A DOCUMENTED LIMITATION, not a bug: "a forward source is checked for
  // permission, never for run membership" (docs/protocol.md → Playbooks → Known
  // limitations). A same-run rule would refuse the fan-out-and-synthesise
  // pattern a needs-free stage invites, recoverable only by declaring
  // `provenance` at spawn time and never retroactively. Do not "fix" this test.
  //
  // `w-open-0001` and `w-open-0002` each declare no `needs`, so each is its own
  // run root — the two workers below are genuinely in different runs.
  const twoRuns = [
    ...GUARD_RUN,
    { kind: 'spawn', sessionId: 'w-open-0002', playbook: 'guard', stage: 'open' },
    { kind: 'spawn', sessionId: 'w-sink-0002', playbook: 'guard', stage: 'sink',
      provenance: { open: 'w-open-0002' } },
  ];
  allowed(fwd('w-sink-0002', { sessionId: 'w-open-0001' }, twoRuns));
});
