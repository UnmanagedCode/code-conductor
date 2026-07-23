// Pure unit tests for the server-side task reconstructor
// (src/taskReconstruct.js) — the mirror of the client TaskTracker used to
// recover out-of-tail task state for the snapshot seed and lazy-page bubbles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructTasks } from '../src/taskReconstruct.js';

// Build a chronological event list with dense _seq stamped in order.
function seq(events) {
  return events.map((ev, i) => ({ ...ev, _seq: i }));
}
const create = (toolUseId, subject, extra = {}) =>
  ({ kind: 'tool_use', name: 'TaskCreate', toolUseId, input: { subject, ...extra } });
const created = (toolUseId, id, subject) =>
  ({ kind: 'tool_result', toolUseId, content: `Task #${id} created successfully: ${subject}`, isError: false });
const update = (toolUseId, taskId, input) =>
  ({ kind: 'tool_use', name: 'TaskUpdate', toolUseId, input: { taskId, ...input } });

test('create → complete yields one completion with the completing update seq', () => {
  const events = seq([
    create('a', 'A'), created('a', '1', 'A'),
    update('u1', '1', { status: 'in_progress' }),
    update('u2', '1', { status: 'completed' }),
  ]);
  const { completions, activeAtEnd } = reconstructTasks(events);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].afterSeq, 3, 'afterSeq is the completing TaskUpdate _seq');
  assert.deepEqual(completions[0].tasks.map(t => ({ id: t.id, status: t.status })),
    [{ id: '1', status: 'completed' }]);
  assert.deepEqual(activeAtEnd, [], 'nothing in flight once completed');
});

test('in-flight batch is reported in activeAtEnd, no completion', () => {
  const events = seq([
    create('a', 'A'), created('a', '1', 'A'),
    create('b', 'B'), created('b', '2', 'B'),
    update('u1', '1', { status: 'completed' }),
    update('u2', '2', { status: 'in_progress' }),
  ]);
  const { completions, activeAtEnd } = reconstructTasks(events);
  assert.equal(completions.length, 0, 'batch not fully done → no completion');
  assert.deepEqual(activeAtEnd.map(t => ({ id: t.id, status: t.status })),
    [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }]);
});

test('multiple batches roll over, one completion each', () => {
  const events = seq([
    create('a', 'A'), created('a', '1', 'A'),
    update('u1', '1', { status: 'completed' }),          // batch 1 done @ seq 2
    create('b', 'B'), created('b', '2', 'B'),            // new batch clears the old
    update('u2', '2', { status: 'completed' }),          // batch 2 done @ seq 5
  ]);
  const { completions, activeAtEnd } = reconstructTasks(events);
  assert.deepEqual(completions.map(c => c.afterSeq), [2, 5]);
  assert.deepEqual(completions[0].tasks.map(t => t.id), ['1']);
  assert.deepEqual(completions[1].tasks.map(t => t.id), ['2']);
  assert.deepEqual(activeAtEnd, []);
});

test('replay order: tool_result before its tool_use still binds the task', () => {
  const events = seq([
    created('a', '1', 'A'),          // result first (jsonl ordering)
    create('a', 'A'),                // tool_use later
    update('u1', '1', { status: 'completed' }),
  ]);
  const { completions } = reconstructTasks(events);
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0].tasks.map(t => t.id), ['1']);
});

test('status:"deleted" removes the task; an all-deleted batch never "completes"', () => {
  const events = seq([
    create('a', 'A'), created('a', '1', 'A'),
    update('u1', '1', { status: 'deleted' }),
  ]);
  const { completions, activeAtEnd } = reconstructTasks(events);
  assert.equal(completions.length, 0);
  assert.deepEqual(activeAtEnd, []);
});

test('hadOrphanUpdate is true when a TaskUpdate references an absent create', () => {
  // The create for id '1' is not in the scanned events (evicted below the ring).
  const events = seq([
    update('u1', '1', { status: 'in_progress' }),
  ]);
  const { hadOrphanUpdate, activeAtEnd } = reconstructTasks(events);
  assert.equal(hadOrphanUpdate, true, 'orphan update flagged for archive widening');
  assert.deepEqual(activeAtEnd, [], 'orphan update alone binds no task');
});

test('hadOrphanUpdate is false when every update matches a present create', () => {
  const events = seq([
    create('a', 'A'), created('a', '1', 'A'),
    update('u1', '1', { status: 'in_progress' }),
  ]);
  const { hadOrphanUpdate } = reconstructTasks(events);
  assert.equal(hadOrphanUpdate, false);
});

test('hadOrphanUpdate is false for a deleted-id update with no create', () => {
  // A delete of an already-absent id is not a create-eviction signal.
  const events = seq([
    update('u1', '9', { status: 'deleted' }),
  ]);
  const { hadOrphanUpdate } = reconstructTasks(events);
  assert.equal(hadOrphanUpdate, false);
});

test('non-task tool events are ignored', () => {
  const events = seq([
    { kind: 'tool_use', name: 'Bash', toolUseId: 'x', input: { command: 'ls' } },
    { kind: 'tool_result', toolUseId: 'x', content: 'files', isError: false },
    { kind: 'user_echo', text: 'hi' },
  ]);
  const { completions, activeAtEnd } = reconstructTasks(events);
  assert.equal(completions.length, 0);
  assert.deepEqual(activeAtEnd, []);
});
