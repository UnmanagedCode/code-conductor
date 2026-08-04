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

// The in-flight batch records are stored id-less (the id is the Map key) and
// only materialize with `id` on output.
interface StoredTask {
  subject: string;
  description: string;
  activeForm: string | null;
  status: string;
}

export interface TaskRecord extends StoredTask {
  id: string;
}

export interface TaskCompletion {
  afterSeq: number;
  tasks: TaskRecord[];
}

export interface ReconstructResult {
  completions: TaskCompletion[];
  activeAtEnd: TaskRecord[];
  hadOrphanUpdate: boolean;
}

// The events are the parser's UI events (tool_use / tool_result); only the
// fields this pass reads are declared. `_seq` is stamped on every ring/archive
// event, so it is required here.
export interface TaskEvent {
  kind?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  toolUseId?: string | null;
  _seq: number;
}

// The TaskCreate/TaskUpdate input payloads are untyped wire JSON — read
// defensively (each consumer narrows the field it uses).
interface TaskInput {
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  taskId?: unknown;
  status?: unknown;
}

function taskInputOf(raw: unknown): TaskInput {
  return raw && typeof raw === 'object' ? raw as TaskInput : {};
}

function blockText(b: unknown): string {
  if (!b || typeof b !== 'object') return '';
  const text = (b as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function resultText(ev: TaskEvent): string {
  if (typeof ev.content === 'string') return ev.content;
  if (!Array.isArray(ev.content)) return '';
  return ev.content.map(blockText).join('\n');
}

// Walk `events` (chronological, each carrying `_seq`) and return:
//   completions — [{ afterSeq, tasks }], one per batch that reached all-done;
//                 afterSeq = _seq of the completing TaskUpdate, tasks = the
//                 batch snapshot (same shape wsRouter passes to task_completion).
//   activeAtEnd — the current in-flight batch as a task list, or [] when there
//                 is no batch / every task in it is already completed.
export function reconstructTasks(events: TaskEvent[]): ReconstructResult {
  const tasks = new Map<string, StoredTask>(); // id -> { subject, description, activeForm, status }
  const pendingCreates = new Map<string | null, TaskInput>(); // toolUseId -> { subject, description, activeForm }
  const pendingResults = new Map<string | null, TaskEvent>(); // toolUseId -> resultEv (replay ordering)
  const completions: TaskCompletion[] = [];
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
  const list = (): TaskRecord[] => [...tasks.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, t]) => ({ id, ...t }));

  const applyCreate = (input: TaskInput, resultEv: TaskEvent) => {
    const m = resultText(resultEv).match(CREATE_ID_RE);
    if (!m) return;
    const id = m[1];
    if (tasks.size > 0 && allCompleted()) tasks.clear();
    tasks.set(id, {
      subject: typeof input.subject === 'string' ? input.subject : '(no subject)',
      description: typeof input.description === 'string' ? input.description : '',
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : null,
      status: 'pending',
    });
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'tool_use') {
      if (ev.name === 'TaskCreate') {
        const input = taskInputOf(ev.input);
        const buffered = pendingResults.get(ev.toolUseId ?? null);
        if (buffered) {
          pendingResults.delete(ev.toolUseId ?? null);
          applyCreate(input, buffered);
        } else {
          pendingCreates.set(ev.toolUseId ?? null, {
            subject: typeof input.subject === 'string' ? input.subject : '(no subject)',
            description: typeof input.description === 'string' ? input.description : '',
            activeForm: typeof input.activeForm === 'string' ? input.activeForm : null,
          });
        }
      } else if (ev.name === 'TaskUpdate') {
        const input = taskInputOf(ev.input);
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
      const pending = pendingCreates.get(ev.toolUseId ?? null);
      if (!pending) {
        // Replay ordering: a TaskCreate's result can arrive before its tool_use.
        if (CREATE_ID_RE.test(resultText(ev))) pendingResults.set(ev.toolUseId ?? null, ev);
        continue;
      }
      pendingCreates.delete(ev.toolUseId ?? null);
      applyCreate(pending, ev);
    }
  }

  return { completions, activeAtEnd: isVisible() ? list() : [], hadOrphanUpdate };
}
