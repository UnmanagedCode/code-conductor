// Pure-state tests for TaskTracker — no DOM involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// tasks.js uses `document` only inside TaskPanel — TaskTracker itself
// is DOM-free and import-safe in plain Node.
const { TaskTracker } = await import(pathToFileURL(path.join(PUB, 'tasks.js')).href);

// Helper: simulate the orchestrator's two-step "create" — tool_use
// followed by the tool_result that carries the freshly-allocated id.
function feedCreate(tracker, { toolUseId, subject, description = '', activeForm = null, taskId }) {
  tracker.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId, input: { subject, description, activeForm } });
  tracker.apply({ kind: 'tool_result', toolUseId, content: `Task #${taskId} created successfully: ${subject}`, isError: false });
}

test('TaskCreate adds a pending task once the tool_result parses out the id', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'Do thing A' });
  assert.equal(t.list().length, 1);
  assert.equal(t.list()[0].id, '1');
  assert.equal(t.list()[0].status, 'pending');
  assert.equal(t.list()[0].subject, 'Do thing A');
  assert.equal(t.isVisible(), true);
});

test('TaskUpdate before the tool_result is ignored (no task to update yet)', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu1', input: { subject: 'A' } });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu2', input: { taskId: '1', status: 'in_progress' } });
  // tool_result hasn't bound id "1" yet, so the update is silently dropped.
  assert.equal(t.list().length, 0);
});

test('TaskUpdate flips status, swaps subject + activeForm', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '7', subject: 'Refactor X', activeForm: 'Refactoring X' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu2',
    input: { taskId: '7', status: 'in_progress' } });
  assert.equal(t.list()[0].status, 'in_progress');
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu3',
    input: { taskId: '7', subject: 'Refactor X (renamed)', activeForm: 'Renaming X' } });
  assert.equal(t.list()[0].subject, 'Refactor X (renamed)');
  assert.equal(t.list()[0].activeForm, 'Renaming X');
});

test('TaskUpdate with status:"deleted" removes the task', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '3', subject: 'X' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu2', input: { taskId: '3', status: 'deleted' } });
  assert.equal(t.list().length, 0);
  assert.equal(t.isVisible(), false);
});

test('Panel hides only when every task is completed', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'B' });
  assert.equal(t.isVisible(), true, 'two pending → visible');
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu3', input: { taskId: '1', status: 'completed' } });
  assert.equal(t.isVisible(), true, 'one of two completed → still visible');
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu4', input: { taskId: '2', status: 'completed' } });
  assert.equal(t.isVisible(), false, 'all completed → hidden');
});

test('list() returns tasks sorted by numeric id ascending (creation order)', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu_a', taskId: '10', subject: 'late' });
  feedCreate(t, { toolUseId: 'tu_b', taskId: '2', subject: 'early' });
  feedCreate(t, { toolUseId: 'tu_c', taskId: '5', subject: 'middle' });
  assert.deepEqual(t.list().map(x => x.subject), ['early', 'middle', 'late']);
});

test('reset() clears state + notifies subscribers', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  let notified = 0;
  t.onChange(() => notified++);
  t.reset();
  assert.equal(t.list().length, 0);
  assert.equal(notified, 1);
});

test('completedCount + isVisible track the running totals', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'B' });
  feedCreate(t, { toolUseId: 'tu3', taskId: '3', subject: 'C' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu_x', input: { taskId: '2', status: 'completed' } });
  assert.equal(t.completedCount(), 1);
  assert.equal(t.isVisible(), true);
});

test('a new TaskCreate after every task is completed starts a fresh batch (drops the historical ✓s)', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'B' });
  // Finish the first batch.
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u2', input: { taskId: '2', status: 'completed' } });
  assert.equal(t.isVisible(), false, 'panel hidden after batch completes');

  // Next TaskCreate should clear the old completed rows and start fresh.
  feedCreate(t, { toolUseId: 'tu3', taskId: '3', subject: 'C' });
  assert.deepEqual(t.list().map(x => x.id), ['3'],
    `batch should contain only the new task; got: ${JSON.stringify(t.list().map(x => x.id))}`);
  assert.equal(t.isVisible(), true);
  assert.equal(t.completedCount(), 0, 'completedCount also resets with the batch');
});

test('a new TaskCreate while at least one task is still pending JOINS the current batch', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'B' });
  // Complete only one — the other is still pending.
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  feedCreate(t, { toolUseId: 'tu3', taskId: '3', subject: 'C' });
  // All three should be visible — the partially-completed batch stays.
  assert.deepEqual(t.list().map(x => x.id), ['1', '2', '3']);
  assert.equal(t.completedCount(), 1);
});

test('getSubject + getDescription survive a batch rollover', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'Old A', description: 'longer desc A' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'Old B', description: 'longer desc B' });
  // Complete the batch.
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u2', input: { taskId: '2', status: 'completed' } });
  // Open a fresh batch — drops the old completed entries from `tasks`.
  feedCreate(t, { toolUseId: 'tu3', taskId: '3', subject: 'Fresh', description: 'new work' });
  assert.equal(t.list().map(x => x.id).join(','), '3');
  // ... but the renderer must still be able to resolve old subjects /
  // descriptions when the user scrolls back to those old TaskUpdate
  // tool blocks in the conversation.
  assert.equal(t.getSubject('1'), 'Old A');
  assert.equal(t.getDescription('1'), 'longer desc A');
  assert.equal(t.getSubject('2'), 'Old B');
  assert.equal(t.getSubject('3'), 'Fresh');
});

test('reset() clears the persistent subject history too', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A', description: 'A desc' });
  t.reset();
  assert.equal(t.getSubject('1'), null);
  assert.equal(t.getDescription('1'), null);
});

test('tool_use events for unrelated tools are ignored', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_use', name: 'Bash', toolUseId: 'b1', input: { command: 'ls' } });
  t.apply({ kind: 'tool_result', toolUseId: 'b1', content: 'file1\nfile2', isError: false });
  assert.equal(t.list().length, 0);
});

// Replay-order tests — jsonl emits tool_result (type:"user" mid-turn) before
// tool_use (type:"assistant" written at turn end), opposite of live order.
test('replay: tool_result arriving before its tool_use still creates the task', () => {
  const t = new TaskTracker();
  // Replay order: result first, then tool_use
  t.apply({ kind: 'tool_result', toolUseId: 'tu1', content: 'Task #1 created successfully: My task', isError: false });
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu1', input: { subject: 'My task' } });
  assert.equal(t.list().length, 1);
  assert.equal(t.list()[0].id, '1');
  assert.equal(t.list()[0].subject, 'My task');
  assert.equal(t.list()[0].status, 'pending');
  assert.equal(t.isVisible(), true);
});

test('replay: task subject comes from the tool_use input even when result arrives first', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_result', toolUseId: 'tu1', content: 'Task #5 created', isError: false });
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu1', input: { subject: 'Subject from tool_use', description: 'Some desc' } });
  assert.equal(t.list()[0].subject, 'Subject from tool_use');
  assert.equal(t.list()[0].id, '5');
  assert.equal(t.getDescription('5'), 'Some desc');
});

test('replay: subsequent TaskUpdate applies correctly after deferred create', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_result', toolUseId: 'tu1', content: 'Task #2 created', isError: false });
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu1', input: { subject: 'Work' } });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'tu2', input: { taskId: '2', status: 'in_progress' } });
  assert.equal(t.list()[0].status, 'in_progress');
  assert.equal(t.isVisible(), true);
});

test('replay: batch rollover works correctly when result arrives before tool_use', () => {
  const t = new TaskTracker();
  // Batch 1 via normal order (live)
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'First' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  assert.equal(t.isVisible(), false, 'batch 1 done');
  // Batch 2 via replay order (result before tool_use)
  t.apply({ kind: 'tool_result', toolUseId: 'tu2', content: 'Task #2 created successfully: Second', isError: false });
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu2', input: { subject: 'Second' } });
  assert.deepEqual(t.list().map(x => x.id), ['2'], 'old completed batch cleared, new task present');
  assert.equal(t.isVisible(), true);
});

test('replay: non-TaskCreate tool_result with similar text is not buffered', () => {
  const t = new TaskTracker();
  // A Bash result that happens to contain "Task #1 created" in output —
  // should NOT be buffered since it belongs to a Bash tool_use, not TaskCreate.
  // In practice this is extremely rare but we verify the tracker stays clean.
  t.apply({ kind: 'tool_result', toolUseId: 'bash1', content: 'Task #1 created by script', isError: false });
  t.apply({ kind: 'tool_use', name: 'Bash', toolUseId: 'bash1', input: { command: 'make' } });
  // The Bash tool_use doesn't match 'TaskCreate', so the buffered result
  // remains in _pendingResults but no task is created.
  assert.equal(t.list().length, 0);
});

test('replay: reset() clears pending buffered results', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_result', toolUseId: 'tu1', content: 'Task #1 created', isError: false });
  t.reset();
  // After reset, the buffered result is gone — applying the tool_use has no effect.
  t.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'tu1', input: { subject: 'Ghost' } });
  assert.equal(t.list().length, 0);
});

test('TaskPanel renders rows, swaps active marker, hides when all completed (happy-dom)', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;

  // Re-import with DOM globals defined this time so TaskPanel works.
  const url = pathToFileURL(path.join(PUB, 'tasks.js')).href + '?dom=1';
  const { TaskTracker: Tracker2, TaskPanel } = await import(url);

  document.body.innerHTML = '<div id="host" hidden></div>';
  const host = document.getElementById('host');
  const tracker = new Tracker2();
  const panel = new TaskPanel(host);
  panel.attach(tracker);

  // Empty tracker → host hidden.
  assert.equal(host.hidden, true);

  // Create two tasks; one goes in_progress with an activeForm.
  tracker.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'a',
    input: { subject: 'Do A', activeForm: 'Doing A' } });
  tracker.apply({ kind: 'tool_result', toolUseId: 'a', content: 'Task #1 created', isError: false });
  tracker.apply({ kind: 'tool_use', name: 'TaskCreate', toolUseId: 'b', input: { subject: 'Do B' } });
  tracker.apply({ kind: 'tool_result', toolUseId: 'b', content: 'Task #2 created', isError: false });
  tracker.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'c',
    input: { taskId: '1', status: 'in_progress' } });

  assert.equal(host.hidden, false);
  const rows = host.querySelectorAll('.task-row');
  assert.equal(rows.length, 2);
  // The in_progress row shows the activeForm text + ▶ marker.
  const active = host.querySelector('.task-row.task-in_progress');
  assert.ok(active);
  assert.equal(active.querySelector('.task-marker').textContent, '▶');
  assert.equal(active.querySelector('.task-text').textContent, 'Doing A');

  // Complete both → panel hides.
  tracker.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'd',
    input: { taskId: '1', status: 'completed' } });
  tracker.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'e',
    input: { taskId: '2', status: 'completed' } });
  assert.equal(host.hidden, true);
});

test('completedBatches is empty initially and after reset()', () => {
  const t = new TaskTracker();
  assert.deepEqual(t.completedBatches, []);
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'A' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  assert.equal(t.completedBatches.length, 1);
  t.reset();
  assert.deepEqual(t.completedBatches, []);
});

test('completedBatches records a snapshot when the last task flips to completed', () => {
  const t = new TaskTracker();
  feedCreate(t, { toolUseId: 'tu1', taskId: '1', subject: 'Task Alpha' });
  feedCreate(t, { toolUseId: 'tu2', taskId: '2', subject: 'Task Beta' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  assert.equal(t.completedBatches.length, 0, 'only one of two done — no snapshot yet');
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u2', input: { taskId: '2', status: 'completed' } });
  assert.equal(t.completedBatches.length, 1, 'snapshot recorded after last task done');
  const snap = t.completedBatches[0].tasks;
  assert.equal(snap.length, 2);
  assert.equal(snap[0].subject, 'Task Alpha');
  assert.equal(snap[1].subject, 'Task Beta');
  assert.ok(snap.every(x => x.status === 'completed'));
});

test('completedBatches accumulates one entry per batch across multiple batches', () => {
  const t = new TaskTracker();
  // Batch 1
  feedCreate(t, { toolUseId: 'a1', taskId: '1', subject: 'First' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u1', input: { taskId: '1', status: 'completed' } });
  assert.equal(t.completedBatches.length, 1);
  // Batch 2
  feedCreate(t, { toolUseId: 'a2', taskId: '2', subject: 'Second' });
  feedCreate(t, { toolUseId: 'a3', taskId: '3', subject: 'Third' });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u2', input: { taskId: '2', status: 'completed' } });
  t.apply({ kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'u3', input: { taskId: '3', status: 'completed' } });
  assert.equal(t.completedBatches.length, 2);
  assert.equal(t.completedBatches[0].tasks[0].subject, 'First');
  assert.equal(t.completedBatches[1].tasks.map(x => x.subject).join(','), 'Second,Third');
});

test('completedBatches snapshot is idempotent on replay (reset + re-apply)', () => {
  const t = new TaskTracker();
  const events = [
    { kind: 'tool_use', name: 'TaskCreate', toolUseId: 'a', input: { subject: 'X' } },
    { kind: 'tool_result', toolUseId: 'a', content: 'Task #1 created successfully: X', isError: false },
    { kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'b', input: { taskId: '1', status: 'completed' } },
  ];
  for (const ev of events) t.apply(ev);
  assert.equal(t.completedBatches.length, 1);
  // Simulate snapshot replay: reset then re-apply the same events.
  t.reset();
  for (const ev of events) t.apply(ev);
  assert.equal(t.completedBatches.length, 1, 'exactly one batch after re-applying same events');
  assert.equal(t.completedBatches[0].tasks[0].subject, 'X');
});

test('snapshot replay: feeding a long stream rebuilds state deterministically', () => {
  const t = new TaskTracker();
  const stream = [
    { kind: 'tool_use', name: 'TaskCreate', toolUseId: 'a', input: { subject: 'A', activeForm: 'Doing A' } },
    { kind: 'tool_result', toolUseId: 'a', content: 'Task #1 created successfully: A', isError: false },
    { kind: 'tool_use', name: 'TaskCreate', toolUseId: 'b', input: { subject: 'B' } },
    { kind: 'tool_result', toolUseId: 'b', content: 'Task #2 created successfully: B', isError: false },
    { kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'c', input: { taskId: '1', status: 'in_progress' } },
    { kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'd', input: { taskId: '1', status: 'completed' } },
    { kind: 'tool_use', name: 'TaskUpdate', toolUseId: 'e', input: { taskId: '2', status: 'in_progress' } },
  ];
  for (const ev of stream) t.apply(ev);
  assert.deepEqual(t.list().map(x => ({ id: x.id, status: x.status })),
    [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }]);
  assert.equal(t.isVisible(), true);
});
