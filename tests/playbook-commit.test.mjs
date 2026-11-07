// The gate's `call` rows (src/mcp/playbookGate.ts), at the gate level: check()
// then commit()/fail() driven directly, so each case pairs a decision with the
// handler outcome it needs. The contract: EXACTLY ONE `call` row per governed
// call that is refused (any tool, either level), and per governed interaction
// call or spawn_instance that runs — `outcome` ok, refused or failed. A governed
// read-only call that runs writes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPlaybookGate, FAILURE_REASON_MAX } from '../src/mcp/playbookGate.ts';
import { readEventLog } from '../src/eventLog.ts';
import { foldPlaybookState } from '../src/playbookState.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { GATELAB, OPEN_LEASE, bindRow, moveRow } from './playbook-fixtures.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// The gate loads real definitions, so the graphs have to exist on disk. Per-FILE
// user-overlay store (node:test forks a process per file), never the shipped
// playbooks/*.json. `readlab` exists only to deny a READ-ONLY tool.
const READLAB = {
  id: 'readlab', name: 'Readlab', description: 'Test-only: a stage that denies a read-only tool.',
  entryStages: ['watch'],
  stages: { watch: { description: 'No reading.', tools: { spawn_instance: 'allow', get_recent_messages: 'deny' } } },
  transitions: [],
};
process.env.PROJECTS_ROOT = await mkdtemp('cc-pbcommit-root-');
{
  const dir = path.join(orchStoreRoot(), 'playbooks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'gatelab.json'), JSON.stringify(GATELAB));
  await fs.writeFile(path.join(dir, 'readlab.json'), JSON.stringify(READLAB));
}

const CONDUCTOR_ID = 'conductor-1';
const ACTOR = { type: 'conductor', sessionId: CONDUCTOR_ID };

// Only what the gate touches. `emit` records, per playbook_changed, whether the
// projection ALREADY holds the new stage at that moment — fold before notify.
function stubManager({ live = [], mode = 'enforce' } = {}) {
  const caller = { project: CONDUCT_PROJECT_NAME, playbookEnforcement: mode, _emitUi() {} };
  const liveSet = new Set(live);
  const emitted = [];
  const mgr = {
    proj: null,
    emitted,
    on() {},
    liveForSession(sessionId) { return sessionId === CONDUCTOR_ID ? caller : null; },
    isSessionLive(sessionId) { return liveSet.has(sessionId); },
    emit(event, arg) {
      emitted.push({ event, arg, stageAtEmit: event === 'playbook_changed' ? mgr.proj?.bySession.get(arg.sessionId)?.stage : undefined });
    },
  };
  return mgr;
}

// A gate over a temp log seeded with `seed` rows. `appended` holds every row
// handed to the log (a thunk's result included): JSON drops an `undefined`
// key, so only the handed row can tell "omitted" from "written as undefined".
async function rig(seed, opts) {
  const dir = await mkdtemp('cc-pbcommit-');
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, seed.map((r, i) => JSON.stringify({ v: 1, ts: `2026-09-06T00:00:0${i % 10}Z`, ...r })).join('\n') + '\n');
  const instances = stubManager(opts);
  const gate = createPlaybookGate({ instances, lease: OPEN_LEASE, file: () => file });
  instances.proj = await gate.readProjection();
  const log = gate.eventLog();
  const realAppend = log.append;
  const appended = [];
  const note = (r) => { if (r) appended.push(...[r].flat()); return r; };
  log.append = (input) => realAppend(typeof input === 'function' ? () => note(input()) : note(input));
  const rows = async () => (await readEventLog(file)).slice(seed.length).map(({ v, ts, ...r }) => r);
  const all = async () => readEventLog(file);
  // Writes trail check()/commit() through the chain; a read after one more
  // projection read sees them.
  const settle = async () => { await gate.readProjection(); await new Promise(r => setTimeout(r, 10)); };
  return { gate, rows, all, appended, settle, emitted: instances.emitted, caller: instances.liveForSession(CONDUCTOR_ID) };
}

async function check(r, toolName, args, extra = {}) {
  return r.gate.check({ toolName, args, callerId: CONDUCTOR_ID, ...extra });
}

async function committed(r, toolName, args, result = {}, extra = {}) {
  const outcome = await check(r, toolName, args, extra);
  assert.ok(!('refusal' in outcome), `premise: ${toolName} must be allowed; got ${JSON.stringify(outcome.refusal)}`);
  await outcome.commit?.(result);
  await r.settle();
  return outcome;
}

// A worker with a HISTORY, so "the binding survived" is a real claim.
const BOUND = [bindRow('w1', 'gatelab', 'draft'), moveRow('w1', 'draft', 'build', { tool: 'approve_plan' })];
const RUN = [...BOUND, bindRow('a1', 'gatelab', 'audit', { provenance: { build: 'w1' } })];
const IN_AMEND = [...RUN, moveRow('w1', 'build', 'amend', { provenance: { audit: 'a1' } })];
const FORWARD_SOURCE = 'planner-1';

// The decision the backstop cases share: a call the policy layer classifies as
// a FRESH spawn into `loose` — an id it cannot place, plus an explicit binding.
async function spawnDecision(r) {
  const outcome = await check(r, 'spawn_instance', { resume: 'an-id-the-log-cannot-place', playbook: 'gatelab', stage: 'loose' });
  assert.ok(!('refusal' in outcome), `premise: an allowed spawn; got ${JSON.stringify(outcome.refusal)}`);
  assert.ok(typeof outcome.commit === 'function', 'premise: an allowed spawn carries a commit');
  return outcome;
}

// ── spawn: the bind and its backstop ───────────────────────────────────────

test('a spawn whose RESULT names an already-bound session writes its call row WITHOUT a bind — the binding is untouched', async () => {
  const r = await rig(BOUND);
  await (await spawnDecision(r)).commit({ sessionId: 'w1', project: 'demo' });
  await r.settle();
  assert.deepEqual(await r.rows(), [{ kind: 'call', actor: ACTOR, subject: 'w1', tool: 'spawn_instance', outcome: 'ok' }]);
  const st = foldPlaybookState(await r.all()).bySession.get('w1');
  assert.deepEqual([st.playbook, st.stage, st.stageHistory], ['gatelab', 'build', ['draft', 'build']]);
});

test('the same spawn whose RESULT names an UNBOUND session writes a bind with the result\'s project and worktree', async () => {
  const r = await rig(BOUND);
  await (await spawnDecision(r)).commit({ sessionId: 'w2', project: 'demo', worktree: { worktreeName: 'wt-9' } });
  await r.settle();
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, subject: 'w2', tool: 'spawn_instance', outcome: 'ok',
    bind: { playbook: 'gatelab', stage: 'loose', project: 'demo', worktree: 'wt-9' },
  }]);
  const st = foldPlaybookState(await r.all()).bySession.get('w2');
  assert.deepEqual([st.playbook, st.stage, st.stageHistory], ['gatelab', 'loose', ['loose']]);
});

test('two CONCURRENT commits naming the same session: two call rows, only the first binds', async () => {
  // INVARIANT: "already bound?" is answered INSIDE the serialized chain.
  const r = await rig(BOUND);
  const a = await spawnDecision(r);
  const b = await spawnDecision(r);
  await Promise.all([a.commit({ sessionId: 'w2', project: 'demo' }), b.commit({ sessionId: 'w2', project: 'demo' })]);
  await r.settle();
  assert.deepEqual((await r.rows()).map(x => !!x.bind), [true, false]);
  const st = foldPlaybookState(await r.all()).bySession.get('w2');
  assert.deepEqual(st.stageHistory, ['loose']);
});

test('a tracked worker\'s resume writes one ok call row on the resumed id, with no bind', async () => {
  const r = await rig(RUN, { live: ['w1', 'a1'] });
  await committed(r, 'spawn_instance', { resume: 'w1' }, { sessionId: 'w1' }, { resumeHandle: 'w1' });
  assert.deepEqual(await r.rows(), [{ kind: 'call', actor: ACTOR, subject: 'w1', tool: 'spawn_instance', outcome: 'ok' }]);
});

// ── playbook_changed: after the fold, only for a bind or a move ────────────

test('a committed bind emits exactly one playbook_changed, AFTER the projection already holds the new stage', async () => {
  const r = await rig(BOUND);
  await (await spawnDecision(r)).commit({ sessionId: 'w2', project: 'demo' });
  await r.settle();
  const changes = r.emitted.filter(e => e.event === 'playbook_changed');
  assert.deepEqual(changes.map(c => [c.arg, c.stageAtEmit]), [[{ sessionId: 'w2' }, 'loose']]);
});

test('a committed move emits exactly one playbook_changed, with the destination already folded', async () => {
  const r = await rig([bindRow('w1', 'gatelab', 'draft')], { live: ['w1'] });
  await committed(r, 'approve_plan', { sessionId: 'w1' });
  const changes = r.emitted.filter(e => e.event === 'playbook_changed');
  assert.deepEqual(changes.map(c => [c.arg, c.stageAtEmit]), [[{ sessionId: 'w1' }, 'build']]);
  assert.deepEqual(await r.rows(), [{ kind: 'call', actor: ACTOR, subject: 'w1', tool: 'approve_plan', outcome: 'ok', move: { from: 'draft', to: 'build' } }]);
});

test('the backstop, a plain call and a refusal emit no playbook_changed', async () => {
  const r = await rig(BOUND, { live: ['w1'] });
  await (await spawnDecision(r)).commit({ sessionId: 'w1', project: 'demo' });
  await committed(r, 'send_prompt', { sessionId: 'w1', text: 'x', stage: 'build' });
  const refused = await check(r, 'spawn_instance', { project: 'demo', mode: 'plan' });
  assert.ok('refusal' in refused, 'premise: refused');
  await r.settle();
  assert.equal(r.emitted.filter(e => e.event === 'playbook_changed').length, 0);
});

// ── moves, self-edges and the forward source ───────────────────────────────

test('a real move records its provenance and the forward source on the row', async () => {
  const r = await rig(RUN, { live: ['w1', 'a1'] });
  await committed(r, 'send_prompt', { sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' }, forward: { sessionId: FORWARD_SOURCE } });
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, subject: 'w1', tool: 'send_prompt', outcome: 'ok', forward: FORWARD_SOURCE,
    move: { from: 'build', to: 'amend', provenance: { audit: 'a1' } },
  }]);
});

test('a DECLARED self-loop and an UNDECLARED self-edge write identical rows: no move, the forward kept, stageHistory unchanged', async () => {
  // gatelab declares amend->amend and no build->build.
  const declared = await rig(IN_AMEND, { live: ['w1', 'a1'] });
  await committed(declared, 'send_prompt', { sessionId: 'w1', text: 'round 2', stage: 'amend', forward: { sessionId: FORWARD_SOURCE } });
  const undeclared = await rig(RUN, { live: ['w1', 'a1'] });
  await committed(undeclared, 'send_prompt', { sessionId: 'w1', text: 'more', stage: 'build', forward: { sessionId: FORWARD_SOURCE } });
  const expected = [{ kind: 'call', actor: ACTOR, subject: 'w1', tool: 'send_prompt', outcome: 'ok', forward: FORWARD_SOURCE }];
  assert.deepEqual(await declared.rows(), expected);
  assert.deepEqual(await undeclared.rows(), expected);
  assert.deepEqual(foldPlaybookState(await declared.all()).bySession.get('w1').stageHistory, ['draft', 'build', 'amend']);
});

test('a call without a forward hands the log no `forward` key at all — a real move and a self-edge alike', async (t) => {
  for (const arm of [
    { name: 'real move', seed: RUN, args: { sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' } } },
    { name: 'self-edge', seed: IN_AMEND, args: { sessionId: 'w1', text: 'round 2', stage: 'amend' } },
  ]) {
    await t.test(arm.name, async () => {
      const r = await rig(arm.seed, { live: ['w1', 'a1'] });
      await committed(r, 'send_prompt', arm.args);
      assert.equal(r.appended.length, 1);
      assert.equal(Object.hasOwn(r.appended[0], 'forward'), false);
    });
  }
});

test('a non-string or empty forward.sessionId mints no forward key', async (t) => {
  for (const forward of [{ sessionId: 123 }, { sessionId: '' }]) {
    await t.test(JSON.stringify(forward), async () => {
      const r = await rig(RUN, { live: ['w1', 'a1'] });
      await committed(r, 'send_prompt', { sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' }, forward });
      assert.equal(Object.hasOwn(r.appended[0], 'forward'), false);
      assert.ok(r.appended[0].move, 'premise: the move was recorded');
    });
  }
});

// ── interaction calls ──────────────────────────────────────────────────────

test('send_prompt to an untracked worker writes one call row with exactly the id fields and no prompt text', async () => {
  const r = await rig(RUN);
  await committed(r, 'send_prompt', { sessionId: 'u9', text: 'SECRET-PROMPT-TEXT' });
  const rows = await r.rows();
  assert.deepEqual(rows, [{ kind: 'call', actor: ACTOR, subject: 'u9', tool: 'send_prompt', outcome: 'ok' }]);
  assert.doesNotMatch(JSON.stringify(await r.all()), /SECRET-PROMPT-TEXT/);
});

for (const tool of ['approve_plan', 'reject_plan', 'answer_question', 'interrupt_turn', 'kill_instance']) {
  test(`${tool} on an untracked worker writes one ok call row naming the tool`, async () => {
    const r = await rig(RUN);
    await committed(r, tool, { sessionId: 'u9' });
    assert.deepEqual(await r.rows(), [{ kind: 'call', actor: ACTOR, subject: 'u9', tool, outcome: 'ok' }]);
  });
}

test('a governed READ-ONLY call that runs writes nothing, and carries no commit or fail', async () => {
  const r = await rig(RUN);
  const outcome = await committed(r, 'get_recent_messages', { sessionId: 'u9' });
  assert.equal(outcome.commit, undefined);
  assert.equal(outcome.fail, undefined);
  assert.deepEqual(await r.rows(), []);
});

test('a non-conductor caller writes nothing', async () => {
  const r = await rig(RUN);
  const outcome = await r.gate.check({ toolName: 'send_prompt', args: { sessionId: 'u9', text: 'x' }, callerId: 'someone-else' });
  await outcome.commit?.({});
  await r.settle();
  assert.deepEqual(await r.rows(), []);
});

// ── failed calls: an ok:false result or a throw ────────────────────────────

test('an ok:false result writes one FAILED row carrying the result\'s code and reason — no move even for a legal transition', async () => {
  const r = await rig(RUN, { live: ['w1', 'a1'] });
  await committed(r, 'send_prompt', { sessionId: 'w1', text: 'go', stage: 'amend', provenance: { audit: 'a1' } },
    { ok: false, code: 'FORWARD_EMPTY', reason: 'nothing to forward' });
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, subject: 'w1', tool: 'send_prompt', outcome: 'failed',
    failure: { code: 'FORWARD_EMPTY', reason: 'nothing to forward' },
  }]);
  assert.equal(foldPlaybookState(await r.all()).bySession.get('w1').stage, 'build', 'the move did not happen');
});

test('a fresh spawn that soft-fails writes one failed row with NO subject (no session was produced)', async () => {
  const r = await rig(BOUND);
  await committed(r, 'spawn_instance', { project: 'demo', playbook: 'gatelab', stage: 'loose' }, { ok: false, code: 'BAD_MODEL', reason: 'no such model' });
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, tool: 'spawn_instance', outcome: 'failed', failure: { code: 'BAD_MODEL', reason: 'no such model' },
  }]);
});

test('a handler THROW recorded by fail() writes one failed row from the error\'s code and message, never from the arguments', async () => {
  const r = await rig(RUN);
  const outcome = await check(r, 'send_prompt', { sessionId: 'u9', text: 'SECRET-PROMPT-TEXT' });
  await outcome.fail(Object.assign(new Error('not running'), { code: 'NOT_RUNNING' }));
  await r.settle();
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, subject: 'u9', tool: 'send_prompt', outcome: 'failed', failure: { code: 'NOT_RUNNING', reason: 'not running' },
  }]);
  assert.doesNotMatch(JSON.stringify(await r.all()), /SECRET-PROMPT-TEXT/);
});

test('failure.reason is bounded to FAILURE_REASON_MAX characters, from a thrown message and from a result reason alike', async () => {
  const long = 'x'.repeat(FAILURE_REASON_MAX * 5);
  const r = await rig(RUN);
  await (await check(r, 'send_prompt', { sessionId: 'u9', text: 't' })).fail(new Error(long));
  await committed(r, 'send_prompt', { sessionId: 'u9', text: 't' }, { ok: false, reason: long });
  const rows = await r.rows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.failure.reason.length, FAILURE_REASON_MAX);
    assert.ok(long.startsWith(row.failure.reason.slice(0, -1)));
  }
  assert.equal('code' in rows[0].failure, false, 'an error without a code records none');
});

// ── refused calls ──────────────────────────────────────────────────────────

test('a refused spawn under enforce writes one refused row with no subject; a refused resume names the resumed id', async () => {
  const r = await rig(RUN, { live: ['w1', 'a1'] });
  const fresh = await check(r, 'spawn_instance', { project: 'demo', mode: 'plan' });
  assert.ok('refusal' in fresh, 'premise: refused');
  const resumed = await check(r, 'spawn_instance', { resume: 'w1', playbook: 'gatelab', stage: 'loose' }, { resumeHandle: 'w1' });
  assert.ok('refusal' in resumed, 'premise: a resume naming another binding is refused');
  await r.settle();
  const rows = await r.rows();
  assert.deepEqual(rows.map(x => [x.outcome, x.subject, x.refusal.code]), [
    ['refused', undefined, fresh.refusal.code],
    ['refused', 'w1', resumed.refusal.code],
  ]);
  assert.equal(Object.hasOwn(rows[0], 'subject'), false);
});

test('a refused call under warn proceeds with no commit or fail, and its refused row is its only row', async () => {
  const r = await rig(RUN, { live: ['w1', 'a1'], mode: 'warn' });
  const bubbles = [];
  r.caller._emitUi = (ev) => bubbles.push(ev);
  const outcome = await check(r, 'spawn_instance', { project: 'demo', mode: 'plan' });
  assert.ok(!('refusal' in outcome), 'warn lets the call through');
  assert.equal(outcome.commit, undefined);
  assert.equal(outcome.fail, undefined);
  await r.settle();
  assert.deepEqual((await r.rows()).map(x => x.outcome), ['refused']);
  assert.equal(bubbles.length, 1);
});

test('a refused READ-ONLY call still writes its refused row — the refusal audit covers every governed tool', async () => {
  const r = await rig([bindRow('wr', 'readlab', 'watch')], { live: ['wr'] });
  const outcome = await check(r, 'get_recent_messages', { sessionId: 'wr' });
  assert.ok('refusal' in outcome, `premise: readlab denies get_recent_messages; got ${JSON.stringify(outcome)}`);
  await r.settle();
  assert.deepEqual(await r.rows(), [{
    kind: 'call', actor: ACTOR, subject: 'wr', tool: 'get_recent_messages', outcome: 'refused',
    refusal: { code: outcome.refusal.code, reason: outcome.refusal.reason },
  }]);
});
