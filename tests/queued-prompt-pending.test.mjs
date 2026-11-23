// The CLI queue model behind `Instance.queuedPromptPending`, and what it buys
// the idle hub: a wake written into a running conductor turn is not yet taken in
// by the CLI, so the conductor keeps reading as awaiting a wake until it is.
//
// The CLI folds a message written mid-turn only at a top-level tool round-trip;
// with none before the turn ends it opens a new turn for it. That turn announces
// itself on stdout before any API call: after the old turn's `result` comes a
// top-level `system/init`, or first a `system/hook_started` for
// `UserPromptSubmit` when such a hook is configured, and only later
// `stream_event message_start`. cc starts the turn at that opener. A fold leaves
// no stdout signal at all. The shapes are replayed here from
// tests/fixtures/cli-queue/*.stdout.jsonl: envelope-only stdout lines derived
// from real CLI debug captures (`claude-stdout.jsonl`), with text, usage,
// models, ids, paths and hook output blanked, one fixed fake session uuid, and
// `stream_event`s other than `message_start` dropped.
//   queued-after-end          : a turn that ends, then the queued turn's start
//                               (opener: `system/init`)
//   queued-after-end-ups-hook : a conductor with a UserPromptSubmit hook: three
//                               turns, each next one opened by `hook_started`
//                               (UserPromptSubmit) after the previous `result`;
//                               the second and third were queued mid-turn (a
//                               human message, then a wake). The first result is
//                               followed by the Stop hook's `hook_response`
//                               before the opener.
//   folded                    : a turn whose tool round-trip follows the
//                               mid-turn write
// stdin is not part of a stdout capture, so the test performs the mid-turn
// prompt() itself, at the point each file's shape implies.
//
// Wiring: a real Instance's `event` / `turn_start` / `prompts_unblocked` are
// bridged to a real InstanceManager's hub exactly as create() bridges them
// (spawning is not needed to exercise the stdout handler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posixPlatform } from '../src/platform/posix.ts';
import { InstanceManager } from '../src/instances.ts';
import { PARKED_BACKSTOP_MS } from '../src/idleSubscriptions.ts';
import { load, kind, indexesOf, asHook, nested, makeInstance, wire, feed, countEmits, microtasks } from './cliQueueRig.mjs';

// Invariant (INV-1, opener `system/init`): a prompt written into a running turn
// sets queuedPromptPending; it survives the turn's `result`, and the queued
// turn's top-level `system/init` moves the status to `turn`, clears the flag and
// emits `turn_start` once. Its later `message_start` emits no second one.
test('queued-after-end: the queued turn starts at its system/init, not at message_start', async () => {
  const lines = await load('queued-after-end.stdout.jsonl');
  const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
  const initAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'system:init');
  const startAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'stream_event:message_start');
  assert.ok(resultAt < initAt && initAt < startAt, 'fixture shape: result, init, message_start');
  const inst = makeInstance('q1');
  feed(inst, lines.slice(0, 1));
  assert.equal(inst.status, 'turn', 'premise: the first message_start opened a turn');
  await inst.prompt('wake', [], { internal: true, annotateIfMidTurn: false });
  assert.equal(inst.queuedPromptPending, true, 'written into a running turn');
  feed(inst, lines.slice(1, resultAt + 1));
  assert.equal(inst.status, 'idle');
  assert.equal(inst.queuedPromptPending, true, 'the turn ended with the prompt still queued');
  const starts = countEmits(inst, 'turn_start');
  feed(inst, lines.slice(resultAt + 1, initAt + 1));
  assert.equal(inst.status, 'turn', 'the opener started the queued turn');
  assert.equal(inst.queuedPromptPending, false, 'taken in at the opener');
  assert.equal(starts.length, 1);
  feed(inst, lines.slice(initAt + 1, startAt + 1));
  assert.equal(inst.status, 'turn');
  assert.equal(starts.length, 1, 'message_start emits no second turn_start');
});

// Invariant (INV-1, opener `hook_started` UserPromptSubmit): after a top-level
// `result`, only a top-level `hook_started` for UserPromptSubmit opens the next
// turn. A Stop `hook_response`, a Stop or PreToolUse `hook_started`, a PreToolUse
// `hook_response` and a nested UserPromptSubmit `hook_started` leave the status
// `idle` and emit no `turn_start`; the following `system/init` and
// `message_start` emit no second one.
test('queued-after-end-ups-hook: a post-result UserPromptSubmit hook_started opens the turn; other hook frames do not', async () => {
  const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
  const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
  const stopResponseAt = resultAt + 1;
  const upsAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'system:hook_started(UserPromptSubmit)');
  const startAt = lines.findIndex((l, i) => i > upsAt && kind(l) === 'stream_event:message_start');
  assert.equal(kind(lines[stopResponseAt]), 'system:hook_response(Stop)', 'fixture shape: the Stop response follows the result');
  assert.ok(upsAt > stopResponseAt && startAt > upsAt);
  const stopStartedAt = lines.findIndex((l) => kind(l) === 'system:hook_started(Stop)');
  const inst = makeInstance('h1');
  feed(inst, lines.slice(0, resultAt + 1));
  assert.equal(inst.status, 'idle');
  const starts = countEmits(inst, 'turn_start');
  feed(inst, [
    lines[stopResponseAt],
    lines[stopStartedAt],
    asHook(lines[stopStartedAt], 'PreToolUse'),
    asHook(lines[stopResponseAt], 'PreToolUse'),
    nested(lines[upsAt]),
  ]);
  assert.equal(inst.status, 'idle', 'no other hook frame opens a turn');
  assert.equal(starts.length, 0);
  feed(inst, lines.slice(upsAt, upsAt + 1));
  assert.equal(inst.status, 'turn', 'the UserPromptSubmit hook_started opened it');
  assert.equal(starts.length, 1);
  feed(inst, lines.slice(upsAt + 1, startAt + 1));
  assert.equal(starts.length, 1, 'its init and message_start emit no second turn_start');
});

// Invariant (INV-1 guard: a `result` since the last turn start, per process): an
// opener before this process has ended any turn is not a CLI-opened turn (the
// spawn's own init, or a first prompt's hook), so an idle instance stays idle.
test('an opener before the first result of the process does not start a turn', async () => {
  const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
  const upsAt = lines.findIndex((l) => kind(l) === 'system:hook_started(UserPromptSubmit)');
  const initAt = lines.findIndex((l) => kind(l) === 'system:init');
  const inst = makeInstance('s1');
  assert.equal(inst.status, 'idle');
  const starts = countEmits(inst, 'turn_start');
  feed(inst, [lines[upsAt], lines[initAt]]);
  assert.equal(inst.status, 'idle');
  assert.deepEqual(starts, []);
});

// Invariant (INV-1 guard, reset per launch): spawn() forgets an earlier
// process's `result`, so the relaunched process's init does not start a turn.
test('a relaunch forgets the previous process\'s result: its init does not start a turn', async () => {
  const lines = await load('queued-after-end.stdout.jsonl');
  const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
  const initAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'system:init');
  const inst = makeInstance('r1');
  feed(inst, lines.slice(0, resultAt + 1));
  assert.equal(inst.status, 'idle');
  // A backend missing from the registry makes spawn() refuse right after its
  // per-launch resets, before any process exists.
  inst.proc = null;
  inst.backend = 'no-such-backend';
  assert.throws(() => inst.spawn(), /no longer exists/);
  inst.status = 'idle';
  inst.proc = { pid: 2, stdin: { writable: true, write() {} } };
  const starts = countEmits(inst, 'turn_start');
  feed(inst, lines.slice(initAt, initAt + 1));
  assert.equal(inst.status, 'idle');
  assert.deepEqual(starts, []);
});

// Invariant (INV-1, nothing left hanging): an opened turn that ends with a
// `result` and no `message_start` (a turn that makes no API call) returns the
// instance to `idle` with exactly one `turn_start` and one `turn_end`.
test('an opened turn with no message_start ends at its result: one turn_start, one turn_end', async () => {
  const lines = await load('queued-after-end.stdout.jsonl');
  const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
  const initAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'system:init');
  const inst = makeInstance('n1');
  feed(inst, lines.slice(0, resultAt + 1));
  const starts = countEmits(inst, 'turn_start');
  const ends = [];
  inst.on('event', (ev) => { if (ev.kind === 'turn_end') ends.push(inst.status); });
  feed(inst, [lines[initAt], lines[resultAt]]);
  assert.equal(inst.status, 'idle');
  assert.equal(starts.length, 1);
  assert.deepEqual(ends, ['idle']);
});

// Invariant: a top-level tool_result after the write is a fold and clears the
// flag; a nested (subagent-forwarded) tool_result does not.
test('folded: a top-level tool_result clears queuedPromptPending, a nested one does not', async () => {
  const lines = await load('folded.stdout.jsonl');
  const toolUseAt = lines.findIndex((l) => kind(l) === 'assistant' && JSON.parse(l).message.content[0].type === 'tool_use');
  const resultAt = lines.findIndex((l) => kind(l) === 'user');
  assert.ok(toolUseAt > 0 && resultAt > toolUseAt, 'fixture shape: tool_use then its tool_result');
  const inst = makeInstance('f1');
  feed(inst, lines.slice(0, toolUseAt + 1));
  assert.equal(inst.status, 'turn');
  await inst.prompt('wake', [], { internal: true, annotateIfMidTurn: false });
  assert.equal(inst.queuedPromptPending, true);
  const nested = JSON.stringify({
    ...JSON.parse(lines[resultAt]), parent_tool_use_id: 'toolu_nested',
  });
  inst._handleStdoutLine(nested);
  assert.equal(inst.queuedPromptPending, true, 'a nested result rides a subagent loop, not the outer conversation');
  feed(inst, lines.slice(resultAt, resultAt + 1));
  assert.equal(inst.queuedPromptPending, false, 'folded at the tool round-trip');
  feed(inst, lines.slice(resultAt + 1));
  assert.equal(inst.status, 'idle');
  assert.equal(inst.queuedPromptPending, false);
});

// Invariant: a prompt written to an idle instance is not "queued": it starts the
// turn itself.
test('an idle-instance prompt() leaves queuedPromptPending clear', async () => {
  const inst = makeInstance('i1');
  assert.equal(inst.status, 'idle');
  await inst.prompt('hello', [], { internal: true });
  assert.equal(inst.status, 'turn');
  assert.equal(inst.queuedPromptPending, false);
});

// Invariant: the process exiting clears the flag (nothing is queued in a dead CLI).
test('process exit clears queuedPromptPending', async () => {
  const lines = await load('queued-after-end.stdout.jsonl');
  const inst = makeInstance('x1');
  feed(inst, lines.slice(0, 1));
  await inst.prompt('wake', [], { internal: true, annotateIfMidTurn: false });
  assert.equal(inst.queuedPromptPending, true);
  inst._handleExit(1, null, Promise.resolve(''));
  assert.equal(inst.queuedPromptPending, false);
});

// Invariant: the flag is already false when the exit event is emitted, so the hub's
// onEvent for that event releases a parked hold — a dead conductor must not keep
// reading as awaiting a wake.
test('exit: the flag is cleared before the exit event, and a parked hold is released by it', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end.stdout.jsonl');
    const conductor = makeInstance('xc');
    const worker = makeInstance('xw');
    worker.status = 'turn';
    wire(instances, conductor);
    instances.byId.set('xw', worker);
    feed(conductor, lines.slice(0, 1));
    instances.noteDispatch('xc-sid', 'xw-sid');
    instances._idleHub.onTurnStart('xw');
    const seen = [];
    conductor.on('event', (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'exit') {
        seen.push({ pending: conductor.queuedPromptPending, awaiting: instances.isIdleCaller('xc') });
      }
    });
    worker.status = 'idle';
    instances.emit('event', { id: 'xw', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await microtasks();
    assert.equal(conductor.queuedPromptPending, true, 'premise: the wake is parked');
    assert.equal(instances.isIdleCaller('xc'), true, 'premise: awaiting');
    conductor._handleExit(1, null, Promise.resolve(''));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pending, false, 'cleared before the exit event was emitted');
    assert.equal(instances.isIdleCaller('xc'), false, 'the hub released the hold on the exit event');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});

// Invariant: _endMutation lifts the claim and announces prompts_unblocked,
// the event a held wake is flushed on.
test('_endMutation clears _mutating and emits prompts_unblocked', () => {
  const inst = makeInstance('m1');
  inst._mutating = 'prune';
  let seen = null;
  inst.on('prompts_unblocked', () => { seen = { mutating: inst._mutating, blocks: inst.rewriteBlocksPrompts }; });
  inst._endMutation();
  assert.deepEqual(seen, { mutating: null, blocks: false });
});

// Invariant (end to end): a hub-delivered wake into a running conductor that the
// CLI queues leaves list() showing awaitingWake:true at the conductor's idle
// snapshot after its own result — the snapshot that read as finished — and clears
// at the queued turn's opener (its `system/init`).
test('end to end: a queued wake keeps list() awaitingWake:true across the conductor\'s result until its queued turn opens', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end.stdout.jsonl');
    const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
    const initAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'system:init');
    const conductor = makeInstance('c');
    const worker = makeInstance('w');
    worker.status = 'turn';
    wire(instances, conductor);
    instances.byId.set('w', worker);
    feed(conductor, lines.slice(0, 1));
    assert.equal(conductor.status, 'turn');
    instances.noteDispatch('c-sid', 'w-sid');
    instances._idleHub.onTurnStart('w');
    const row = () => instances.list().find((r) => r.id === 'c');

    worker.status = 'idle';
    instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await microtasks();
    assert.equal(conductor.queuedPromptPending, true, 'premise: the wake was written into the running turn');
    assert.equal(row().awaitingWake, true, 'sent, but not taken in');

    feed(conductor, lines.slice(1, resultAt + 1));
    assert.equal(row().status, 'idle');
    assert.equal(row().awaitingWake, true, 'the idle snapshot after result still awaits the queued wake');
    feed(conductor, lines.slice(initAt, initAt + 1));
    assert.equal(row().status, 'turn');
    assert.equal(row().awaitingWake, false, 'taken in');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});

// Invariant (INV-2): a prompt() written while the instance is idle but the CLI
// still holds a queued prompt (between a `result` and the queued turn's opener)
// is itself marked queued: queuedPromptPending stays true after the write, the
// hub parks the wake it carried, and list() keeps awaitingWake:true through the
// queued turn's own `result` until the NEXT opener starts the turn for the wake.
test('a wake written between a result and the queued turn\'s opener is marked queued and parks', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
    const results = indexesOf(lines, 'result:success');
    const openers = indexesOf(lines, 'system:hook_started(UserPromptSubmit)');
    assert.ok(results.length >= 2 && openers.length >= 2 && openers[0] > results[0] && openers[1] > results[1]);
    const conductor = makeInstance('c');
    const worker = makeInstance('w');
    worker.status = 'turn';
    wire(instances, conductor);
    instances.byId.set('w', worker);
    feed(conductor, lines.slice(0, 1));
    // A first message written into the running turn, queued past its end.
    await conductor.prompt('queued message', [], { internal: true, annotateIfMidTurn: false });
    feed(conductor, lines.slice(1, results[0] + 1));
    assert.equal(conductor.status, 'idle');
    assert.equal(conductor.queuedPromptPending, true, 'premise: the CLI still holds the first message');

    instances.noteDispatch('c-sid', 'w-sid');
    instances._idleHub.onTurnStart('w');
    // The caller is idle, so the hub folds the worker's output; no transcript here.
    instances._idleHub._buildFoldedStub = async () => 'stub';
    const row = () => instances.list().find((r) => r.id === 'c');
    worker.status = 'idle';
    instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await microtasks();
    assert.equal(conductor.queuedPromptPending, true, 'the wake written into the idle gap is queued too');
    assert.equal(instances._idleHub._parked.get('c')?.length, 1, 'the wake is parked');

    // The first message's turn: its opener arrives with the status already `turn`.
    feed(conductor, lines.slice(results[0] + 1, results[1] + 1));
    assert.equal(row().status, 'idle');
    assert.equal(row().awaitingWake, true, 'the first message\'s turn ended; the wake is still queued');
    feed(conductor, lines.slice(results[1] + 1, openers[1]));
    assert.equal(row().awaitingWake, true);
    feed(conductor, lines.slice(openers[1], openers[1] + 1));
    assert.equal(row().status, 'turn');
    assert.equal(row().awaitingWake, false, 'the wake\'s turn opened');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});

// The consumed gap write: a write into the result → opener gap that the CLI took
// into the turn it was opening leaves queuedPromptPending set after that turn's
// result, with no opener coming — on stdout the same shape as a write queued
// behind the turn. Replays the ups-hook fixture with the Instance clock injected:
// a first message queued mid-turn, its turn's result (t=0), a second message in
// the gap (t=100), the next turn's result at RESULT_AT; then a hub wake to the
// idle conductor at RESULT_AT + `after`.
const RESULT_AT = 1_000;
async function wakeAfterConsumedGapWrite(after) {
  const instances = new InstanceManager({ platform: posixPlatform });
  const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
  const results = indexesOf(lines, 'result:success');
  const conductor = makeInstance('c');
  const worker = makeInstance('w');
  let now = 0;
  conductor._now = () => now;
  worker.status = 'turn';
  wire(instances, conductor);
  instances.byId.set('w', worker);
  feed(conductor, lines.slice(0, 1));
  await conductor.prompt('queued message', [], { internal: true, annotateIfMidTurn: false });
  feed(conductor, lines.slice(1, results[0] + 1));
  now = 100;
  await conductor.prompt('gap message', [], { internal: true, annotateIfMidTurn: false });
  now = RESULT_AT;
  feed(conductor, lines.slice(results[0] + 1, results[1] + 1));
  const premise = { status: conductor.status, pending: conductor.queuedPromptPending };
  instances.noteDispatch('c-sid', 'w-sid');
  instances._idleHub.onTurnStart('w');
  instances._idleHub._buildFoldedStub = async () => 'stub';
  now = RESULT_AT + after;
  worker.status = 'idle';
  instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  await microtasks();
  return { instances, conductor, premise, parked: instances._idleHub._parked.get('c')?.length ?? 0 };
}

// Invariant (INV-2's window, outer side): a flag still set at idle more than
// PARKED_BACKSTOP_MS after the last top-level result stands for no CLI-held
// input, so an idle wake is not marked queued, does not park, and its turn
// transition clears the flag.
test('a wake to an idle instance more than PARKED_BACKSTOP_MS after the last result is not marked queued', async () => {
  const r = await wakeAfterConsumedGapWrite(PARKED_BACKSTOP_MS + 1);
  try {
    assert.deepEqual(r.premise, { status: 'idle', pending: true }, 'premise: the consumed gap write left the flag set');
    assert.equal(r.parked, 0, 'not parked');
    assert.equal(r.conductor.queuedPromptPending, false, 'the stale flag is gone');
  } finally {
    await r.instances.shutdown().catch(() => {});
  }
});

// Invariant (INV-2's window, inner side): within PARKED_BACKSTOP_MS of the last
// top-level result a set flag may stand for a turn the CLI holds, so an idle wake
// is still marked queued and parks.
test('a wake to an idle instance within PARKED_BACKSTOP_MS of the last result is still marked queued', async () => {
  const r = await wakeAfterConsumedGapWrite(PARKED_BACKSTOP_MS - 1);
  try {
    assert.deepEqual(r.premise, { status: 'idle', pending: true });
    assert.equal(r.parked, 1, 'parked');
    assert.equal(r.conductor.queuedPromptPending, true);
  } finally {
    await r.instances.shutdown().catch(() => {});
  }
});
