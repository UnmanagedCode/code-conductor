// Observes the orchestrator's UI event stream for TaskCreate /
// TaskUpdate tool calls and maintains a live task list per instance.
// The tool's real task IDs aren't in the tool_use input — they're
// allocated by the tool and reported in the matching tool_result text
// ("Task #N created successfully: <subject>"). So we keep a small
// pending map keyed by tool_use_id and bind the id when the result
// arrives.
//
// The tracker is pure state — DOM rendering lives in TaskPanel.
//
// The batch-rollover + completion-edge rules here are MIRRORED server-side in
// src/taskReconstruct.js (used to reconstruct out-of-tail task state). Keep the
// two in sync when changing create-id binding, rollover, or the completion edge.

const CREATE_ID_RE = /Task #(\d+) created/;

export class TaskTracker {
  constructor() {
    // taskId (string) -> { subject, description?, activeForm?, status }
    this.tasks = new Map();
    // toolUseId -> { input } awaiting the matching tool_result that
    // carries the freshly-allocated task id.
    this._pendingCreates = new Map();
    // toolUseId -> tool_result event, for the replay case where the
    // persisted jsonl emits tool_result (from a type:"user" line) before
    // the matching tool_use (from the type:"assistant" envelope written at
    // turn end). When the tool_use TaskCreate later arrives, the buffered
    // result is popped and the task is created immediately.
    this._pendingResults = new Map();
    // Persistent id → { subject, description } map. Outlives batch
    // rollovers so that scrolling back to an OLD TaskUpdate tool block
    // (whose batch has since been cleared from `this.tasks`) can still
    // resolve the task's title + description for the summary line.
    // Renames + description edits are recorded too.
    this._infoHistory = new Map();
    this._listeners = new Set();
    // Snapshots of fully-completed batches, appended in order. Each entry is
    // { tasks: [{id, subject, ...}] }. Rebuilt from the same replayed task
    // events as this.tasks, so it survives page reload / snapshot replay.
    this.completedBatches = [];
  }

  // Public lookups for the tool-block renderer. Returns the most
  // recently-known subject / description for a task id, or null if
  // we've never seen one.
  getSubject(taskId) {
    if (taskId == null) return null;
    return this._infoHistory.get(String(taskId))?.subject ?? null;
  }
  getDescription(taskId) {
    if (taskId == null) return null;
    return this._infoHistory.get(String(taskId))?.description ?? null;
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _notify() { for (const fn of this._listeners) { try { fn(this); } catch { /* ignore */ } } }

  // Snapshot replay calls reset() before re-feeding every event.
  reset() {
    this.tasks.clear();
    this._pendingCreates.clear();
    this._pendingResults.clear();
    this._infoHistory.clear();
    this.completedBatches = [];
    this._notify();
  }

  // Seed the current in-flight batch from the server's `tasksAtTailStart`
  // (see src/taskReconstruct.js — the server sibling of this tracker). Called
  // by the snapshot handler after reset() and BEFORE replaying the tail, so a
  // batch whose TaskCreate is below the tail is present when the tail's
  // TaskUpdates arrive — the panel shows and, if the batch completes inside the
  // tail, the completion edge fires and the inline bubble is synthesized.
  seedActive(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    for (const t of list) {
      const id = String(t.id);
      this.tasks.set(id, {
        subject: t.subject ?? '(no subject)',
        description: t.description ?? '',
        activeForm: t.activeForm ?? null,
        status: t.status ?? 'pending',
      });
      this._infoHistory.set(id, {
        subject: t.subject ?? '(no subject)',
        description: t.description ?? '',
      });
    }
    this._notify();
  }

  // Shared task-creation logic, called from both the normal path (live:
  // tool_use first, then tool_result) and the replay path (jsonl: tool_result
  // first, then tool_use).
  _applyCreate(input, resultEv) {
    const content = typeof resultEv.content === 'string'
      ? resultEv.content
      : Array.isArray(resultEv.content)
        ? resultEv.content.map(b => b?.text ?? '').join('\n')
        : '';
    const m = content.match(CREATE_ID_RE);
    if (!m) return;
    const id = m[1];
    if (this.tasks.size > 0 && this._allCompleted()) {
      this.tasks.clear();
    }
    this.tasks.set(id, {
      subject: input.subject ?? '(no subject)',
      description: input.description ?? '',
      activeForm: input.activeForm ?? null,
      status: 'pending',
    });
    this._infoHistory.set(id, {
      subject: input.subject ?? '(no subject)',
      description: input.description ?? '',
    });
    this._notify();
  }

  apply(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'tool_use') {
      if (ev.name === 'TaskCreate') {
        const input = ev.input ?? {};
        // Replay path: tool_result may have arrived before this tool_use
        // (persisted jsonl writes type:"user" mid-turn, type:"assistant" at
        // turn end). If a buffered result is waiting, consume it now.
        const buffered = this._pendingResults.get(ev.toolUseId);
        if (buffered) {
          this._pendingResults.delete(ev.toolUseId);
          this._applyCreate(input, buffered);
          return;
        }
        this._pendingCreates.set(ev.toolUseId, {
          subject: input.subject ?? '(no subject)',
          description: input.description ?? '',
          activeForm: input.activeForm ?? null,
        });
        return;
      }
      if (ev.name === 'TaskUpdate') {
        const input = ev.input ?? {};
        const id = input.taskId != null ? String(input.taskId) : null;
        if (!id) return;
        // Persistent history follows renames + description edits even
        // when the task isn't in the current batch anymore.
        if (typeof input.subject === 'string' || typeof input.description === 'string') {
          const prev = this._infoHistory.get(id) ?? { subject: null, description: null };
          this._infoHistory.set(id, {
            subject: typeof input.subject === 'string' ? input.subject : prev.subject,
            description: typeof input.description === 'string' ? input.description : prev.description,
          });
        }
        const t = this.tasks.get(id);
        if (input.status === 'deleted') {
          if (t) { this.tasks.delete(id); this._notify(); }
          return;
        }
        if (!t) return;
        const wasVisible = this.isVisible();
        if (typeof input.subject === 'string') t.subject = input.subject;
        if (typeof input.description === 'string') t.description = input.description;
        if (typeof input.activeForm === 'string') t.activeForm = input.activeForm;
        if (typeof input.status === 'string') t.status = input.status;
        // Detect the transition from "some tasks incomplete" → "all done":
        // snapshot the batch so the conversation can show a permanent record.
        if (wasVisible && !this.isVisible() && this.tasks.size > 0) {
          this.completedBatches.push({ tasks: this.list() });
        }
        this._notify();
        return;
      }
      return;
    }
    if (ev.kind === 'tool_result') {
      const pending = this._pendingCreates.get(ev.toolUseId);
      if (!pending) {
        // Live path: tool_use always precedes tool_result, so !pending
        // means this result is for a non-TaskCreate tool — ignore it.
        // Replay path (jsonl ordering): tool_result arrives before its
        // tool_use because type:"user" lines are written mid-turn while
        // type:"assistant" is written at turn end. Buffer it so the
        // matching tool_use TaskCreate can consume it when it arrives.
        const content = typeof ev.content === 'string'
          ? ev.content
          : Array.isArray(ev.content)
            ? ev.content.map(b => b?.text ?? '').join('\n')
            : '';
        if (CREATE_ID_RE.test(content)) {
          this._pendingResults.set(ev.toolUseId, ev);
        }
        return;
      }
      this._pendingCreates.delete(ev.toolUseId);
      this._applyCreate(pending, ev);
    }
  }

  _allCompleted() {
    for (const t of this.tasks.values()) {
      if (t.status !== 'completed') return false;
    }
    return true;
  }

  // True when the panel should render — there's at least one task and
  // not everything is completed yet.
  isVisible() {
    if (this.tasks.size === 0) return false;
    for (const t of this.tasks.values()) {
      if (t.status !== 'completed') return true;
    }
    return false;
  }

  list() {
    // Stable order by numeric task id ascending — matches the order
    // the model created them.
    return [...this.tasks.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([id, t]) => ({ id, ...t }));
  }

  completedCount() {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === 'completed') n++;
    return n;
  }
}

// Renders a TaskTracker into a host element. The host stays in the
// DOM at all times; only its contents are swapped in / out based on
// tracker visibility. That keeps the layout from jumping when the
// last task flips to completed and the panel disappears.
export class TaskPanel {
  constructor(host) {
    this.host = host;
    this.tracker = null;
    this._unsubscribe = null;
    this._render();
  }

  attach(tracker) {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    this.tracker = tracker;
    if (tracker) this._unsubscribe = tracker.onChange(() => this._render());
    this._render();
  }

  _render() {
    const t = this.tracker;
    if (!t || !t.isVisible()) {
      this.host.hidden = true;
      this.host.replaceChildren();
      return;
    }
    const tasks = t.list();
    const done = t.completedCount();
    const head = document.createElement('div');
    head.className = 'task-panel-head';
    head.textContent = `Tasks · ${done}/${tasks.length} done`;

    const ul = document.createElement('ul');
    ul.className = 'task-panel-list';
    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = `task-row task-${task.status}`;
      const marker = document.createElement('span');
      marker.className = 'task-marker';
      marker.textContent = task.status === 'completed' ? '✓'
        : task.status === 'in_progress' ? '▶'
        : '○';
      const text = document.createElement('span');
      text.className = 'task-text';
      // While in_progress prefer activeForm ("Extracting settings.js")
      // over the imperative subject; that mirrors how the tool itself
      // displays it in the user's spinner.
      text.textContent = task.status === 'in_progress' && task.activeForm
        ? task.activeForm
        : task.subject;
      li.append(marker, text);
      ul.appendChild(li);
    }

    this.host.hidden = false;
    this.host.replaceChildren(head, ul);
  }
}
