// Which worktrees have had a successful merge into their base, held in server
// memory only: a restart between merge and delete drops the record, which costs
// that one landing renewal nudge and nothing else. Keyed by project + name and
// valued with the worktree's `createdAt`, so an entry names that specific
// worktree: a same-name successor never matches it, which also covers a
// worktree removed outside cc (its store record, and so its entry, survives).
// Writer: mergeWorktreeIntoParent's ok:true path, so REST and MCP merges both
// record. Cleared per worktree by dropWorktreeStoreEntry and per project by
// removeProjectStoreDir — the only two places cc deletes worktree records.
const landed = new Map<string, string>();
const key = (projectName: string, worktreeName: string) => `${projectName}\0${worktreeName}`;

export function recordWorktreeLanding(projectName: string, worktreeName: string, createdAt: string): void {
  landed.set(key(projectName, worktreeName), createdAt);
}

export function worktreeLandingRecorded(projectName: string, worktreeName: string, createdAt: string): boolean {
  return landed.get(key(projectName, worktreeName)) === createdAt;
}

export function forgetWorktreeLanding(projectName: string, worktreeName: string): void {
  landed.delete(key(projectName, worktreeName));
}

export function forgetWorktreeLandings(projectName: string): void {
  const prefix = `${projectName}\0`;
  for (const k of [...landed.keys()]) if (k.startsWith(prefix)) landed.delete(k);
}

// Test reset: forgets every recorded landing.
export function clearWorktreeLandings(): void {
  landed.clear();
}
