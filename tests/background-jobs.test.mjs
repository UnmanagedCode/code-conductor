// The pure rules of src/backgroundJobs.ts: which snapshot entries are jobs, what
// survives a later snapshot, the wake stub's jobs block, and which sessions read
// as waiting on a job up the ownership tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileBackgroundJobs, backgroundJobsNote, jobLine, jobWaiters, JOB_TITLE_MAX,
} from '../src/backgroundJobs.ts';

const bash = (task_id, description) => ({ task_id, task_type: 'local_bash', description });
const map = (entries) => new Map(entries);

test('reconcile keeps only local_bash entries — agent and monitor tasks are ignored', () => {
  const next = reconcileBackgroundJobs(new Map(), [
    bash('b1', 'sleep probe'),
    { task_id: 'a1', task_type: 'local_agent', description: 'bg helper' },
    { task_id: 'm1', task_type: 'monitor', description: 'mon' },
  ], 1000);
  assert.deepEqual([...next.entries()], [['b1', { title: 'sleep probe', startedAt: 1000 }]]);
});

test('reconcile: a job already tracked keeps its startedAt and title across a later snapshot', () => {
  const prev = map([['b1', { title: 'sleep probe', startedAt: 1000 }]]);
  const next = reconcileBackgroundJobs(prev, [bash('b1', 'renamed'), bash('b2', 'second')], 5000);
  assert.deepEqual(next.get('b1'), { title: 'sleep probe', startedAt: 1000 });
  assert.deepEqual(next.get('b2'), { title: 'second', startedAt: 5000 });
});

test('reconcile: an id absent from the snapshot is removed', () => {
  const prev = map([['b1', { title: 'x', startedAt: 1 }], ['b2', { title: 'y', startedAt: 2 }]]);
  const next = reconcileBackgroundJobs(prev, [bash('b2', 'y')], 9);
  assert.deepEqual([...next.keys()], ['b2']);
  assert.deepEqual([...reconcileBackgroundJobs(next, [], 10).keys()], []);
});

test('reconcile returns null when membership is unchanged', () => {
  const prev = map([['b1', { title: 'x', startedAt: 1 }]]);
  assert.equal(reconcileBackgroundJobs(prev, [bash('b1', 'x')], 99), null);
  assert.equal(reconcileBackgroundJobs(new Map(), [], 99), null);
  assert.equal(reconcileBackgroundJobs(new Map(), [{ task_id: 'a1', task_type: 'local_agent' }], 99), null,
    'an agent-only snapshot changes no job membership');
});

test('reconcile: a same-size snapshot with a different id is a change', () => {
  const prev = map([['b1', { title: 'x', startedAt: 1 }]]);
  const next = reconcileBackgroundJobs(prev, [bash('b2', 'y')], 5);
  assert.deepEqual([...next.keys()], ['b2']);
});

test('reconcile ignores a malformed frame: non-array tasks → null', () => {
  const prev = map([['b1', { title: 'x', startedAt: 1 }]]);
  for (const tasks of [undefined, null, {}, 'b1']) {
    assert.equal(reconcileBackgroundJobs(prev, tasks, 5), null, `tasks=${JSON.stringify(tasks)}`);
  }
});

test('a no-description job is titled by its command: truncated to JOB_TITLE_MAX, whitespace collapsed', () => {
  // The real CLI 2.1.286 shape (cap E3 in tests/fixtures/bg-bash-jobs.stdout.jsonl):
  // no description → the snapshot's description is the whole command.
  const command = `sleep 12;\n  echo ${'a'.repeat(200)}`;
  const next = reconcileBackgroundJobs(new Map(), [bash('b1', command)], 0);
  const { title } = next.get('b1');
  assert.equal(title.length, JOB_TITLE_MAX);
  assert.ok(title.endsWith('…'), title);
  assert.ok(title.startsWith('sleep 12; echo aaa'), `whitespace collapsed: ${title}`);
});

test('backgroundJobsNote: exact text for two jobs at a fixed now', () => {
  const jobs = [
    { title: 'sleep probe', startedAt: 10_000 },
    { title: 'npm test', startedAt: 10_000 - 90_000 },
  ];
  assert.equal(backgroundJobsNote('sid-1234', jobs, 55_000),
    'Background jobs still running:\n'
    + '- "sleep probe" — running 45s\n'
    + '- "npm test" — running 2m15s\n'
    + 'Worker `sid-1234` is re-invoked when each job exits, and you will be woken again after that turn.');
});

test('backgroundJobsNote is null with no jobs', () => {
  assert.equal(backgroundJobsNote('sid-1234', [], 55_000), null);
});

test('jobLine is the one job rendering', () => {
  assert.equal(jobLine({ title: 't', startedAt: 0 }, 3_600_000), '"t" — running 1h');
});

// Ownership graph helper: edges child → owners.
const graph = (edges) => (id) => edges[id] ?? [];
const inst = (id, { status = 'idle', jobs = 0 } = {}) =>
  ({ id, status, backgroundJobs: Array.from({ length: jobs }, (_, i) => ({ title: `j${i}`, startedAt: 0 })) });

test('jobWaiters: a job on W marks W and every live owner up the chain P ← C ← W', () => {
  const insts = [inst('P'), inst('C'), inst('W', { jobs: 1 })];
  const got = jobWaiters(insts, graph({ W: ['C'], C: ['P'] }));
  assert.deepEqual([...got].sort(), ['C', 'P', 'W']);
});

test('jobWaiters: a dead owner stops the climb — it and everything above it stay unmarked', () => {
  const insts = [inst('P'), inst('C', { status: 'exited' }), inst('W', { jobs: 1 })];
  const got = jobWaiters(insts, graph({ W: ['C'], C: ['P'] }));
  assert.deepEqual([...got].sort(), ['W']);
});

test('jobWaiters: a dead session with a leftover job seeds nothing', () => {
  const insts = [inst('P'), inst('W', { status: 'crashed', jobs: 1 })];
  assert.deepEqual([...jobWaiters(insts, graph({ W: ['P'] }))], []);
});

test('jobWaiters: cyclic ownership terminates', () => {
  const insts = [inst('A', { jobs: 1 }), inst('B')];
  const got = jobWaiters(insts, graph({ A: ['B'], B: ['A'] }));
  assert.deepEqual([...got].sort(), ['A', 'B']);
});

test('jobWaiters: a sibling of W and a session with no job below it stay unmarked', () => {
  const insts = [inst('P'), inst('W', { jobs: 1 }), inst('S'), inst('Q'), inst('R')];
  const got = jobWaiters(insts, graph({ W: ['P'], S: ['P'], R: ['Q'] }));
  assert.deepEqual([...got].sort(), ['P', 'W']);
});
