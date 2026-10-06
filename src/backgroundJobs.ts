// Background Bash jobs — a worker's `Bash` calls with `run_in_background:true`
// that are still running after its turn ended. The CLI re-invokes the worker
// when each one exits, so they are display state (the session and every live
// owner above it read as "waiting") and a line in the owner's wake stub — never
// a hold on the wake itself.
//
// The single source is the CLI's `system/background_tasks_changed` frame: a
// level-triggered snapshot of EVERY live background task, emitted whenever the
// set changes (start, exit, TaskStop, stdin-EOF shutdown, a subagent's own
// background Bash). The one gap is the CLI process dying without a frame, which
// Instance closes by clearing on exit and on (re)spawn. Wire shapes and the
// lifecycle table: docs/protocol.md → "Background Bash jobs".

import { trunc } from './mcp/textRender.ts';
import { humanizeDuration } from './duration.ts';
import { isDeadStatus } from './instances.ts';

export interface BackgroundJob {
  title: string;
  // cc's clock (epoch ms) when the job's id first appeared in a snapshot; the
  // frame itself carries no timestamp.
  startedAt: number;
}

// The CLI substitutes the full command for a missing `description`, so one
// truncation rule yields "description, else truncated command".
export const JOB_TITLE_MAX = 100;

// Fold one snapshot's `tasks` into the tracked jobs. Only `local_bash` entries
// count (Agent and Monitor tasks have their own lifecycle). An id already
// tracked keeps its entry, so `startedAt` survives later snapshots. Returns
// null when membership is unchanged — or the frame is malformed — so the caller
// emits nothing.
export function reconcileBackgroundJobs(
  prev: Map<string, BackgroundJob>, tasks: unknown, now: number,
): Map<string, BackgroundJob> | null {
  if (!Array.isArray(tasks)) return null;
  const next = new Map<string, BackgroundJob>();
  for (const t of tasks) {
    const task = t as { task_id?: unknown; task_type?: unknown; description?: unknown } | null;
    if (!task || task.task_type !== 'local_bash' || typeof task.task_id !== 'string') continue;
    next.set(task.task_id, prev.get(task.task_id)
      ?? { title: trunc(task.description, JOB_TITLE_MAX), startedAt: now });
  }
  if (next.size === prev.size && [...next.keys()].every(id => prev.has(id))) return null;
  return next;
}

// `"<title>" — running <duration>`: the one rendering of a job, shared by the
// wake stub and the MCP worker block.
export function jobLine(job: BackgroundJob, now: number): string {
  return `"${job.title}" — running ${humanizeDuration(now - job.startedAt)}`;
}

// The wake stub's jobs block, or null when there are none.
export function backgroundJobsNote(sessionId: string, jobs: BackgroundJob[], now: number): string | null {
  if (!jobs.length) return null;
  return [
    'Background jobs still running:',
    ...jobs.map(j => `- ${jobLine(j, now)}`),
    `Worker \`${sessionId}\` is re-invoked when each job exits, and you will be woken again after that turn.`,
  ].join('\n');
}

// Every instance that reads as waiting on a background job: each live instance
// with a job of its own, and every live owner above it (spawn ∪ dispatch — the
// owners the re-invocation turn will wake). A dead owner stops the climb; the
// visited set makes cyclic ownership terminate.
export function jobWaiters(
  insts: Array<{ id: string; status: string; backgroundJobs: BackgroundJob[] }>,
  ownersOf: (id: string) => string[],
): Set<string> {
  const live = new Set(insts.filter(i => !isDeadStatus(i.status)).map(i => i.id));
  const out = new Set<string>();
  const queue = insts.filter(i => live.has(i.id) && i.backgroundJobs.length > 0).map(i => i.id);
  for (const id of queue) out.add(id);
  while (queue.length) {
    const id = queue.shift() as string;
    for (const owner of ownersOf(id)) {
      if (!live.has(owner) || out.has(owner)) continue;
      out.add(owner);
      queue.push(owner);
    }
  }
  return out;
}
