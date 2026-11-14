// Wire shapes the client reads. Instance and SessionRow are views of the shared
// rows (shared/wireRows.ts): a required core plus a Partial of the rest, so partial
// fixtures type while a field renamed on the server fails every reader. Project
// and Worktree are declared here because their producer has no declared type;
// they keep an index signature for what the UI does not name.

import type { InstanceListRow, SessionRow as WireSessionRow } from '@shared/wireRows';

export type { WorktreeHookResult as PostWorktreeHook, InstanceWorktree } from '@shared/wireRows';

export type Instance = Pick<InstanceListRow, 'id' | 'project' | 'status' | 'sessionId' | 'mode'> & Partial<InstanceListRow> & {
  // Joined onto GET /instances rows from the playbook projection.
  playbook?: string | null;
  stage?: string | null;
  /**
   * Set only on `AppState.ended`: the session this pane shows has no instance in
   * any list. `instance` — it left while shown, and its scroll-back still pages
   * by instance id; `session` — reopened from disk, paging by session id.
   * `worktreeName` is where it ran, which may no longer exist.
   */
  ended?: { source: 'instance' | 'session'; worktreeName: string | null };
};

export type Worktree = {
  worktreeName: string;
  branch?: string;
  baseBranch?: string;
  baseSha?: string;
  mergeStatus?: { ahead: number; behind: number } | null;
  path?: string;
  locked?: boolean;
  sessions?: { count: number; archivedCount?: number; lastActivity?: number };
  [k: string]: unknown;
};

/** A project's convention selection: never chosen (`unset`), chosen to have none (`none`), or these slugs in marker order. */
export type ProjectConventionSelection =
  | { mode: 'unset' }
  | { mode: 'none' }
  | { mode: 'selected'; slugs: string[] };

export type Project = {
  name: string;
  path: string;
  workspace?: string | null;
  system: string;
  remoteId: string | null;
  sessionIds?: string[];
  systemUnreachable?: string | null;
  gitRefusal?: string | null;
  isGitRepo?: boolean;
  unbornHead?: boolean;
  worktrees: Worktree[];
  sessions?: { count: number; archivedCount: number; handCount: number; lastActivity: number };
  mergeStatus?: { ahead: number | null; behind: number | null; upstream: string | null };
  /** The selection its CONVENTIONS.md records, with `unresolved` naming its slugs the catalog lacks; `{error}` when unreadable, absent when the project can't be resolved. */
  conventions?: (ProjectConventionSelection & { unresolved: string[] }) | { error: string };
  branch?: string | null;
  dirty?: number;
  [k: string]: unknown;
};

export type SessionRow = Pick<WireSessionRow, 'sessionId'> & Partial<WireSessionRow>;
