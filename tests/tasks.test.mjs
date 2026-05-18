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

test('tool_use events for unrelated tools are ignored', () => {
  const t = new TaskTracker();
  t.apply({ kind: 'tool_use', name: 'Bash', toolUseId: 'b1', input: { command: 'ls' } });
  t.apply({ kind: 'tool_result', toolUseId: 'b1', content: 'file1\nfile2', isError: false });
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
