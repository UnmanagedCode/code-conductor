// turnForceAborted — the qualifier that makes a wake say INTERRUPTED rather than
// "finished its turn": how it is latched, which rejection modes roll it back, and
// how long it survives (one turn, and not the next).
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, driveTurn, settle } from './helpers.mjs';
import {
  setupIdleWake, callTool, spawnReady, spawnReadyWithScenario,
  countUserEchoes, findStubFor, SCENARIO_PACED, SCENARIO_NO_ACK,
  SCENARIO_ABORT_DEFER, SCENARIO_ABORT_DEFER_THEN_PROMPT,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

// The qualifier is latched BEFORE the control_request await, because the ACK and
// the abort's own `result` can arrive in one stdout chunk and node:readline
// dispatches every line of a chunk synchronously — set it afterwards and that
// turn_end reads false. The rollback is what makes set-before safe, but it must
// distinguish the rejection modes: only some of them mean "the abort did not
// land". The fake CLI auto-ACKs every control_request regardless of scenario
// turns, so the rejection is injected at _controlRequest — exactly the seam the
// real timer rejects at.
for (const mode of [
  {
    name: 'an explicit REFUSAL rolls the qualifier back — the abort provably did not land',
    // What `ok:false`, dead stdin and `subprocess exited` all produce: no
    // `timedOut` marker, and a definite negative.
    err: () => new Error('control_request failed'),
    expectFlag: false,
    expectStub: /finished its turn/,
    rejectStub: /was INTERRUPTED/,
    why: 'the turn ran on and finished, so that is what the owner is told',
  },
  {
    name: 'a TIMEOUT leaves the qualifier set — the outcome is unknown, not negative',
    // The 5s timer deletes _pending before rejecting, so a CLI that honours the
    // interrupt and ACKs at 6s is silently dropped: we do not know. The two error
    // directions are not symmetric — a false INTERRUPTED costs some re-driving of
    // good work, a false "finished" hands the conductor partial output as a
    // complete result — so an unknown outcome reports pessimistically.
    err: () => Object.assign(new Error('control_request timeout'), { timedOut: true }),
    expectFlag: true,
    expectStub: /was INTERRUPTED/,
    rejectStub: /finished its turn/,
    why: 'unknown resolves to the pessimistic report, not the dangerous one',
  },
]) {
  test(mode.name, async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady('p');
    const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
    const target = instForSession(instances, targetId);
    const caller = instForSession(instances, callerId);

    await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
    await waitFor(() => target.status === 'turn');

    const real = target._controlRequest;
    target._controlRequest = async () => { throw mode.err(); };
    await assert.rejects(() => target.interrupt({ force: true }));
    target._controlRequest = real;
    assert.equal(target.turnForceAborted, mode.expectFlag, mode.why);

    // The paced turn was never actually aborted, so it runs to completion — and
    // whichever way the flag went is what its wake reports.
    const stub = await waitFor(() => findStubFor(caller, targetId));
    assert.match(stub.text, mode.expectStub);
    assert.doesNotMatch(stub.text, mode.rejectStub);
    // Either way the pessimism is BOUNDED to that one turn: the turn start that
    // follows finds no surviving wake and clears.
    await driveTurn(instances, targetId,
      () => callTool('send_prompt', { sessionId: targetId, text: 'next' }, { caller: callerId }));
    assert.equal(target.turnForceAborted, false, 'never leaks into a later turn');
  });
}

test('a REAL unanswered interrupt times out and still leaves the qualifier set', async () => {
  // The two cases above inject the rejection at _controlRequest, so neither
  // exercises the marker's SOURCE: drop `timedOut` from the real 5s timer and they
  // both still pass while a genuine timeout silently rolls back. This one goes
  // through the wire — the fixture's `swallow_control` makes the fake never ACK —
  // and so pins the whole chain: timer fires → marker set → rollback declines.
  // It costs one real 5s wait, which is why it is the only test that pays it.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_NO_ACK);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await assert.rejects(() => target.interrupt({ force: true }), /timeout/i);
  assert.equal(target.turnForceAborted, true,
    'a real timeout is an UNKNOWN outcome — it must not roll back to "not aborted"');

  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /was INTERRUPTED/);
});

// ── the abort qualifier's LIFETIME: cleared too early vs never cleared ────────

test('the abort qualifier survives an UNPROMPTED re-invocation turn that resolves its deferred wake', async () => {
  // _onTurnEnd defers an abort's wake while a subagent is live or a task
  // notification is queued, and the CLI resolves that by opening an unprompted
  // re-invocation turn. Clearing the qualifier at every turn START — which looked
  // like the obviously-safe place — wipes it along exactly that trace, BEFORE the
  // wake it qualifies has been delivered, so the owner is told a killed turn
  // finished. The paired test below is what makes this one meaningful: alone it
  // cannot distinguish "correctly preserved" from "never cleared at all".
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  // The UI door, so nobody is disarmed and the owner is still armed to be told.
  await target.interrupt({ force: true });

  // The aborted turn's own turn_end lands first and must NOT consume the wake.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 1);
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'precondition: the abort\'s turn_end deferred on the live background task');
  assert.equal(findStubFor(caller, targetId), undefined, 'and delivered nothing yet');

  // …then the re-invocation turn runs, and ITS turn_end resolves the wake.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 2);
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /was INTERRUPTED/,
    'the qualifier outlived the unprompted turn that resolved its wake');
  assert.doesNotMatch(stub.text, /finished its turn/);
  await settle();
  assert.equal(countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')), 1);
});

test('an unprompted turn after a DISARMED abort is reported on its own terms', async () => {
  // The hole neither of the other two clears reaches. A SOLE owner forces the
  // abort, so its own entry is silently disarmed and nothing is left armed; the
  // abort is confirmed, so the qualifier is latched; no consuming path ever runs
  // (nothing to consume) and no prompt() ever runs. The CLI still owes the queued
  // task notification, so it opens an UNPROMPTED re-invocation turn — real work,
  // which finishes fine — whose turn_start re-arms the owner (ownership surviving
  // a disarm is by design). Without the survived-a-wake check that turn's wake
  // said "was INTERRUPTED … do not treat this as a result" about a completed turn.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  // The MCP door WITH a caller: the sole owner is the interrupter, so it is
  // silently disarmed and nobody is left armed.
  await callTool('interrupt_turn', { sessionId: targetId, force: true }, { caller: callerId });
  await waitFor(() => target.turnForceAborted === true);
  assert.equal(instances._idleHub.hasArmedWake(target.id), false,
    'precondition: the disarm left nothing armed, so no path can consume the flag');

  // The unprompted re-invocation turn re-arms and completes.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 2);
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /finished its turn/,
    'a turn that finished must not inherit the previous abort\'s qualifier');
  assert.doesNotMatch(stub.text, /was INTERRUPTED/);
});

test('a NEW prompt clears the abort qualifier even while the aborted wake is still ARMED', async () => {
  // The case the hub's survived-a-wake check deliberately does NOT clear, so it is
  // prompt()'s alone: the abort's turn_end deferred on a live background task, so
  // a wake IS still armed at the next turn start. Left uncleared, the conductor's
  // own re-drive would come back reported as the previous abort. A new instruction
  // is what makes that abort irrelevant.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER_THEN_PROMPT);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  // The UI door, so the owner is NOT disarmed and its wake survives the abort.
  await target.interrupt({ force: true });
  await waitFor(() => target.status === 'idle');
  await settle();
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'precondition: the abort\'s turn_end deferred, so a wake survived it');
  assert.equal(target.turnForceAborted, true, 'and the qualifier is still latched');
  assert.equal(findStubFor(caller, targetId), undefined, 'nothing delivered yet');

  // A fresh dispatch: the wake it arms is about THIS turn.
  await callTool('send_prompt', { sessionId: targetId, text: 'again' }, { caller: callerId });
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /finished its turn/,
    'the re-drive is reported on its own terms, not the previous abort\'s');
  assert.doesNotMatch(stub.text, /was INTERRUPTED/);
});
