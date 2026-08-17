import { execFile } from 'node:child_process';
import { runGroupedCommand } from './groupedCommand.ts';

// Shared git-subprocess helpers used wherever the app pulls/fetches a git
// checkout it manages (the Plugin Library — src/plugins/library.ts — and the
// conductor self-update — src/selfUpdate.ts). Extracted verbatim from
// library.ts so the two paths share one implementation instead of drifting.

// Default timeout for a streamed git subcommand (clone/pull): long enough for
// a big clone over a slow link.
export const GIT_LIVE_TIMEOUT_MS = 120_000;
// Bounded pre-check fetch used for update detection — must never block a list.
export const GIT_FETCH_TIMEOUT_MS = 8_000;

// Env for any git subprocess that talks to a remote outside an explicit user
// action (the background fetch update-detection runs to freshen ahead/behind
// data) — fail fast on missing credentials instead of hanging until the
// timeout, which would otherwise be the common case for private repos.
export const NO_PROMPT_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

export interface GitLiveResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Shared streaming runner for git subcommands whose output the caller wants
// to surface live (clone, pull) — spawn + 'data' handlers (rather than a
// buffered execFile) so onChunk fires as output arrives, with a detached-
// process-group timeout/kill: git can spawn credential-helper/hook
// grandchildren that a plain kill of the direct child would orphan. Never
// rejects — resolves {code,stdout,stderr}, mirroring runGit's shape
// (src/worktrees.ts) plus the split stdout/stderr callers need to build an
// error tail from stderr first.
export function runGitLive(
  args: string[],
  cwd: string,
  { timeoutMs = GIT_LIVE_TIMEOUT_MS, onChunk }: { timeoutMs?: number; onChunk?: (s: string) => void } = {},
): Promise<GitLiveResult> {
  // No `cap`: git porcelain output is small and callers parse it whole.
  return runGroupedCommand({ argv: ['git', ...args] }, { cwd, timeoutMs, onChunk })
    .then(({ code, stdout, stderr }) => ({ code, stdout, stderr }));
}

// Best-effort, timeout-bounded `git fetch` so a subsequent cached-ref
// comparison (getProjectUpstreamStatus) reflects the real remote instead of
// whatever was last fetched manually. Never throws; a timeout, missing
// remote, or auth failure just means the subsequent status check falls back
// to stale-or-null status. Uses a raw execFile timeout (not runGit, which has
// none) since a hung fetch must not block the caller. NO_PROMPT_GIT_ENV makes
// credential failures fail fast rather than hang until the timeout.
export function fetchOriginBounded(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'fetch', '--quiet'], {
      cwd,
      env: NO_PROMPT_GIT_ENV,
      timeout: GIT_FETCH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }, () => resolve()); // outcome ignored — caller reads whatever refs are now cached
  });
}
