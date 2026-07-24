import { execFile, spawn } from 'node:child_process';

// Shared git-subprocess helpers used wherever the app pulls/fetches a git
// checkout it manages (the Plugin Library — src/plugins/library.js — and the
// conductor self-update — src/selfUpdate.js). Extracted verbatim from
// library.js so the two paths share one implementation instead of drifting.

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

// Shared streaming runner for git subcommands whose output the caller wants
// to surface live (clone, pull) — spawn + 'data' handlers (rather than a
// buffered execFile) so onChunk fires as output arrives, with a detached-
// process-group timeout/kill: git can spawn credential-helper/hook
// grandchildren that a plain kill of the direct child would orphan. Never
// rejects — resolves {code,stdout,stderr}, mirroring runGit's shape
// (src/worktrees.js) plus the split stdout/stderr callers need to build an
// error tail from stderr first.
export function runGitLive(args, cwd, { timeoutMs = GIT_LIVE_TIMEOUT_MS, onChunk } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('git', args, { cwd, detached: true });
    const onOut = (d) => { const s = d.toString(); stdout += s; onChunk?.(s); };
    const onErr = (d) => { const s = d.toString(); stderr += s; onChunk?.(s); };
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onErr);

    let timedOut = false;
    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || e.message });
    });
  });
}

// Best-effort, timeout-bounded `git fetch` so a subsequent cached-ref
// comparison (getProjectUpstreamStatus) reflects the real remote instead of
// whatever was last fetched manually. Never throws; a timeout, missing
// remote, or auth failure just means the subsequent status check falls back
// to stale-or-null status. Uses a raw execFile timeout (not runGit, which has
// none) since a hung fetch must not block the caller. NO_PROMPT_GIT_ENV makes
// credential failures fail fast rather than hang until the timeout.
export function fetchOriginBounded(cwd) {
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
