// Background-task notifications: when a task the model ran in the background
// (a Bash, Agent or Monitor call) completes or fails, the transcript shows one
// system line naming it, its status and its exit code.
//
// The single source for what that line is made of: the rendering rule, the
// sentence parsers, the UI event shape, and the two adapters that build that
// event — from the live stdout `system/task_notification` frame and from the
// persisted `queue-operation` `enqueue` line. Wired by src/parser.ts (live),
// src/transcript.ts (replay), src/eventArchive.ts (correlation) and
// public/blocks.js (render).
//
// A notification renders (`data.notified`) only when its task was started in
// the background and ended `completed` or `failed`. A foreground task's
// notification is not evidence of anything the user asked to watch, and a stop
// (`stopped` live, `killed` or `stopped` persisted) has no line on either path:
// a TaskStop leaves no enqueue at all, and a stop by the session ending is
// persisted under a different status than it streamed.

import type { UiEvent } from './parser.ts';

const RENDERED_STATUSES: readonly string[] = ['completed', 'failed'];

// The CLI's `<summary>` sentence, by task kind. Written from its real shapes:
//   Background command "X" completed (exit code N)
//   Background command "X" completed (exit code N: No matches found)
//   Background command "X" failed with exit code N
//   Background command "X" was stopped
//   Agent "X" finished
//   Agent "X" failed: <reason>
//   Monitor "X" stream ended
//   Monitor "X" script failed (exit N)
//   Monitor "X" ended without producing output (exit N)
// The name is greedy so a quote inside a command's text survives: it ends at the
// last `" <verb>`.
const SENTENCE_RE = /^(Background command|Agent|Monitor) "([\s\S]*)" (?:completed|failed|finished|stream ended|script failed|ended without producing output|was stopped)/;
const SENTENCE_KIND: Record<string, 'command' | 'agent' | 'monitor'> = {
  'Background command': 'command', Agent: 'agent', Monitor: 'monitor',
};
const EXIT_CODE_RE = /(?:\(exit code (\d+)(?::[^)]*)?\)|failed with exit code (\d+)|\(exit (\d+)\))$/;

export function parseTaskSentence(s: string): { kind: 'command' | 'agent' | 'monitor'; name: string } | null {
  const m = SENTENCE_RE.exec(s);
  return m ? { kind: SENTENCE_KIND[m[1]], name: m[2] } : null;
}

// The exit code a command or monitor sentence ends with; null for an Agent
// sentence (whose failure reason is free text) and for anything else.
export function sentenceExitCode(s: string): number | null {
  const kind = parseTaskSentence(s)?.kind;
  if (kind !== 'command' && kind !== 'monitor') return null;
  const m = EXIT_CODE_RE.exec(s);
  if (!m) return null;
  return Number(m[1] ?? m[2] ?? m[3]);
}

export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  outputFile: string;
  name: string | null;
  exitCode: number | null;
  summary: string;
  notified: boolean;
}

// THE constructor of the `system`/`task_notification` event, for the live path
// and replay alike. The literal `kind`/`subtype` pair is read by the replay
// tripwire in tests/archive-correlated-cut.test.mjs. `data.task_id` keeps its
// wire name: Instance's task lifecycle tracking reads it.
export function taskNotificationEvent(n: TaskNotification): UiEvent {
  return {
    kind: 'system', subtype: 'task_notification', toolUseId: n.toolUseId,
    data: {
      task_id: n.taskId, status: n.status, output_file: n.outputFile, name: n.name,
      exitCode: n.exitCode, summary: n.summary.trim(), notified: n.notified,
    },
  };
}

// The task_* frame fields the adapters read. `type`/`subtype` keep it
// assignable from a WireEnvelope.
export interface TaskFrame {
  type?: unknown;
  subtype?: unknown;
  task_id?: unknown;
  tool_use_id?: unknown;
  status?: unknown;
  output_file?: unknown;
  summary?: unknown;
  description?: unknown;
  is_backgrounded?: unknown;
  task_type?: unknown;
}

interface TaskStart {
  description: string | null;
  backgrounded: boolean;
  agent: boolean;
}

// The live stream's `task_started` facts, by task_id — the only place
// "backgrounded" and an Agent's name are stated. One per Parser.
export class TaskStarts {
  private _byId = new Map<string, TaskStart>();

  note(frame: TaskFrame): void {
    if (typeof frame.task_id !== 'string') return;
    this._byId.set(frame.task_id, {
      description: typeof frame.description === 'string' ? frame.description : null,
      backgrounded: frame.is_backgrounded === true,
      agent: frame.task_type === 'local_agent',
    });
  }

  // A background Agent may notify again (each time it stops), so its record is
  // kept; any other task notifies once.
  take(taskId: unknown): TaskStart | null {
    if (typeof taskId !== 'string') return null;
    const start = this._byId.get(taskId) ?? null;
    if (start && !(start.agent && start.backgrounded)) this._byId.delete(taskId);
    return start;
  }
}

// Live adapter: the stdout frame plus its task_started record (null when this
// parser never saw one).
export function taskNotificationFromFrame(frame: TaskFrame, started: TaskStart | null): UiEvent {
  const summary = typeof frame.summary === 'string' ? frame.summary : '';
  const toolUseId = typeof frame.tool_use_id === 'string' ? frame.tool_use_id : null;
  const status = typeof frame.status === 'string' ? frame.status : null;
  return taskNotificationEvent({
    taskId: typeof frame.task_id === 'string' ? frame.task_id : null,
    toolUseId,
    status,
    outputFile: typeof frame.output_file === 'string' ? frame.output_file : '',
    // An Agent's live summary is its result text, so its name comes from task_started.
    name: started?.description ?? parseTaskSentence(summary)?.name ?? null,
    exitCode: started?.agent ? null : sentenceExitCode(summary),
    summary,
    notified: toolUseId != null && status != null && RENDERED_STATUSES.includes(status) && started?.backgrounded === true,
  });
}

// The jsonl line the CLI writes when a notification is queued for the model.
export interface QueueOperationLine {
  type?: unknown;
  operation?: unknown;
  content?: unknown;
}

export function isTaskNotificationEnqueue(line: QueueOperationLine): line is QueueOperationLine & { content: string } {
  return line.type === 'queue-operation' && line.operation === 'enqueue'
    && typeof line.content === 'string' && line.content.startsWith('<task-notification>');
}

const tagValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);

// The CLI escapes exactly these three; `&amp;` last, so an escaped entity stays literal.
const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Replay adapter: the persisted enqueue, written at completion time in the live
// frame's slot. Null for every other line, for an enqueue that is not one task's
// notification (a Monitor stream event, the resume-time "No completion record"
// line), and for a status that does not render. Only background tasks are ever
// enqueued, so an enqueue is the same evidence `is_backgrounded` gives live.
export function taskNotificationFromEnqueue(line: QueueOperationLine): UiEvent | null {
  if (!isTaskNotificationEnqueue(line)) return null;
  const xml = line.content;
  const taskIds = tagValues(xml, 'task-id');
  const [toolUseId] = tagValues(xml, 'tool-use-id');
  const [status] = tagValues(xml, 'status');
  if (taskIds.length !== 1 || toolUseId == null || status == null) return null;
  if (!RENDERED_STATUSES.includes(status)) return null;
  const [rawSentence] = tagValues(xml, 'summary');
  const [rawResult] = tagValues(xml, 'result');
  const [rawOutput] = tagValues(xml, 'output-file');
  const sentence = unescapeXml(rawSentence ?? '');
  return taskNotificationEvent({
    taskId: taskIds[0],
    toolUseId,
    status,
    outputFile: rawOutput == null ? '' : unescapeXml(rawOutput),
    name: parseTaskSentence(sentence)?.name ?? null,
    exitCode: sentenceExitCode(sentence),
    // An Agent's live summary is its result text; the enqueue carries it as <result>.
    summary: rawResult == null ? sentence : unescapeXml(rawResult),
    notified: true,
  });
}
