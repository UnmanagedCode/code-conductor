// The server side of the `projects` hint for the records cc writes itself: the
// project records, the workspace registry and the worktree records. Their write
// primitives call `markProjectsChanged()` once a write has landed; an operation
// that makes several writes runs inside `projectsOperation()`, which turns them
// into ONE signal when the outermost operation ends. A refusal or no-op that
// wrote nothing signals nothing; a refusal after a write landed signals once.
// src/wsHub.ts turns each signal into one `{t:'projects'}` frame to every client.
import { AsyncLocalStorage } from 'node:async_hooks';

type Scope = { changed: boolean };

const scope = new AsyncLocalStorage<Scope>();
const listeners: (() => void)[] = [];

function signal(): void {
  for (const fn of listeners) fn();
}

/** A write to a project record, the workspace registry or a worktree record has landed. */
export function markProjectsChanged(): void {
  const s = scope.getStore();
  if (s) s.changed = true;
  else signal();
}

/**
 * Runs one operation of several writes. The outermost operation signals once
 * when it ends, if any write landed, whether it then returns or throws: a write
 * that landed before a throw is still a change. A nested operation joins the
 * outer one. A write started inside an operation must be awaited within it:
 * a detached (fire-and-forget) write's mark lands after the operation ended,
 * and is lost.
 */
export async function projectsOperation<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  const s: Scope = { changed: false };
  try {
    return await scope.run(s, fn);
  } finally {
    if (s.changed) signal();
  }
}

/** Calls `fn` on every signal. */
export function onProjectsChanged(fn: () => void): void {
  listeners.push(fn);
}
