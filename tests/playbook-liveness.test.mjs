// The single liveness authority, end to end at the gate level — replaces
// tests/playbook-reconcile.test.mjs (deleted along with reconcileOrphans()).
//
// Where that file pinned a REPAIR (an orphaned `live:true` row gets retired at
// boot), this file pins the opposite: there is nothing to repair, because the
// event log carries no liveness bit for anything to desync. Every case reads
// liveness from a stub InstanceManager's isSessionLive() — never from the
// projection — and every case that lands a decision asserts the log file
// is BYTE-IDENTICAL afterwards, so a reintroduced repair writer (an "un-retire
// on reappearance" implementation, or a revived reconcileOrphans()) fails
// here even if it happens to compute the right answer.
//
// Gate-level, no server: a stub manager exposing only what the gate touches
// (isSessionLive, plus liveForSession/anyForSession for parity with the real
// InstanceManagerLike shape) stands in for the instance registry, and the
// event log is hand-seeded JSONL on disk — the shape a previous orchestrator
// process would have left behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { readEventLog } from '../src/eventLog.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { GATELAB, OPEN_LEASE, bindRow, moveRow, exitRow } from './playbook-fixtures.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// The gate loads real definitions, so the graph these cases drive has to exist
// on disk. It is installed into a per-FILE user-overlay store rather than read
// from playbooks/*.json: the shipped graphs are hand-editable by their owner, and
// every case below turns on a stage's `needs`, `workers` or liveness value.
// PROJECTS_ROOT is read live by orchStoreRoot(), and node:test runs each file in
// its own process, so this is scoped to this file alone. The user overlay is read
// per call (docs/protocol.md → Playbooks), so no cache has to be primed.
process.env.PROJECTS_ROOT = await mkdtemp('cc-pbliveness-root-');
{
  const dir = path.join(orchStoreRoot(), 'playbooks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'gatelab.json'), JSON.stringify(GATELAB));
}

async function tmpLogFile() {
  const dir = await mkdtemp('cc-pbliveness-');
  return { dir, file: path.join(dir, 'events.jsonl') };
}

async function seed(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ v: 1, ts: `2026-08-15T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
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
    on() {}, // the recorder subscribes to the session stream; nothing here emits it
    emit() {}, // the gate emits 'playbook_changed' after a bind/move fold
    liveForSession(sessionId) { return sessionId === CONDUCTOR_ID ? caller : null; },
    anyForSession(sessionId) { return knownSet.has(sessionId) ? { sessionId } : null; },
    isSessionLive(sessionId) { return liveSet.has(sessionId); },
  };
}

function gateOver(file, instances) {
  return createPlaybookGate({ instances, lease: OPEN_LEASE, file: () => file });
}

test('a needs:@live entry is satisfied from isSessionLive() even though the log already holds an exit row for that worker, and the log is untouched', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [
      bindRow('w1', 'gatelab', 'draft'),
      moveRow('w1', 'draft', 'build', { tool: 'approve_plan' }),
      exitRow('w1'),
    ]);
    const before = await fs.readFile(file, 'utf8');
    // gatelab's 'audit' stage needs.build defaults to liveness:"live".
    const gate = gateOver(file, stubManager({ live: ['w1'] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome),
      `expected the spawn to be allowed; got refusal ${JSON.stringify(outcome.refusal)}`);
    assert.equal(await fs.readFile(file, 'utf8'), before,
      'check() must not write to the log for an allowed decision — no un-retire, no repair');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the same log rows with isSessionLive() false is refused NEEDS_WORKER_GONE, and the refusal is the ONLY thing appended — no un-retire, no repair', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [
      bindRow('w1', 'gatelab', 'draft'),
      moveRow('w1', 'draft', 'build', { tool: 'approve_plan' }),
      exitRow('w1'),
    ]);
    const gate = gateOver(file, stubManager({ live: [] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok('refusal' in outcome, 'expected a refusal');
    assert.equal(outcome.refusal.code, 'NEEDS_WORKER_GONE');
    // The refusal IS logged (that is the audit trail's job), but nothing else
    // is: no second exit, no resume un-retiring the worker.
    const events = await readEventLog(file);
    assert.deepEqual(events.map(e => [e.kind, e.outcome ?? e.event]), [['call', 'ok'], ['call', 'ok'], ['session', 'exit'], ['call', 'refused']]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the gate asks isSessionLive, not anyForSession/liveForSession — a session the registry has otherwise lost still reads live', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [
      bindRow('w1', 'gatelab', 'draft'),
      moveRow('w1', 'draft', 'build', { tool: 'approve_plan' }),
    ]);
    // `known: []` -> anyForSession('w1') is null, mirroring _resumingPublicIds'
    // pre-registration window. isSessionLive alone must still say live.
    const gate = gateOver(file, stubManager({ live: ['w1'], known: [] }));
    assert.equal(gate.isLive('w1'), true, 'the read surface must answer from isSessionLive alone');
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'gatelab', stage: 'audit', provenance: { build: 'w1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome), `expected allowed; got ${JSON.stringify(outcome.refusal)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a workers:"one" slot held by a bind row with no exit row reads free the moment isSessionLive says so — 2026-0149\'s reboot guarantee, with no boot repair', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    // A complete run, NO retire anywhere: exactly what a previous orchestrator
    // process would leave behind after an unobserved host reboot. `handoff`
    // declares no `workers`, so it is the default "one".
    await seed(file, [
      bindRow('planner-1', 'gatelab', 'sealed'),
      bindRow('impl-1', 'gatelab', 'handoff', { provenance: { sealed: 'planner-1' } }),
    ]);
    const before = await fs.readFile(file, 'utf8');
    // The new process's registry knows NOTHING from the old one.
    const gate = gateOver(file, stubManager({ live: [] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'gatelab', stage: 'handoff', provenance: { sealed: 'planner-1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok(!('refusal' in outcome),
      `expected the slot to read free; got refusal ${JSON.stringify(outcome.refusal)}`);
    assert.equal(await fs.readFile(file, 'utf8'), before,
      'freeing the slot must cost no boot-time write — capacity counts live processes directly');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the same rebooted run still wedges the slot if the new process\'s registry claims the old worker is live', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [
      bindRow('planner-1', 'gatelab', 'sealed'),
      bindRow('impl-1', 'gatelab', 'handoff', { provenance: { sealed: 'planner-1' } }),
    ]);
    const gate = gateOver(file, stubManager({ live: ['impl-1'] }));
    const outcome = await gate.check({
      toolName: 'spawn_instance',
      args: { playbook: 'gatelab', stage: 'handoff', provenance: { sealed: 'planner-1' } },
      callerId: CONDUCTOR_ID,
    });
    assert.ok('refusal' in outcome, 'the slot must still be held while the oracle says the occupant is live');
    assert.equal(outcome.refusal.code, 'STAGE_AT_CAPACITY');
    assert.match(outcome.refusal.reason, /impl-1/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readLiveWorkers lists exactly the workers bound to that playbook that isSessionLive reports live', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [
      bindRow('w1', 'gatelab', 'draft'),
      bindRow('w2', 'gatelab', 'draft'),
      bindRow('w3', 'other', 'draft'),
    ]);
    const gate = gateOver(file, stubManager({ live: ['w1', 'w3'], known: ['w2'] }));
    assert.deepEqual(await gate.readLiveWorkers('gatelab'), ['w1']);
    assert.deepEqual(await gate.readLiveWorkers('other'), ['w3']);
    assert.deepEqual(await gate.readLiveWorkers('absent'), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// A directory at the log path: readFile fails EISDIR, a non-ENOENT load
// failure (a malformed LINE would only be skipped, never thrown).
test('readLiveWorkers propagates a log load failure rather than answering []', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await fs.mkdir(file, { recursive: true });
    const gate = gateOver(file, stubManager({ live: ['w1'] }));
    await assert.rejects(() => gate.readLiveWorkers('gatelab'), /EISDIR/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('two readProjection() calls append nothing — the load stays read-only', async () => {
  const { dir, file } = await tmpLogFile();
  try {
    await seed(file, [bindRow('w1', 'gatelab', 'draft')]);
    const before = await fs.readFile(file, 'utf8');
    const gate = gateOver(file, stubManager({ live: ['w1'] }));
    await gate.readProjection();
    await gate.readProjection();
    assert.equal(await fs.readFile(file, 'utf8'), before, 'no reintroduced repair writer runs on load');
    assert.equal((await readEventLog(file)).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
