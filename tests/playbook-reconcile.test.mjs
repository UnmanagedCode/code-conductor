// Boot-time orphan reconciliation — src/mcp/playbookGate.ts's reconcileOrphans(),
// chained onto the gate's memoized ensureLoaded(). Gate-level, no server: a
// stub manager exposing only what the gate touches (on/anyForSession, plus
// liveForSession for parity with the real InstanceManagerLike shape) stands in
// for the instance registry, and the ledger is hand-seeded JSONL on disk — the
// shape a previous orchestrator process would have left behind.
//
// This is the repair for card 2026-0149: a host reboot (or an orchestrator
// crash) kills the process watching for a worker's exit along with the worker
// itself, so the manager's 'status' stream never fires and a `live:true` row
// persists forever, holding its stage's `workers:"one"` slot with no worker
// left to free it. reconcileOrphans() retires any such row against the
// registry on the gate's first fold, before any caller can read the
// projection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { createPlaybookLedger, readEvents } from '../src/playbookLedger.ts';

async function tmpLedgerFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbreconcile-'));
  return { dir, file: path.join(dir, 'playbook-ledger.jsonl') };
}

async function seed(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, events.map((e, i) =>
    JSON.stringify({ seq: i + 1, ts: `2026-08-15T00:00:0${i % 10}Z`, ...e })).join('\n') + '\n');
}

// `known` is the set of sessionIds the registry still has an instance for —
// everything else reads as an orphan (anyForSession -> null).
function stubManager(known = []) {
  const knownSet = new Set(known);
  return {
    on() {}, // the gate subscribes to 'status'; nothing in these tests emits it
    liveForSession() { return null; },
    anyForSession(sessionId) { return knownSet.has(sessionId) ? { sessionId } : null; },
  };
}

function gateOver(file, instances) {
  return createPlaybookGate({ instances, ledger: createPlaybookLedger({ file: () => file }) });
}

test('reconcile: an orphan (ledger-live, registry-unknown) is retired at first fold', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'orphan-1', playbook: 'solo', stage: 'plan' }]);
    const gate = gateOver(file, stubManager([]));
    const proj = await gate.readProjection();
    assert.equal(proj.bySession.get('orphan-1').live, false,
      'a registry-unknown live row must read live:false after reconciliation');
    const events = await readEvents(file);
    const retires = events.filter(e => e.kind === 'retire' && e.sessionId === 'orphan-1');
    assert.equal(retires.length, 1, 'exactly one retire event must land on disk');
    assert.match(retires[0].reason, /orphan/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reconcile: a worker the registry still knows about is left untouched', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'known-1', playbook: 'solo', stage: 'plan' }]);
    const gate = gateOver(file, stubManager(['known-1']));
    const proj = await gate.readProjection();
    assert.equal(proj.bySession.get('known-1').live, true,
      'a worker the registry can still find must not be retired');
    assert.equal((await readEvents(file)).some(e => e.kind === 'retire'), false,
      'no retire may be written for a registry-known worker');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reconcile: a never-prompted session (no transcript anywhere) is retired all the same', async () => {
  // The point of AC3: reconciliation asks the registry only, never a
  // transcript. This test seeds no jsonl and points at no CLAUDE_PROJECTS_ROOT
  // fixture at all — there is nothing on disk a transcript reader could find —
  // and the worker must still be retired, because the check never looks.
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'never-prompted-1', playbook: 'solo', stage: 'implement' }]);
    const gate = gateOver(file, stubManager([]));
    const proj = await gate.readProjection();
    assert.equal(proj.bySession.get('never-prompted-1').live, false);
    assert.equal((await readEvents(file))
      .some(e => e.kind === 'retire' && e.sessionId === 'never-prompted-1'), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reconcile: an already-retired row is not retired again', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [
      { kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' },
      { kind: 'retire', sessionId: 'w1', reason: 'killed before reboot' },
    ]);
    const gate = gateOver(file, stubManager([]));
    const proj = await gate.readProjection();
    assert.equal(proj.bySession.get('w1').live, false);
    const retires = (await readEvents(file)).filter(e => e.kind === 'retire');
    assert.equal(retires.length, 1, 'the pre-existing retire must not be duplicated');
    assert.equal(retires[0].reason, 'killed before reboot',
      'the original retire must survive untouched — the filter on st.live must skip it, not re-retire it');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reconcile: with no instance registry at all, nothing is retired', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' }]);
    const gate = gateOver(file, null);
    const proj = await gate.readProjection();
    assert.equal(proj.bySession.get('w1').live, true,
      'with no registry to check against, a guess would be worse than the bug — do nothing');
    assert.equal((await readEvents(file)).some(e => e.kind === 'retire'), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reconcile: runs exactly once per process — a second readProjection() appends no more', async () => {
  const { dir, file } = await tmpLedgerFile();
  try {
    await seed(file, [{ kind: 'spawn', sessionId: 'orphan-1', playbook: 'solo', stage: 'plan' }]);
    const gate = gateOver(file, stubManager([]));
    await gate.readProjection();
    await gate.readProjection();
    const retires = (await readEvents(file)).filter(e => e.kind === 'retire');
    assert.equal(retires.length, 1,
      'the memoized load+reconcile promise must not re-fold and re-retire on a later call');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
