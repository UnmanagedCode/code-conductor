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
