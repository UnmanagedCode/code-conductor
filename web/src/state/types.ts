// Wire shapes the client reads: views of the shared rows (shared/wireRows.ts), a
// required core plus a Partial of the rest, so partial fixtures type while a field
// renamed on the server fails every reader.

import type { InstanceListRow, PlaybookBinding, ProjectRow, SessionRow as WireSessionRow, WorktreeRow } from '@shared/wireRows';

export type { WorktreeHookResult as PostWorktreeHook, InstanceWorktree, ProjectConventionSelection } from '@shared/wireRows';

export type Instance = Pick<InstanceListRow, 'id' | 'project' | 'status' | 'sessionId' | 'mode'> & Partial<InstanceListRow & PlaybookBinding> & {
  /**
   * Set only on `AppState.ended`: the session this pane shows has no instance in
   * any list. `instance` — it left while shown, and its scroll-back still pages
   * by instance id; `session` — reopened from disk, paging by session id.
   * `worktreeName` is where it ran, which may no longer exist.
   */
  ended?: { source: 'instance' | 'session'; worktreeName: string | null };
};

export type Worktree = Pick<WorktreeRow, 'worktreeName'> & Partial<WorktreeRow>;

export type Project = Pick<ProjectRow, 'name' | 'path' | 'system' | 'remoteId'> & Partial<Omit<ProjectRow, 'worktrees'>> & {
  worktrees: Worktree[];
};

export type SessionRow = Pick<WireSessionRow, 'sessionId'> & Partial<WireSessionRow>;
