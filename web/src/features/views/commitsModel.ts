// Pure pieces of the commit history view: API spelling, row diff URLs and the
// "already in <base>" divider placement.

export type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author?: string;
  relativeDate?: string;
  isoDate?: string;
  parents?: string[];
  ahead?: boolean;
};

export type CommitsPayload = {
  project?: string;
  branch?: string | null;
  truncated?: boolean;
  limit?: number;
  hasUncommitted?: boolean;
  aheadCount?: number;
  aheadOf?: string | null;
  locked?: boolean;
  commits?: Commit[];
};

/** The prefix every commits request hangs off: project-scoped, or a worktree's own checkout. */
export function commitsApiBase(project: string, worktree?: string | null) {
  const base = `/api/projects/${encodeURIComponent(project)}`;
  return worktree ? `${base}/worktrees/${encodeURIComponent(worktree)}` : base;
}

export const commitDiffUrl = (apiBase: string, sha: string) => `${apiBase}/commits/${encodeURIComponent(sha)}/diff`;
export const uncommittedDiffUrl = (apiBase: string) => `${apiBase}/commits/uncommitted/diff`;

/**
 * Index of the row the "already in <base>" divider sits above, or -1. Each
 * row's ahead state is the server's own flag (the ahead set is not always a
 * prefix of the window); the divider claims everything below it is merged, so
 * it is drawn only where the ahead rows are a contiguous prefix.
 */
export function dividerIndex(data: CommitsPayload): number {
  const commits = data.commits ?? [];
  const firstMerged = commits.findIndex((c) => !c.ahead);
  if (!data.aheadOf || firstMerged <= 0) return -1;
  return commits.slice(firstMerged).every((c) => !c.ahead) ? firstMerged : -1;
}

/** "12 commits (showing latest 100) · 2 ahead of main". */
export function commitsStats(data: CommitsPayload): string {
  const n = data.commits?.length ?? 0;
  if (!n) return '';
  const parts = [`${n} commit${n === 1 ? '' : 's'}`];
  if (data.truncated) parts.push(`(showing latest ${data.limit})`);
  if ((data.aheadCount ?? 0) > 0 && data.aheadOf) parts.push(`· ${data.aheadCount} ahead of ${data.aheadOf}`);
  return parts.join(' ');
}
