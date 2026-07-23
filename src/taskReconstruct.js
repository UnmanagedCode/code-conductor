// Server-side, single-pass, chronological reconstruction of task-batch state
// from the raw tool_use/tool_result event stream (TaskCreate / TaskUpdate).
//
// This MIRRORS the client TaskTracker in public/tasks.js — the two implement
// the SAME batch-rollover + completion-edge rules and MUST stay in sync. If you
// change the create-id binding, rollover (`_allCompleted` → clear on next
// create), or the completion edge (`wasVisible && !isVisible()`) here, change it
// there too, and vice-versa.
//
// Used by:
//   - src/instances.js  → Instance.reconstructActiveTasks() (snapshot seed)
//   - src/wsHub.js       → snapshot frame `tasksAtTailStart`
//   - src/eventArchive.js → inject synthetic `task_completion` into paged history
//
// task_completion is never a real wire event — it is derived here (and, for the
// live/tail path, synthesized client-side in wsRouter.js). Callers assemble it
// into the events they deliver.

const CREATE_ID_RE = /Task #(\d+) created/;

function resultText(ev) {
  return typeof ev.content === 'string'
    ? ev.content
    : Array.isArray(ev.content)
      ? ev.content.map(b => b?.text ?? '').join('\n')
      : '';
}

// Walk `events` (chronological, each carrying `_seq`) and return:
//   completions — [{ afterSeq, tasks }], one per batch that reached all-done;
//                 afterSeq = _seq of the completing TaskUpdate, tasks = the
//                 batch snapshot (same shape wsRouter passes to task_completion).
//   activeAtEnd — the current in-flight batch as a task list, or [] when there
//                 is no batch / every task in it is already completed.
export function reconstructTasks(events) {
  const tasks = new Map();          // id -> { subject, description, activeForm, status }
  const pendingCreates = new Map(); // toolUseId -> { subject, description, activeForm }
  const pendingResults = new Map(); // toolUseId -> resultEv (replay ordering)
  const completions = [];
  // True when a non-deleted TaskUpdate referenced an id whose TaskCreate is
  // absent from the scanned events — the signal that the create was evicted
  // below the ring and the caller should widen the scan to the jsonl archive.
  let hadOrphanUpdate = false;

  const allCompleted = () => {
    for (const t of tasks.values()) if (t.status !== 'completed') return false;
    return true;
  };
  const isVisible = () => {
    if (tasks.size === 0) return false;
    for (const t of tasks.values()) if (t.status !== 'completed') return true;
    return false;
  };
  const list = () => [...tasks.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, t]) => ({ id, ...t }));

  const applyCreate = (input, resultEv) => {
    const m = resultText(resultEv).match(CREATE_ID_RE);
    if (!m) return;
    const id = m[1];
    if (tasks.size > 0 && allCompleted()) tasks.clear();
    tasks.set(id, {
      subject: input.subject ?? '(no subject)',
      description: input.description ?? '',
      activeForm: input.activeForm ?? null,
      status: 'pending',
    });
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'tool_use') {
      if (ev.name === 'TaskCreate') {
        const input = ev.input ?? {};
        const buffered = pendingResults.get(ev.toolUseId);
        if (buffered) {
          pendingResults.delete(ev.toolUseId);
          applyCreate(input, buffered);
        } else {
          pendingCreates.set(ev.toolUseId, {
            subject: input.subject ?? '(no subject)',
            description: input.description ?? '',
            activeForm: input.activeForm ?? null,
          });
        }
      } else if (ev.name === 'TaskUpdate') {
        const input = ev.input ?? {};
        const id = input.taskId != null ? String(input.taskId) : null;
        if (!id) continue;
        const t = tasks.get(id);
        if (input.status === 'deleted') { if (t) tasks.delete(id); continue; }
        if (!t) { hadOrphanUpdate = true; continue; }
        const wasVisible = isVisible();
        if (typeof input.subject === 'string') t.subject = input.subject;
        if (typeof input.description === 'string') t.description = input.description;
        if (typeof input.activeForm === 'string') t.activeForm = input.activeForm;
        if (typeof input.status === 'string') t.status = input.status;
        if (wasVisible && !isVisible() && tasks.size > 0) {
          completions.push({ afterSeq: ev._seq, tasks: list() });
        }
      }
    } else if (ev.kind === 'tool_result') {
      const pending = pendingCreates.get(ev.toolUseId);
      if (!pending) {
        // Replay ordering: a TaskCreate's result can arrive before its tool_use.
        if (CREATE_ID_RE.test(resultText(ev))) pendingResults.set(ev.toolUseId, ev);
        continue;
      }
      pendingCreates.delete(ev.toolUseId);
      applyCreate(pending, ev);
    }
  }

  return { completions, activeAtEnd: isVisible() ? list() : [], hadOrphanUpdate };
}
