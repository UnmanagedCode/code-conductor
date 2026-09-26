// commitMove's spawn arm, at the gate level — the ledger WRITE that follows an
// allowed decision, isolated from how the caller spelled the sessionId.
//
// The invariant: a `spawn` event never overwrites an existing binding. It is
// enforced at the one place holding the authoritative id (the handler's RESULT),
// because that is the only value that is right regardless of what the decision
// layer was handed. applyEvent's spawn arm folds unconditionally — a stray one
// resets `stage`, `stageHistory` and `provenance`, erasing the history every
// downstream `needs` is answered from.
//
// Gate-level rather than end to end, deliberately: the decision layer must be
// able to hand commitMove a `spawn` move for an already-bound session (that is
// the divergence this backstop exists for), and only calling check()/commit()
// directly can produce that pairing on demand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { createPlaybookLedger, readEvents, foldProjection } from '../src/playbookLedger.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { GATELAB } from './playbook-fixtures.mjs';

// The gate loads real definitions, so the graph has to exist on disk. Per-FILE
// user-overlay store (node:test forks a process per file), never the shipped
// playbooks/*.json — those are hand-editable by their owner.
process.env.PROJECTS_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbcommit-root-'));
{
  const dir = path.join(orchStoreRoot(), 'playbooks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'gatelab.json'), JSON.stringify(GATELAB));
}

const CONDUCTOR_ID = 'conductor-1';

// Only what the gate touches. No liveness cases here, so isSessionLive is a
// constant — `loose` is ungated, which is why it is the stage these cases enter.
function stubManager() {
  const caller = { project: CONDUCT_PROJECT_NAME, playbookEnforcement: 'enforce' };
  return {
    on() {},
    emit() {},
    liveForSession(sessionId) { return sessionId === CONDUCTOR_ID ? caller : null; },
    anyForSession() { return null; },
    isSessionLive() { return false; },
  };
}

async function tmpLedger(events) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbcommit-'));
  const file = path.join(dir, 'playbook-ledger.jsonl');
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ seq: i + 1, ts: `2026-09-06T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
  return { dir, file, gate: createPlaybookGate({ instances: stubManager(), ledger: createPlaybookLedger({ file: () => file }) }) };
}

// A worker with a HISTORY, so "the binding survived" is a real claim: a stray
// spawn would truncate stageHistory to one entry even if it named the same stage.
const BOUND = [
  { kind: 'spawn', sessionId: 'w1', playbook: 'gatelab', stage: 'draft' },
  { kind: 'transition', sessionId: 'w1', from: 'draft', to: 'build', via: 'approve_plan' },
];

// The decision the two cases below share: a call the policy layer classifies as
// a FRESH spawn into `loose` — an id it cannot place, plus an explicit binding.
// That is precisely the pairing the backstop has to survive.
async function spawnDecision(gate) {
  const outcome = await gate.check({
    toolName: 'spawn_instance',
    args: { resume: 'an-id-the-ledger-cannot-place', playbook: 'gatelab', stage: 'loose' },
    callerId: CONDUCTOR_ID,
  });
  assert.ok(!('refusal' in outcome),
    `premise: the decision layer must classify this as an allowed spawn; got ${JSON.stringify(outcome.refusal)}`);
  assert.ok(typeof outcome.commit === 'function', 'premise: an allowed spawn carries a commit');
  return outcome;
}

test('a `spawn` move whose RESULT names an already-bound session is ledgered as a `resume`', async () => {
  const { dir, file, gate } = await tmpLedger(BOUND);
  try {
    const outcome = await spawnDecision(gate);
    // The handler came back with a session the ledger already holds — the
    // divergence: the id the caller passed was unplaceable, the id that came
    // back is bound.
    await outcome.commit({ sessionId: 'w1', project: 'demo' });

    const evs = await readEvents(file);
    assert.deepEqual(evs.map(e => e.kind), ['spawn', 'transition', 'resume'],
      'the append must be a resume, not a second spawn');
    assert.equal(evs.filter(e => e.kind === 'spawn' && e.sessionId === 'w1').length, 1);
    const st = foldProjection(evs).bySession.get('w1');
    assert.deepEqual(
      { playbook: st.playbook, stage: st.stage, history: st.stageHistory },
      { playbook: 'gatelab', stage: 'build', history: ['draft', 'build'] },
      'stage, stageHistory and playbook are all untouched');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the same `spawn` move whose RESULT names an UNBOUND session still writes a real `spawn`', async () => {
  // The control. Without it, "always append a resume" passes the case above and
  // silently stops recording new bindings altogether.
  const { dir, file, gate } = await tmpLedger(BOUND);
  try {
    const outcome = await spawnDecision(gate);
    await outcome.commit({ sessionId: 'w2', project: 'demo' });

    const evs = await readEvents(file);
    assert.deepEqual(evs.map(e => e.kind), ['spawn', 'transition', 'spawn']);
    const st = foldProjection(evs).bySession.get('w2');
    assert.deepEqual(
      { playbook: st.playbook, stage: st.stage, history: st.stageHistory, project: st.project },
      { playbook: 'gatelab', stage: 'loose', history: ['loose'], project: 'demo' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── playbook_changed: emitted after the fold, only for spawn/transition ────
//
// `emit` records, per call, whether the projection ALREADY holds the new stage
// at the moment of the emit — the claim that matters is ordering (fold before
// notify), not merely that an event fires.

function stubManagerRecording({ live = [] } = {}) {
  const caller = { project: CONDUCT_PROJECT_NAME, playbookEnforcement: 'enforce' };
  const liveSet = new Set(live);
  const emitted = [];
  const mgr = {
    gate: null, // set by the caller once the gate built over this manager exists
    emitted,
    on() {},
    liveForSession(sessionId) { return sessionId === CONDUCTOR_ID ? caller : null; },
    anyForSession() { return null; },
    isSessionLive(sessionId) { return liveSet.has(sessionId); },
    emit(event, arg) {
      emitted.push({
        event,
        arg,
        stageAtEmit: event === 'playbook_changed'
          ? mgr.gate?.ledger().projection().bySession.get(arg.sessionId)?.stage
          : undefined,
      });
    },
  };
  return mgr;
}

async function tmpLedgerRecording(events, { live } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbcommit-'));
  const file = path.join(dir, 'playbook-ledger.jsonl');
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ seq: i + 1, ts: `2026-09-06T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
  const instances = stubManagerRecording({ live });
  const gate = createPlaybookGate({ instances, ledger: createPlaybookLedger({ file: () => file }) });
  instances.gate = gate;
  return { dir, file, gate, emitted: instances.emitted };
}

test('a committed spawn emits exactly one playbook_changed, AFTER the projection already holds the new stage', async () => {
  const { dir, gate, emitted } = await tmpLedgerRecording(BOUND);
  try {
    const outcome = await spawnDecision(gate);
    await outcome.commit({ sessionId: 'w2', project: 'demo' });

    const changes = emitted.filter(e => e.event === 'playbook_changed');
    assert.equal(changes.length, 1, 'exactly one playbook_changed for the spawn');
    assert.deepEqual(changes[0].arg, { sessionId: 'w2' });
    assert.equal(changes[0].stageAtEmit, 'loose',
      'the emit follows the fold — the new binding is already readable when it fires');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a committed transition emits exactly one playbook_changed, with the new stage already folded', async () => {
  const { dir, gate, emitted } = await tmpLedgerRecording(
    [{ kind: 'spawn', sessionId: 'w1', playbook: 'gatelab', stage: 'draft' }],
    { live: ['w1'] },
  );
  try {
    const outcome = await gate.check({
      toolName: 'approve_plan', args: { sessionId: 'w1' }, callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome),
      `premise: approve_plan must be legal from draft; got ${JSON.stringify(outcome.refusal)}`);
    await outcome.commit({});

    const changes = emitted.filter(e => e.event === 'playbook_changed');
    assert.equal(changes.length, 1, 'exactly one playbook_changed for the transition');
    assert.deepEqual(changes[0].arg, { sessionId: 'w1' });
    assert.equal(changes[0].stageAtEmit, 'build',
      'the emit follows the fold — the destination stage is already readable when it fires');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the spawn->resume backstop and a refusal both emit no playbook_changed', async () => {
  const { dir, gate, emitted } = await tmpLedgerRecording(BOUND);
  try {
    // Backstop: a `spawn` move whose RESULT names an already-bound session is
    // ledgered as a `resume`, not a `spawn` — no binding actually changed.
    const outcome = await spawnDecision(gate);
    await outcome.commit({ sessionId: 'w1', project: 'demo' });
    assert.equal(emitted.filter(e => e.event === 'playbook_changed').length, 0,
      'a resume must not emit — nothing about the binding moved');

    // A refusal: PLAYBOOK_UNKNOWN, recorded but nothing folds.
    const refused = await gate.check({
      toolName: 'spawn_instance', args: { project: 'demo', mode: 'plan' }, callerId: CONDUCTOR_ID,
    });
    assert.ok('refusal' in refused, `premise: this spawn must be refused; got ${JSON.stringify(refused)}`);
    assert.equal(emitted.filter(e => e.event === 'playbook_changed').length, 0,
      'a refusal must not emit either — the ledger row it writes is a `refusal`, not a binding change');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('two CONCURRENT commits naming the same session write one `spawn` and one `resume`', async () => {
  // INVARIANT: the "already bound?" question is answered INSIDE the serialized
  // append chain, not before it. Asked outside, two commits racing on one
  // sessionId both read "unbound" and both append a `spawn` — and the second one
  // resets the binding the first just created, which is the exact corruption the
  // backstop exists to make impossible.
  const { dir, file, gate } = await tmpLedger(BOUND);
  try {
    const a = await spawnDecision(gate);
    const b = await spawnDecision(gate);
    // Invoked in the same tick, so neither can observe the other's append unless
    // the check is chained behind it.
    await Promise.all([a.commit({ sessionId: 'w2', project: 'demo' }), b.commit({ sessionId: 'w2', project: 'demo' })]);

    const evs = await readEvents(file);
    assert.deepEqual(evs.map(e => e.kind), ['spawn', 'transition', 'spawn', 'resume'],
      'the second commit must fold as a resume, not a second spawn');
    const st = foldProjection(evs).bySession.get('w2');
    assert.deepEqual({ stage: st.stage, history: st.stageHistory }, { stage: 'loose', history: ['loose'] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── forwardSessionId on transition rows ────────────────────────────────────
//
// A ledgered `transition` — a real move or a declared self-loop — records the
// send_prompt forward source it was handed, so the audit trail shows whose
// output crossed the move. The source id appears nowhere else in the run, so no
// row can carry it by copying `sessionId` or a `provenance` value. `appended`
// holds every argument handed to append(): JSON drops an `undefined` key, so only
// the argument can tell "omitted" from "written as undefined".

const RUN = [
  { kind: 'spawn', sessionId: 'w1', playbook: 'gatelab', stage: 'draft' },
  { kind: 'transition', sessionId: 'w1', from: 'draft', to: 'build', via: 'approve_plan' },
  { kind: 'spawn', sessionId: 'a1', playbook: 'gatelab', stage: 'audit', provenance: { build: 'w1' } },
];
const IN_AMEND = [...RUN,
  { kind: 'transition', sessionId: 'w1', from: 'build', to: 'amend', via: 'send_prompt', provenance: { audit: 'a1' } }];
const FORWARD_SOURCE = 'planner-1';

async function tmpLedgerAppends(events) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbcommit-'));
  const file = path.join(dir, 'playbook-ledger.jsonl');
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ seq: i + 1, ts: `2026-09-06T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
  const real = createPlaybookLedger({ file: () => file });
  const appended = [];
  const ledger = { ...real, append(ev) { appended.push(ev); return real.append(ev); } };
  const gate = createPlaybookGate({ instances: stubManagerRecording({ live: ['w1', 'a1'] }), ledger });
  return { dir, file, gate, appended };
}

async function sendPromptCommitted(gate, args) {
  const outcome = await gate.check({ toolName: 'send_prompt', args, callerId: CONDUCTOR_ID });
  assert.ok(!('refusal' in outcome), `premise: this send_prompt must be allowed; got ${JSON.stringify(outcome.refusal)}`);
  assert.ok(typeof outcome.commit === 'function', 'premise: an allowed send_prompt carries a commit');
  await outcome.commit({});
}

async function lastRow(file) {
  const { seq, ts, ...row } = (await readEvents(file)).at(-1);
  return row;
}

test('a real transition records the forward source as forwardSessionId', async () => {
  const { dir, file, gate } = await tmpLedgerAppends(RUN);
  try {
    await sendPromptCommitted(gate, {
      sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' }, forward: { sessionId: FORWARD_SOURCE },
    });
    assert.deepEqual(await lastRow(file), {
      kind: 'transition', sessionId: 'w1', from: 'build', to: 'amend', via: 'send_prompt',
      provenance: { audit: 'a1' }, forwardSessionId: FORWARD_SOURCE,
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a declared self-loop records the forward source as forwardSessionId', async () => {
  const { dir, file, gate } = await tmpLedgerAppends(IN_AMEND);
  try {
    await sendPromptCommitted(gate, {
      sessionId: 'w1', text: 'round 2', stage: 'amend', forward: { sessionId: FORWARD_SOURCE },
    });
    assert.deepEqual(await lastRow(file), {
      kind: 'transition', sessionId: 'w1', from: 'amend', to: 'amend', via: 'send_prompt',
      forwardSessionId: FORWARD_SOURCE,
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a transition without a forward omits forwardSessionId — the key, not just its value', async (t) => {
  const arms = [
    { name: 'real move', seed: RUN, args: { sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' } }, from: 'build' },
    { name: 'declared self-loop', seed: IN_AMEND, args: { sessionId: 'w1', text: 'round 2', stage: 'amend' }, from: 'amend' },
  ];
  for (const arm of arms) {
    await t.test(arm.name, async () => {
      const { dir, file, gate, appended } = await tmpLedgerAppends(arm.seed);
      try {
        await sendPromptCommitted(gate, arm.args);
        const row = appended.find(e => e.kind === 'transition');
        assert.ok(row, 'premise: the move was ledgered');
        assert.deepEqual({ from: row.from, to: row.to }, { from: arm.from, to: 'amend' }, 'premise: the intended arm ran');
        assert.equal(Object.hasOwn(row, 'forwardSessionId'), false, 'append() must not be handed the key at all');
        assert.equal(Object.hasOwn(await lastRow(file), 'forwardSessionId'), false);
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    });
  }
});

test('an undeclared self-edge with a forward is still not ledgered', async () => {
  // INVARIANT: carrying a forward does not make an undeclared self-edge worth a
  // row — `build` declares no build->build.
  const { dir, gate, appended } = await tmpLedgerAppends(RUN);
  try {
    await sendPromptCommitted(gate, { sessionId: 'w1', text: 'x', stage: 'build', forward: { sessionId: FORWARD_SOURCE } });
    assert.equal(appended.length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
