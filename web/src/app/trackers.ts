// Per-instance task + context-usage trackers and the account-wide rate-limit
// tracker. The trackers are the pure classes in shared/; `trackerSignal`
// tells React something in them changed.
import { TaskTracker } from '@shared/tasks';
import { UsageTracker, RateLimitTracker } from '@shared/usage';
import { createSignal } from '@/state/createStore';

export const trackerSignal = createSignal();

const tasks = new Map<string, TaskTracker>();
const usage = new Map<string, UsageTracker>();
export const rateLimits = new RateLimitTracker();

export function getTaskTracker(id: string): TaskTracker {
  let t = tasks.get(id);
  if (!t) {
    t = new TaskTracker();
    t.onChange(() => trackerSignal.bump());
    tasks.set(id, t);
  }
  return t;
}

export function getUsageTracker(id: string): UsageTracker {
  let u = usage.get(id);
  if (!u) {
    u = new UsageTracker();
    usage.set(id, u);
  }
  return u;
}

export function peekTaskTracker(id: string | null): TaskTracker | null {
  return (id && tasks.get(id)) || null;
}
