// The worker-tools check at the gate (src/mcp/playbookGate.ts → checkWorkerTool):
// a bound worker's OWN tool call against its stage's `workerTools`, read
// live per call, at the level of the conductor that owns it.
//
// PINS:
//   * unbound, or bound with no matching pattern → pass, no row;
//   * enforce → deny with the reason + exactly one `refused` row by the worker;
//   * warn → pass + the same row + one `playbook_warn` bubble on the owner;
//   * liveness: a `move` row or an edit to the definition changes the NEXT answer;
//   * level: the live owner conductor, else the projection's folded level for
//     the owner, else the Settings default;
//   * fail open: a binding whose playbook/stage is no longer loaded, or a log
//     that cannot load, passes with a warning (once per binding for drift).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { readEventLog } from '../src/eventLog.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { setDefaultPlaybookEnforcement } from '../src/conductorConventions.ts';
import { WORKER_TOOL_DENIED_IN_STAGE, workerToolDeniedReason } from '../src/playbooks.ts';
import { OPEN_LEASE, bindRow, moveRow } from './playbook-fixtures.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// `write` lets the worker do anything; `review` denies Edit and every kanban
// MCP tool; `locked` denies everything but Read.
const WTLAB = {
  id: 'wtlab', name: 'Wtlab', description: 'Test-only: stage-scoped worker tool denial.',
  entryStages: ['write'],
  stages: {
    write: { description: 'Anything goes.', tools: { spawn_instance: 'allow' } },
    review: { description: 'Read only.', workerTools: { Edit: 'deny', 'mcp__code-conductor__code-kanban__*': 'deny' } },
    locked: { description: 'Allow-list.', workerTools: { '*': 'deny', Read: 'allow' } },
  },
  transitions: [{ from: 'write', to: 'review' }, { from: 'write', to: 'locked' }],
};

process.env.PROJECTS_ROOT = await mkdtemp('cc-pbworkertools-root-');
const overlay = path.join(orchStoreRoot(), 'playbooks');
await fs.mkdir(overlay, { recursive: true });
const writeLab = (def) => fs.writeFile(path.join(overlay, 'wtlab.json'), JSON.stringify(def));
await writeLab(WTLAB);

const OWNER = 'conductor-owner';

// Only what the gate touches. `conductors` maps a live conductor's sessionId to
// its enforcement level; each records the UI events it was handed.
function stubManager(conductors = {}) {
  const live = new Map(Object.entries(conductors).map(([sid, mode]) => [sid, {
    project: CONDUCT_PROJECT_NAME, playbookEnforcement: mode, ui: [], _emitUi(ev) { this.ui.push(ev); },
  }]));
  return {
    on() {},
    emit() {},
    liveForSession: (sid) => live.get(sid) ?? null,
    isSessionLive: (sid) => live.has(sid),
    conductor: (sid) => live.get(sid),
  };
}

// A gate over a temp log seeded with `seed` rows.
async function rig(seed, conductors) {
  const dir = await mkdtemp('cc-pbworkertools-');
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, seed.map((r, i) => JSON.stringify({ v: 1, ts: `2026-11-10T00:00:0${i % 10}Z`, ...r })).join('\n') + '\n');
  const instances = stubManager(conductors);
  const gate = createPlaybookGate({ instances, lease: OPEN_LEASE, file: () => file });
  const rows = async () => (await readEventLog(file)).slice(seed.length).map(({ v, ts, ...r }) => r);
  const ask = (sessionId, toolName, ownerSessionId = OWNER) => gate.checkWorkerTool({ sessionId, ownerSessionId, toolName });
  return { gate, rows, ask, instances };
}

const IN_WRITE = [bindRow('w1', 'wtlab', 'write')];
const IN_REVIEW = [...IN_WRITE, moveRow('w1', 'write', 'review')];
const configRow = (sid, to) => ({ kind: 'config', actor: { type: 'system' }, subject: sid, key: 'enforcement', to });
const editReason = workerToolDeniedReason({ playbook: 'wtlab', stage: 'review', toolName: 'Edit', key: 'Edit' });

// Captures console.warn for the duration of `fn`.
async function warnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => { seen.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = orig; }
  return seen;
}

test('an unbound session passes and writes no row', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w-unbound', 'Edit'), { deny: null });
  assert.deepEqual(await r.rows(), []);
});

test('a bound worker whose stage matches no pattern passes and writes no row', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w1', 'Read'), { deny: null });
  assert.deepEqual(await r.ask('w1', 'NotebookEdit'), { deny: null });
  assert.deepEqual(await r.rows(), []);
});

test('enforce: a denied call is refused with the reason and exactly one refused row by the worker', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: editReason });
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: { type: 'worker', sessionId: 'w1' }, subject: 'w1', tool: 'Edit', outcome: 'refused',
    refusal: { code: WORKER_TOOL_DENIED_IN_STAGE, reason: editReason },
  }]);
  assert.deepEqual(r.instances.conductor(OWNER).ui, [], 'enforce raises no bubble');
});

test('the raw MCP tool name is matched and recorded', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  const tool = 'mcp__code-conductor__code-kanban__move_card';
  const out = await r.ask('w1', tool);
  assert.equal(out.deny, workerToolDeniedReason({ playbook: 'wtlab', stage: 'review', toolName: tool, key: 'mcp__code-conductor__code-kanban__*' }));
  assert.deepEqual((await r.rows()).map(x => x.tool), [tool]);
});

test('warn: the call passes, with the same row and one playbook_warn bubble on the owner', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'warn' });
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null });
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: { type: 'worker', sessionId: 'w1' }, subject: 'w1', tool: 'Edit', outcome: 'refused',
    refusal: { code: WORKER_TOOL_DENIED_IN_STAGE, reason: editReason },
  }]);
  assert.deepEqual(r.instances.conductor(OWNER).ui, [{
    kind: 'system', subtype: 'playbook_warn',
    data: { tool: 'Edit', code: WORKER_TOOL_DENIED_IN_STAGE, reason: editReason, sessionId: 'w1' },
  }]);
});

test('an allow-list stage: "*" deny refuses naming \'*\', its allowed entry and the exempt tools pass', async () => {
  const r = await rig([...IN_WRITE, moveRow('w1', 'write', 'locked')], { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w1', 'Edit'),
    { deny: workerToolDeniedReason({ playbook: 'wtlab', stage: 'locked', toolName: 'Edit', key: '*' }) });
  assert.deepEqual(await r.ask('w1', 'Read'), { deny: null });
  assert.deepEqual(await r.ask('w1', 'AskUserQuestion'), { deny: null });
  assert.deepEqual(await r.ask('w1', 'ExitPlanMode'), { deny: null });
  assert.deepEqual((await r.rows()).map(x => x.tool), ['Edit'], 'only the denied call wrote a row');
});

test('a move appended to the log changes the very next answer', async () => {
  const r = await rig(IN_WRITE, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null }, 'write denies nothing');
  await r.gate.eventLog().append(moveRow('w1', 'write', 'review'));
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: editReason }, 'review denies Edit');
});

test('an edit to the definition changes the very next answer, with no restart', async (t) => {
  t.after(() => writeLab(WTLAB));
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.ask('w1', 'Bash'), { deny: null });
  await writeLab({ ...WTLAB, stages: { ...WTLAB.stages, review: { ...WTLAB.stages.review, workerTools: { Bash: 'deny' } } } });
  assert.equal(typeof (await r.ask('w1', 'Bash')).deny, 'string', 'Bash is now denied');
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null }, 'and Edit no longer is');
});

test('level: the live owner conductor beats the projection', async () => {
  const r = await rig([...IN_REVIEW, configRow(OWNER, 'enforce')], { [OWNER]: 'warn' });
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null });
});

test('level: with no live owner, the projection\'s folded level for the owner beats the Settings default', async () => {
  await setDefaultPlaybookEnforcement('enforce');
  const warned = await rig([...IN_REVIEW, configRow(OWNER, 'warn')], {});
  assert.deepEqual(await warned.ask('w1', 'Edit'), { deny: null });
  assert.equal((await warned.rows()).length, 1, 'warn still records the row');
  await setDefaultPlaybookEnforcement('warn');
  const enforced = await rig([...IN_REVIEW, configRow(OWNER, 'enforce')], {});
  assert.deepEqual(await enforced.ask('w1', 'Edit'), { deny: editReason });
});

test('level: with neither a live owner nor a folded level, the Settings default decides', async (t) => {
  t.after(() => setDefaultPlaybookEnforcement('enforce'));
  await setDefaultPlaybookEnforcement('warn');
  const r = await rig(IN_REVIEW, {});
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null });
  assert.deepEqual(await r.ask('w1', 'Edit', null), { deny: null }, 'no owner at all');
  await setDefaultPlaybookEnforcement('enforce');
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: editReason });
  assert.deepEqual(await r.ask('w1', 'Edit', null), { deny: editReason });
});

test('a live owner that is not a conductor is skipped for the level', async () => {
  const r = await rig([...IN_REVIEW, configRow(OWNER, 'warn')], {});
  r.instances.liveForSession = (sid) => (sid === OWNER ? { project: 'not-conduct', playbookEnforcement: 'enforce', _emitUi() {} } : null);
  assert.deepEqual(await r.ask('w1', 'Edit'), { deny: null }, 'the folded warn applies');
});

test('drift: a binding whose stage or playbook is no longer loaded passes, warning once per binding', async () => {
  const r = await rig([bindRow('w-gone-pb', 'no-such-playbook', 'x')], { [OWNER]: 'enforce' });
  const stageRig = await rig([bindRow('w-gone-stage-2', 'wtlab', 'deleted-stage')], { [OWNER]: 'enforce' });
  const seen = await warnings(async () => {
    assert.deepEqual(await r.ask('w-gone-pb', 'Edit'), { deny: null });
    assert.deepEqual(await r.ask('w-gone-pb', 'Edit'), { deny: null });
    assert.deepEqual(await stageRig.ask('w-gone-stage-2', 'Edit'), { deny: null });
    assert.deepEqual(await stageRig.ask('w-gone-stage-2', 'Edit'), { deny: null });
  });
  assert.equal(seen.filter(m => m.includes('no-such-playbook')).length, 1, `one warning for the missing playbook: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter(m => m.includes('deleted-stage')).length, 1, `one warning for the missing stage: ${JSON.stringify(seen)}`);
  assert.deepEqual(await r.rows(), []);
  assert.deepEqual(await stageRig.rows(), []);
});

// PINS: a recorded stage is looked up among the definition's OWN stages, so a
// stage named like an Object.prototype member that the definition no longer
// has is drift (one warning), not an inherited function.
test('drift: a recorded stage named like an Object.prototype member is drift, warned once', async () => {
  const r = await rig([bindRow('w-proto-stage', 'wtlab', 'toString')], { [OWNER]: 'enforce' });
  const seen = await warnings(async () => {
    assert.deepEqual(await r.ask('w-proto-stage', 'Edit'), { deny: null });
    assert.deepEqual(await r.ask('w-proto-stage', 'Edit'), { deny: null });
  });
  assert.deepEqual(seen.length, 1, `exactly one warning: ${JSON.stringify(seen)}`);
  assert.match(seen[0], /stage 'toString' of playbook 'wtlab' is not loaded/);
});

test('a log that cannot be loaded fails open, with a warning', async () => {
  const dir = await mkdtemp('cc-pbworkertools-dir-');
  const gate = createPlaybookGate({ instances: stubManager({ [OWNER]: 'enforce' }), lease: OPEN_LEASE, file: () => dir });
  const seen = await warnings(async () => {
    assert.deepEqual(await gate.checkWorkerTool({ sessionId: 'w1', ownerSessionId: OWNER, toolName: 'Edit' }), { deny: null });
  });
  assert.ok(seen.some(m => m.includes('worker-tools')), `warned: ${JSON.stringify(seen)}`);
});

test('a session with no sessionId yet passes', async () => {
  const r = await rig(IN_REVIEW, { [OWNER]: 'enforce' });
  assert.deepEqual(await r.gate.checkWorkerTool({ sessionId: null, ownerSessionId: OWNER, toolName: 'Edit' }), { deny: null });
});
