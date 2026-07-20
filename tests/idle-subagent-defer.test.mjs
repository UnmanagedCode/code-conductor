// Unit tests for IdleSubscriptionHub's subagent-aware wake deferral.
//
// The dispatch-and-wake callback must fire only when a worker's turn_end lands
// AND the worker has no live background subagents (Instance._activeAgentTasks
// empty) AND no re-invocation turn is still owed (taskNotificationPending —
// a mid-turn task_notification with no top-level tool_result after it means
// the CLI's queue still holds the notification and an unprompted re-invocation
// turn will follow; waking at this turn_end would be one turn early).
//
// Two layers:
//   1. Hub-gate tests: drive the REAL InstanceManager -> IdleSubscriptionHub
//      path via manager.emit('event', {id, ev:{kind:'turn_end'}}) (the same
//      edge the live system uses) with injected fake instances exposing
//      settable `activeAgentTaskCount` / `taskNotificationPending`.
//   2. Instance-lifecycle tests: drive a REAL (unspawned) Instance's
//      _handleStdoutLine with raw stdout lines shaped like actual CLI 2.1.198
//      output (captured from debug jsonls), asserting the flag's set/clear
//      edges — mid-turn notification sets; top-level tool_result clears
//      (sync-delivered result or attach-batch); nested (subagent-forwarded)
//      tool_result does NOT clear; the re-invocation turn's start clears;
//      an idle notification never sets.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager, Instance } from '../src/instances.js';

const instances = new InstanceManager();
after(() => instances.shutdown().catch(() => {}));

// Fake instance: `proc` truthy so isLive()/liveForSession treat it as live;
// `prompt` records deliveries; the two gate inputs are settable fields.
function makeFake({ id, sessionId, activeAgentTaskCount = 0, taskNotificationPending = false }) {
  const _promptCalls = [];
  const inst = {
    id,
    sessionId,
    project: 'test-project',
    proc: { pid: 999 },
    status: 'idle',
    activeAgentTaskCount,
    taskNotificationPending,
    _emitUi() {},
    // Minimal ring surface so the folded-stub builder (buildRecentMessages)
    // resolves against this fake instead of throwing — the fold produces an
    // (empty) payload and deliver() still calls prompt().
    ring: { trimmedBefore: 0 },
    ringSnapshot() { return []; },
    async prompt(text, _atts, opts) { _promptCalls.push({ text, opts }); },
  };
  inst._promptCalls = _promptCalls;
  return inst;
}

function emitTurnEnd(id) {
  instances.emit('event', { id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
}

// Delivery is queueMicrotask + an async (folding) prompt() — give it a beat.
const tick = () => new Promise(r => setTimeout(r, 20));

function inject(cond, work) {
  instances.byId.set(cond.id, cond);
  instances.byId.set(work.id, work);
}
function cleanup(cond, work) {
  instances._idleSubscribers.clear();
  instances.byId.delete(cond.id);
  instances.byId.delete(work.id);
}

test('(a)+(b) turn_end with an active subagent defers; delivery fires once after the count drains', async () => {
  const cond = makeFake({ id: 'c1', sessionId: 'cs1' });
  const work = makeFake({ id: 'w1', sessionId: 'ws1', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs1', 'ws1');

  // (a) turn_end while a subagent is active → deferred, subscription untouched.
  emitTurnEnd('w1');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'no delivery while a background subagent is active');
  assert.equal(instances._idleHub.hasSubscriber('w1'), true,
    'a deferred turn_end must NOT consume the one-shot subscription');

  // (b) subagent finishes → follow-up turn_end at count 0 → deliver exactly once.
  work.activeAgentTaskCount = 0;
  emitTurnEnd('w1');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered exactly once after the count drained');
  assert.equal(instances._idleHub.hasSubscriber('w1'), false, 'subscription consumed on delivery');

  cleanup(cond, work);
});

test('(c) multiple background subagents — delivery waits for the LAST', async () => {
  const cond = makeFake({ id: 'c2', sessionId: 'cs2' });
  const work = makeFake({ id: 'w2', sessionId: 'ws2', activeAgentTaskCount: 2 });
  inject(cond, work);
  instances.subscribeIdle('cs2', 'ws2');

  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'count 2 → defer');

  work.activeAgentTaskCount = 1;
  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'count 1 → still defer (last subagent not done)');

  work.activeAgentTaskCount = 0;
  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'count 0 → delivered exactly once');
  assert.equal(instances._idleHub.hasSubscriber('w2'), false);

  cleanup(cond, work);
});

test('(c2) queued notification: count 0 but taskNotificationPending defers until the re-invocation turn', async () => {
  // The a26bbc4 no-early-wake guarantee: a background subagent completed
  // DURING the turn with no tool round-trip after it, so its notification is
  // still queued and the CLI owes an unprompted re-invocation turn. The gate
  // must defer on the flag alone (count is already 0 at this turn_end).
  const cond = makeFake({ id: 'c7', sessionId: 'cs7' });
  const work = makeFake({ id: 'w7', sessionId: 'ws7', activeAgentTaskCount: 0, taskNotificationPending: true });
  inject(cond, work);
  instances.subscribeIdle('cs7', 'ws7');

  // turn_end with count 0 but an unconsumed notification → deferred, subscription kept.
  emitTurnEnd('w7'); await tick();
  assert.equal(cond._promptCalls.length, 0,
    'count 0 but an unconsumed mid-turn notification → defer (re-invocation turn owed)');
  assert.equal(instances._idleHub.hasSubscriber('w7'), true,
    'a deferred turn_end must NOT consume the one-shot subscription');

  // The re-invocation turn runs; _setStatus clears the flag at its start.
  // Its turn_end (flag clear, count 0) delivers exactly once.
  work.taskNotificationPending = false;
  emitTurnEnd('w7'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered once at the re-invocation turn_end');
  assert.equal(instances._idleHub.hasSubscriber('w7'), false, 'subscription consumed on delivery');

  cleanup(cond, work);
});

test('(e) regression: a normal no-subagent turn_end delivers immediately', async () => {
  const cond = makeFake({ id: 'c3', sessionId: 'cs3' });
  const work = makeFake({ id: 'w3', sessionId: 'ws3', activeAgentTaskCount: 0 });
  inject(cond, work);
  instances.subscribeIdle('cs3', 'ws3');

  emitTurnEnd('w3'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'no subagents → immediate single delivery');
  assert.equal(instances._idleHub.hasSubscriber('w3'), false);

  cleanup(cond, work);
});

test('every subscription arms a watchdog by default (no explicit timeoutMs)', () => {
  const cond = makeFake({ id: 'c4', sessionId: 'cs4' });
  const work = makeFake({ id: 'w4', sessionId: 'ws4' });
  inject(cond, work);
  instances.subscribeIdle('cs4', 'ws4'); // no timeoutMs

  const entry = instances._idleSubscribers.get('w4')?.get('c4');
  assert.ok(entry, 'subscription registered');
  assert.notEqual(entry.timerId, null,
    'a default watchdog timer is armed even with no explicit timeoutMs');

  instances.unsubscribeIdle('cs4', 'ws4'); // clears the timer
  instances.byId.delete('c4');
  instances.byId.delete('w4');
});

test('(d) watchdog still fires across a deferral when a subagent never completes', async () => {
  const cond = makeFake({ id: 'c5', sessionId: 'cs5' });
  const work = makeFake({ id: 'w5', sessionId: 'ws5', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs5', 'ws5', 60); // short watchdog

  // turn_end defers (count 1) and must NOT clear the watchdog.
  emitTurnEnd('w5'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'deferred — no completion delivery');

  // Wait past the 60ms watchdog window (measured across the whole deferral).
  await new Promise(r => setTimeout(r, 150));
  assert.equal(cond._promptCalls.length, 1, 'watchdog fired across the deferral');
  assert.match(cond._promptCalls[0].text, /did NOT finish/,
    'watchdog stub is the non-completion "did NOT finish" wording');
  assert.equal(instances._idleHub.hasSubscriber('w5'), false, 'watchdog consumed the subscription');

  instances.byId.delete('c5');
  instances.byId.delete('w5');
});

test('a deferred turn_end still marks the worker consumed (turn_notification stays suppressed)', async () => {
  const cond = makeFake({ id: 'c6', sessionId: 'cs6' });
  const work = makeFake({ id: 'w6', sessionId: 'ws6', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs6', 'ws6');

  emitTurnEnd('w6');
  // wasConsumed() is set synchronously in onTurnEnd (before the microtask that
  // clears it) so the wsHub handler suppresses the worker's ping on the
  // deferred intermediate turn_end too.
  assert.equal(instances._idleHub.wasConsumed('w6'), true,
    'worker marked consumed on the deferred turn_end');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'still deferred (no delivery)');
  assert.equal(instances._idleHub.hasSubscriber('w6'), true);

  cleanup(cond, work);
});

// ---------------------------------------------------------------------------
// Instance-lifecycle tests: the taskNotificationPending set/clear edges,
// driven through a real (unspawned) Instance's _handleStdoutLine with raw
// stdout lines shaped like actual CLI output.
// ---------------------------------------------------------------------------

function makeInstance() {
  return new Instance({
    id: 'i-lifecycle', project: 'test-project', cwd: '/nonexistent-cwd',
    mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
  });
}

const line = (obj) => JSON.stringify(obj);
const MESSAGE_START = line({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0 } } },
});
const taskStarted = (taskId, tu, taskType = 'local_agent') => line({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: tu,
  description: 'bg task', task_type: taskType,
});
const taskNotification = (taskId, tu) => line({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: tu,
  status: 'completed', output_file: '',
});
// A user envelope carrying one tool_result. `parent` non-null makes it a
// subagent-forwarded (nested) result, exactly as the CLI tags them.
const toolResult = (tu, { parent = null, text = 'ok' } = {}) => line({
  type: 'user', parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: [{ type: 'text', text }], is_error: false }] },
});
const TURN_END = line({
  type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 1,
  total_cost_usd: 0, is_error: false,
});

test('lifecycle: sync-delivered task (notification then own tool_result) leaves nothing pending', () => {
  // The dominant real-world shape (fast Agent calls, long Bash promoted to a
  // task — e.g. a full test run): the launching tool_use's held-open
  // tool_result lands right after the mid-turn notification. Nothing is
  // queued, so the turn's end must wake subscribers (the Repro-B hang was
  // this shape deferring forever).
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  assert.equal(inst.status, 'turn');
  inst._handleStdoutLine(taskStarted('t1', 'tu_1'));
  assert.equal(inst.activeAgentTaskCount, 1);
  inst._handleStdoutLine(taskNotification('t1', 'tu_1'));
  assert.equal(inst.taskNotificationPending, true, 'mid-turn notification sets the flag');
  assert.equal(inst.activeAgentTaskCount, 0, 'notification drains the task count');
  inst._handleStdoutLine(toolResult('tu_1', { text: 'full output' }));
  assert.equal(inst.taskNotificationPending, false,
    'the task\'s own top-level tool_result consumes the notification');
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.taskNotificationPending, false, 'nothing owed at turn_end');
});

test('lifecycle: attach-batch — one later top-level tool_result consumes pending notifications', () => {
  // Async shape: the launcher was ack\'d earlier; the completion notification
  // fires mid-turn and the CLI attaches ALL queued notifications to the next
  // outer tool round-trip (batched queue flush) — a tool_result for an
  // UNRELATED tool must clear the flag, including for several notifications.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('t1', 'tu_1'));
  inst._handleStdoutLine(taskStarted('t2', 'tu_2'));
  inst._handleStdoutLine(toolResult('tu_1', { text: 'Async agent launched successfully.' }));
  inst._handleStdoutLine(toolResult('tu_2', { text: 'Async agent launched successfully.' }));
  assert.equal(inst.taskNotificationPending, false, 'acks precede notifications — nothing pending yet');
  inst._handleStdoutLine(taskNotification('t1', 'tu_1'));
  inst._handleStdoutLine(taskNotification('t2', 'tu_2'));
  assert.equal(inst.taskNotificationPending, true);
  inst._handleStdoutLine(toolResult('tu_bash_other', { text: 'some unrelated tool output' }));
  assert.equal(inst.taskNotificationPending, false,
    'any top-level tool_result flushes the queue (attach is batched)');
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.taskNotificationPending, false);
});

test('lifecycle: nested (subagent-forwarded) tool_result does NOT consume', () => {
  // Attachments ride only the OUTER conversation's tool_results. A forwarded
  // subagent-internal tool_result (parent_tool_use_id set) between the
  // notification and turn_end must not clear the flag.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('t1', 'tu_1'));
  inst._handleStdoutLine(taskStarted('t2', 'tu_2'));
  inst._handleStdoutLine(toolResult('tu_1', { text: 'Async agent launched successfully.' }));
  inst._handleStdoutLine(toolResult('tu_2', { text: 'Async agent launched successfully.' }));
  inst._handleStdoutLine(taskNotification('t1', 'tu_1'));
  // t2 is still running and forwards its inner tool round-trips.
  inst._handleStdoutLine(toolResult('tu_inner_bash', { parent: 'tu_2', text: 'inner output' }));
  assert.equal(inst.taskNotificationPending, true,
    'a nested tool_result is not a delivery to the outer model');
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.taskNotificationPending, true, 'still owed at turn_end → hub defers');
});

test('lifecycle: queued notification survives turn_end; the re-invocation turn start clears it', () => {
  // The true a26bbc4 shape: ack\'d async task completes mid-turn, the model
  // ends the turn with no further tool round-trip → the notification is still
  // queued at turn_end (hub defers) and the CLI opens an unprompted
  // re-invocation turn whose start (idle→turn) delivers it.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('t1', 'tu_1'));
  inst._handleStdoutLine(toolResult('tu_1', { text: 'Async agent launched successfully.' }));
  inst._handleStdoutLine(taskNotification('t1', 'tu_1'));
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.taskNotificationPending, true, 'unconsumed at turn_end → hub defers');
  // Unprompted re-invocation turn: message_start flips idle→turn, which
  // clears the flag (the dequeued notification is this turn's input).
  inst._handleStdoutLine(MESSAGE_START);
  assert.equal(inst.status, 'turn');
  assert.equal(inst.taskNotificationPending, false, 're-invocation turn start consumes it');
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.taskNotificationPending, false, 'its turn_end wakes subscribers');
});

test('lifecycle: a Bash task (task_type:local_bash) never enters the count — no defer for a promoted service', () => {
  // The CLI fires the same task lifecycle for Bash tasks (run_in_background,
  // or a timed-out foreground Bash it promotes). A long-lived command (a
  // started server) never emits a terminal event, so tracking it would defer
  // the idle wake until the watchdog. It must be excluded at task_started.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('b1', 'tu_b1', 'local_bash'));
  assert.equal(inst.activeAgentTaskCount, 0, 'local_bash task_started is not tracked');
  inst._handleStdoutLine(toolResult('tu_b1', { text: 'Command running in background with ID: b1' }));
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.activeAgentTaskCount, 0, 'turn_end wakes: no live-subagent defer');
  assert.equal(inst.summary().displayStatus, 'idle', 'no stuck running overlay');
});

test('lifecycle: an unknown task_type still counts (over-report-running polarity)', () => {
  // Same conservatism as TERMINAL_TASK_STATUSES: only the known non-subagent
  // type (local_bash) is excluded, so a future agent-ish type keeps deferring.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('r1', 'tu_r1', 'remote_agent'));
  assert.equal(inst.activeAgentTaskCount, 1, 'unrecognized task_type is tracked');
  inst._handleStdoutLine(taskNotification('r1', 'tu_r1'));
  assert.equal(inst.activeAgentTaskCount, 0);
});

test('lifecycle: a notification while idle never sets the flag', () => {
  // Completion between turns: the CLI dequeues immediately and the
  // re-invocation turn IS the processing turn — no defer state needed.
  const inst = makeInstance();
  inst._handleStdoutLine(MESSAGE_START);
  inst._handleStdoutLine(taskStarted('t1', 'tu_1'));
  inst._handleStdoutLine(toolResult('tu_1', { text: 'Async agent launched successfully.' }));
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.status, 'idle');
  inst._handleStdoutLine(taskNotification('t1', 'tu_1'));
  assert.equal(inst.taskNotificationPending, false, 'idle notification sets nothing');
  assert.equal(inst.activeAgentTaskCount, 0);
});
