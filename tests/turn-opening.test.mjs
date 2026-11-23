// A turn the CLI opens on its own starts, for cc, at the CLI's opener — the
// first top-level `system/init` or UserPromptSubmit `hook_started` after a
// `result` — not at `stream_event message_start`, which waits on the hooks and
// the API. Each test replays a real stdout shape (tests/fixtures/cli-queue, see
// tests/queued-prompt-pending.test.mjs for how the fixtures were derived) and
// reads the conductor's list() row at the conductor's own `result`, the snapshot
// the client turns into a "finished" notification when it reads
// idle / awaitingWake:false / waitingOnJob:false.
//   idle-task-reinvocation    : a worker's turn ends with a background Bash job
//                               running; the job finishes while the worker is
//                               idle (task_updated, task_notification,
//                               background_tasks_changed) and the CLI opens a
//                               re-invocation turn (init, status, message_start)
//   queued-after-end-ups-hook : a conductor with a UserPromptSubmit hook whose
//                               queued turns each open with that hook's
//                               `hook_started`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posixPlatform } from '../src/platform/posix.ts';
import { InstanceManager } from '../src/instances.ts';
import { load, kind, indexesOf, makeInstance, wire, feed, microtasks } from './cliQueueRig.mjs';

const rowOf = (instances, id) => instances.list().find((r) => r.id === id);

// Invariant (M3): a worker's idle-time re-invocation turn arms its owner at the
// worker's opener. A conductor whose own turn ends after the worker's `init` and
// before the worker's `message_start` reads awaitingWake:true at its `result`.
test('a worker\'s idle-time re-invocation arms its owner at the worker\'s init', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const w = await load('idle-task-reinvocation.stdout.jsonl');
    const c = await load('queued-after-end.stdout.jsonl');
    const wResult = w.findIndex((l) => kind(l) === 'result:success');
    const wNotify = w.findIndex((l) => kind(l) === 'system:task_notification');
    const wInit = w.findIndex((l, i) => i > wResult && kind(l) === 'system:init');
    const wStart = w.findIndex((l, i) => i > wInit && kind(l) === 'stream_event:message_start');
    assert.ok(wResult < wNotify && wNotify < wInit && wInit < wStart, 'fixture shape: result, notification, init, message_start');
    const cResult = c.findIndex((l) => kind(l) === 'result:success');

    const conductor = makeInstance('c');
    const worker = makeInstance('w');
    wire(instances, conductor);
    wire(instances, worker);
    feed(worker, w.slice(0, wResult + 1));
    assert.equal(worker.status, 'idle', 'premise: the worker finished its turn');
    feed(conductor, c.slice(0, 1));
    assert.equal(conductor.status, 'turn', 'premise: the conductor is mid-turn');
    instances.noteDispatch('c-sid', 'w-sid');
    assert.equal(instances._idleHub.hasArmedWake('w'), false, 'premise: nothing armed for the idle worker');

    feed(worker, w.slice(wResult + 1, wInit + 1));
    const workerAtInit = worker.status;
    const turnEnds = conductor.liveTurnEnds;
    feed(conductor, c.slice(1, cResult + 1));
    const row = rowOf(instances, 'c');
    assert.equal(row.status, 'idle');
    assert.equal(conductor.liveTurnEnds, turnEnds + 1, 'premise: a counted turn end');
    assert.equal(row.awaitingWake, true, 'the conductor awaits the worker\'s re-invocation turn');
    assert.equal(workerAtInit, 'turn', 'the re-invocation turn opened at init');
    feed(worker, w.slice(wInit + 1, wStart + 1));
    assert.equal(rowOf(instances, 'c').awaitingWake, true);
  } finally {
    await instances.shutdown().catch(() => {});
  }
});

// Invariant (M1): a wake delivered after the conductor's queued turn has opened
// (its UserPromptSubmit `hook_started`) is written into a running turn, so it
// parks; the conductor's row stays awaitingWake:true at that turn's `result` and
// until the next opener starts the turn for the wake.
test('a wake delivered after the conductor\'s opener parks and holds across that turn\'s result', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
    const results = indexesOf(lines, 'result:success');
    const openers = indexesOf(lines, 'system:hook_started(UserPromptSubmit)');
    assert.ok(openers[0] > results[0] && results[1] > openers[0] && openers[1] > results[1]);
    const conductor = makeInstance('c');
    const a = makeInstance('a');
    const b = makeInstance('b');
    for (const w of [a, b]) { w.status = 'turn'; instances.byId.set(w.id, w); }
    wire(instances, conductor);
    feed(conductor, lines.slice(0, 1));
    instances.noteDispatch('c-sid', 'a-sid');
    instances.noteDispatch('c-sid', 'b-sid');
    instances._idleHub.onTurnStart('a');
    instances._idleHub.onTurnStart('b');
    const row = () => rowOf(instances, 'c');
    const finish = async (w) => {
      w.status = 'idle';
      instances.emit('event', { id: w.id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
      await microtasks();
    };

    // Wake A goes into the running turn and is queued past its end.
    await finish(a);
    assert.equal(instances._idleHub._parked.get('c')?.length, 1, 'premise: wake A parked');
    feed(conductor, lines.slice(1, results[0] + 1));
    assert.equal(row().status, 'idle');
    assert.equal(row().awaitingWake, true, 'A not yet taken in');
    feed(conductor, lines.slice(results[0] + 1, openers[0] + 1));
    const atOpener = { status: conductor.status, parked: instances._idleHub._parked.has('c') };

    // Wake B arrives while A's turn is opening (before its message_start).
    await finish(b);
    const afterB = { pending: conductor.queuedPromptPending, parked: instances._idleHub._parked.get('c')?.length };
    feed(conductor, lines.slice(openers[0] + 1, results[1] + 1));
    assert.equal(row().status, 'idle');
    assert.equal(row().awaitingWake, true, 'A\'s turn ended with B still queued');
    assert.deepEqual(atOpener, { status: 'turn', parked: false }, 'A\'s turn opened and released A');
    assert.deepEqual(afterB, { pending: true, parked: 1 }, 'B was written into a running turn and parked');
    feed(conductor, lines.slice(results[1] + 1, openers[1] + 1));
    assert.equal(row().status, 'turn');
    assert.equal(row().awaitingWake, false, 'B\'s turn opened');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});

// Invariant (M2): a parked conductor's queued turn opening with a UserPromptSubmit
// `hook_started` cancels the park backstop at once, however long the hook then
// runs, and the row never reads idle without awaitingWake from the conductor's
// `result` through the queued turn's `message_start`.
test('a UserPromptSubmit hook_started after a parked conductor\'s result cancels the park backstop', async () => {
  const instances = new InstanceManager({ platform: posixPlatform });
  try {
    const lines = await load('queued-after-end-ups-hook.stdout.jsonl');
    const opener = indexesOf(lines, 'system:hook_started(UserPromptSubmit)')[0];
    const start = lines.findIndex((l, i) => i > opener && kind(l) === 'stream_event:message_start');
    const hub = instances._idleHub;
    const timers = [];
    hub._setTimer = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; };
    hub._clearTimer = (h) => { h.cleared = true; };
    const conductor = makeInstance('c');
    const worker = makeInstance('w');
    worker.status = 'turn';
    instances.byId.set('w', worker);
    wire(instances, conductor);
    feed(conductor, lines.slice(0, 1));
    instances.noteDispatch('c-sid', 'w-sid');
    hub.onTurnStart('w');
    worker.status = 'idle';
    instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await microtasks();
    assert.equal(hub._parked.get('c')?.length, 1, 'premise: parked');

    const finishedReads = [];
    const check = (i) => {
      const r = rowOf(instances, 'c');
      if (r.status === 'idle' && !r.awaitingWake) finishedReads.push(i);
    };
    for (let i = 1; i <= opener; i++) { feed(conductor, [lines[i]]); check(i); }
    assert.equal(timers.length, 1, 'premise: the backstop armed at the result');
    const pendingAtOpener = hub._parkTimers.size;
    // The hook outlasts PARKED_BACKSTOP_MS: whatever backstop is still pending fires.
    for (const t of timers) if (!t.cleared) t.fn();
    check('after the backstop delay');
    for (let i = opener + 1; i <= start; i++) { feed(conductor, [lines[i]]); check(i); }
    assert.deepEqual(finishedReads, [], 'never read as finished');
    assert.equal(pendingAtOpener, 0, 'no backstop pending once the turn opened');
    assert.equal(timers[0].cleared, true, 'the backstop was cancelled');
  } finally {
    await instances.shutdown().catch(() => {});
  }
});
