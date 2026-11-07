// The CLI queue model behind `Instance.queuedPromptPending`, and what it buys
// the idle hub: a wake written into a running conductor turn is not yet taken in
// by the CLI, so the conductor keeps reading as awaiting a wake until it is.
//
// The CLI folds a message written mid-turn only at a top-level tool round-trip;
// with none before the turn ends it opens a new turn for it (a conductor's
// queued wake following a final-answer `result`: stdout goes `result`,
// `system/init`, `system/status:requesting`, `stream_event message_start`). A
// fold leaves no stdout signal at all. Both shapes are replayed here from
// tests/fixtures/cli-queue/*.stdout.jsonl: envelope-only stdout lines derived
// from real conductor captures, with text, usage, models, ids and paths blanked.
//   queued-after-end : a turn that ends, then the queued turn's start
//   folded           : a turn whose tool round-trip follows the mid-turn write
// stdin is not part of a stdout capture, so the test performs the mid-turn
// prompt() itself, at the point each file's shape implies.
//
// Wiring: a real Instance's `event` / `turn_start` / `prompts_unblocked` are
// bridged to a real InstanceManager's hub exactly as create() bridges them
// (spawning is not needed to exercise the stdout handler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixPlatform } from '../src/platform/posix.ts';
import { InstanceManager, Instance } from '../src/instances.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-queue');
const load = async (name) => (await fs.readFile(path.join(FIXTURES, name), 'utf8')).split('\n').filter(Boolean);
const kind = (l) => {
  const o = JSON.parse(l);
  return o.type === 'stream_event' ? `stream_event:${o.event.type}` : o.type + (o.subtype ? `:${o.subtype}` : '');
};

function makeInstance(id) {
  const inst = new Instance({
    id, project: 'test-project', cwd: '/nonexistent-cwd',
    mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
  });
  inst.sessionId = `${id}-sid`;
  inst.proc = { pid: 1, stdin: { writable: true, write() {} } };
  return inst;
}

function wire(instances, inst) {
  instances.byId.set(inst.id, inst);
  inst.on('event', (ev, replayed) => instances.emit('event', { id: inst.id, ev, replayed: replayed === true }));
  inst.on('turn_start', () => instances._idleHub.onTurnStart(inst.id));
  inst.on('prompts_unblocked', () => instances._idleHub.onPromptsUnblocked(inst.id));
}

const feed = (inst, lines) => { for (const l of lines) inst._handleStdoutLine(l); };

// Invariant: a prompt written into a running turn sets queuedPromptPending; it
// survives the turn's `result` and the queued turn's init/status lines and
// clears only when that turn's message_start moves the status to `turn`.
test('queued-after-end: a mid-turn prompt() stays pending through result → init → requesting and clears at message_start', async () => {
  const lines = await load('queued-after-end.stdout.jsonl');
  const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
  const startAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'stream_event:message_start');
  const inst = makeInstance('q1');
  feed(inst, lines.slice(0, 1));
  assert.equal(inst.status, 'turn', 'premise: the first message_start opened a turn');
  await inst.prompt('wake', [], { internal: true, annotateIfMidTurn: false });
  assert.equal(inst.queuedPromptPending, true, 'written into a running turn');
  feed(inst, lines.slice(1, resultAt + 1));
  assert.equal(inst.status, 'idle');
  assert.equal(inst.queuedPromptPending, true, 'the turn ended with the prompt still queued');
  feed(inst, lines.slice(resultAt + 1, startAt));
  assert.equal(inst.queuedPromptPending, true, 'init and status:requesting do not take it in');
  feed(inst, lines.slice(startAt, startAt + 1));
  assert.equal(inst.status, 'turn');
  assert.equal(inst.queuedPromptPending, false, 'the queued turn started');
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
    for (let i = 0; i < 20; i++) await Promise.resolve();
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
// when the queued turn starts.
test('end to end: a queued wake keeps list() awaitingWake:true across the conductor\'s result until its turn starts', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end.stdout.jsonl');
    const resultAt = lines.findIndex((l) => kind(l) === 'result:success');
    const startAt = lines.findIndex((l, i) => i > resultAt && kind(l) === 'stream_event:message_start');
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
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(conductor.queuedPromptPending, true, 'premise: the wake was written into the running turn');
    assert.equal(row().awaitingWake, true, 'sent, but not taken in');

    feed(conductor, lines.slice(1, resultAt + 1));
    assert.equal(row().status, 'idle');
    assert.equal(row().awaitingWake, true, 'the idle snapshot after result still awaits the queued wake');
    feed(conductor, lines.slice(resultAt + 1, startAt));
    assert.equal(row().awaitingWake, true);
    feed(conductor, lines.slice(startAt, startAt + 1));
    assert.equal(row().status, 'turn');
    assert.equal(row().awaitingWake, false, 'taken in');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});
