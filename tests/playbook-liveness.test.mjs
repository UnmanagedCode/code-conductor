// The single liveness authority, end to end at the gate level — replaces
// tests/playbook-reconcile.test.mjs (deleted along with reconcileOrphans()).
//
// Where that file pinned a REPAIR (an orphaned `live:true` row gets retired at
// boot), this file pins the opposite: there is nothing to repair, because the
// ledger carries no liveness bit for anything to desync. Every case reads
// liveness from a stub InstanceManager's isSessionLive() — never from the
// projection — and every case that lands a decision asserts the ledger file
// is BYTE-IDENTICAL afterwards, so a reintroduced repair writer (an "un-retire
// on reappearance" implementation, or a revived reconcileOrphans()) fails
// here even if it happens to compute the right answer.
//
// Gate-level, no server: a stub manager exposing only what the gate touches
// (isSessionLive, plus liveForSession/anyForSession for parity with the real
// InstanceManagerLike shape) stands in for the instance registry, and the
// ledger is hand-seeded JSONL on disk — the shape a previous orchestrator
// process would have left behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { createPlaybookLedger, readEvents } from '../src/playbookLedger.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

async function tmpLedgerFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbliveness-'));
  return { dir, file: path.join(dir, 'playbook-ledger.jsonl') };
}

async function seed(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ seq: i + 1, ts: `2026-08-15T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
}

const CONDUCTOR_ID = 'conductor-1';

// `live` is the set of sessionIds the stub reports isSessionLive for — the
// ONLY liveness input the gate is allowed to read. `known` (anyForSession) is
// deliberately independent of it, so a test can prove the gate never falls
// back to the older registry lookups.
function stubManager({ live = [], known = [] } = {}) {
  const liveSet = new Set(live);
  const knownSet = new Set(known);
  const caller = { project: CONDUCT_PROJECT_NAME, playbookEnforcement: 'enforce' };
  return {
    on() {}, // the gate subscribes to 'status'; nothing in these tests emits it
    liveForSession(sessionId) { return sessionId === CONDUCTOR_ID ? caller : null; },
    anyForSession(sessionId) { return knownSet.has(sessionId) ? { sessionId } : null; },
    isSessionLive(sessionId) { return liveSet.has(sessionId); },
  };
}

function gateOver(file, instances) {
  return createPlaybookGate({ instances, ledger: createPlaybookLedger({ file: () => file }) });
}

test('a needs:@live entry is satisfied from isSessionLive() even though the ledger already holds a retire row for that worker, and the ledger is untouched', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [
      { kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' },
      { kind: 'transition', sessionId: 'w1', from: 'plan', to: 'implement', via: 'approve_plan' },
      { kind: 'retire', sessionId: 'w1', reason: 'subprocess exited' },
    ]);
    const before = await fs.readFile(file, 'utf8');
    // solo's 'review' stage needs.implement defaults to liveness:"live".
    const gate = gateOver(file, stubManager({ live: ['w1'] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'solo', stage: 'review', provenance: { implement: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome),
      `expected the spawn to be allowed; got refusal ${JSON.stringify(outcome.refusal)}`);
    assert.equal(await fs.readFile(file, 'utf8'), before,
      'check() must not write to the ledger for an allowed decision — no un-retire, no repair');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the same ledger row with isSessionLive() false is refused NEEDS_WORKER_GONE, and the refusal is the ONLY thing appended — no un-retire, no repair', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [
      { kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' },
      { kind: 'transition', sessionId: 'w1', from: 'plan', to: 'implement', via: 'approve_plan' },
      { kind: 'retire', sessionId: 'w1', reason: 'subprocess exited' },
    ]);
    const gate = gateOver(file, stubManager({ live: [] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'solo', stage: 'review', provenance: { implement: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok('refusal' in outcome, 'expected a refusal');
    assert.equal(outcome.refusal.code, 'NEEDS_WORKER_GONE');
    // The refusal IS ledgered (that is the audit trail's job), but nothing else
    // is: no second `retire`, no `resume` un-retiring the row.
    const events = await readEvents(file);
    assert.deepEqual(events.map(e => e.kind), ['spawn', 'transition', 'retire', 'refusal']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the gate asks isSessionLive, not anyForSession/liveForSession — a session the registry has otherwise lost still reads live', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [
      { kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' },
      { kind: 'transition', sessionId: 'w1', from: 'plan', to: 'implement', via: 'approve_plan' },
    ]);
    // `known: []` -> anyForSession('w1') is null, mirroring _resumingPublicIds'
    // pre-registration window. isSessionLive alone must still say live.
    const gate = gateOver(file, stubManager({ live: ['w1'], known: [] }));
    assert.equal(gate.isLive('w1'), true, 'the read surface must answer from isSessionLive alone');
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'solo', stage: 'review', provenance: { implement: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome), `expected allowed; got ${JSON.stringify(outcome.refusal)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a workers:"one" slot held by a ledger row with no retire event reads free the moment isSessionLive says so — 2026-0149\'s reboot guarantee, with no boot repair', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    // A complete relay run, NO retire anywhere: exactly what a previous
    // orchestrator process would leave behind after an unobserved host reboot.
    await seed(file, [
      { kind: 'spawn', sessionId: 'planner-1', playbook: 'relay', stage: 'plan' },
      { kind: 'spawn', sessionId: 'impl-1', playbook: 'relay', stage: 'implement', provenance: { plan: 'planner-1' } },
    ]);
    const before = await fs.readFile(file, 'utf8');
    // The new process's registry knows NOTHING from the old one.
    const gate = gateOver(file, stubManager({ live: [] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'relay', stage: 'implement', provenance: { plan: 'planner-1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome),
      `expected the slot to read free; got refusal ${JSON.stringify(outcome.refusal)}`);
    assert.equal(await fs.readFile(file, 'utf8'), before,
      'freeing the slot must cost no boot-time write — capacity counts live processes directly');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the same rebooted run still wedges the slot if the new process\'s registry claims the old worker is live', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [
      { kind: 'spawn', sessionId: 'planner-1', playbook: 'relay', stage: 'plan' },
      { kind: 'spawn', sessionId: 'impl-1', playbook: 'relay', stage: 'implement', provenance: { plan: 'planner-1' } },
    ]);
    const gate = gateOver(file, stubManager({ live: ['impl-1'] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'relay', stage: 'implement', provenance: { plan: 'planner-1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok('refusal' in outcome, 'the slot must still be held while the oracle says the occupant is live');
    assert.equal(outcome.refusal.code, 'STAGE_AT_CAPACITY');
    assert.match(outcome.refusal.reason, /impl-1/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('two readProjection() calls append nothing — the load stays read-only', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' }]);
    const before = await fs.readFile(file, 'utf8');
    const gate = gateOver(file, stubManager({ live: ['w1'] }));
    await gate.readProjection();
    await gate.readProjection();
    assert.equal(await fs.readFile(file, 'utf8'), before, 'no reintroduced repair writer runs on load');
    assert.equal((await readEvents(file)).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
