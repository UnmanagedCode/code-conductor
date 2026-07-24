import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runGit, getProjectUpstreamStatus } from './worktrees.js';
import { runGitLive, fetchOriginBounded } from './gitLive.js';

// Conductor self-update — the app's own version of the Plugin Library update
// path (src/plugins/library.js). The conductor is distributed as a git clone
// (README quick start), so "update" == `git pull --ff-only` in the repo root,
// then `npm install` if the pull moved a dependency manifest, then a restart
// so the running node process loads the new files. This module owns the
// git/npm half; the restart is the caller's step (the client hands off to the
// existing restart+resume engine after a successful apply — see
// public/restartFlow.js), keeping this a pure git/npm action like
// pluginLibrary.update().

// Repo root = one level up from src/ (this module's dir). Resolved from
// import.meta.url, not process.cwd(), so it points at the checkout the running
// code was loaded from regardless of where `npm start` was invoked. The
// SELF_UPDATE_REPO_ROOT env override (read per call) lets the HTTP-route tests
// — which call these with no args — target a throwaway clone. Callers may also
// pass repoRoot explicitly (the service-level tests do).
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function defaultRepoRoot() {
  return process.env.SELF_UPDATE_REPO_ROOT || MODULE_REPO_ROOT;
}

const NPM_OUTPUT_CAP = 16 * 1024;   // mirrors library.js's HOOK_OUTPUT_CAP
const NPM_TIMEOUT_MS = 300_000;     // installs pull deps — same budget as postPull hooks
const TAIL_CAP = 4000;              // error/result tail length, matching library.js

// A pull that touches one of these means dependencies may have shifted, so an
// `npm install` is run before the restart. Anything else is code-only.
const DEP_FILES = new Set(['package-lock.json', 'package.json']);

async function readVersion(repoRoot) {
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch { return null; }
}

// Streamed `npm install` (via `bash -lc` so a custom command string works),
// detached with a process-group timeout/kill — npm spawns grandchildren a
// plain kill would orphan. Never rejects; resolves {code, output}.
function runNpmInstall(cmd, cwd, { onChunk } = {}) {
  return new Promise((resolve) => {
    let output = '';
    const proc = spawn('bash', ['-lc', cmd], { cwd, env: process.env, detached: true });
    const onData = (d) => {
      const s = d.toString();
      output += s;
      if (output.length > NPM_OUTPUT_CAP) output = output.slice(-NPM_OUTPUT_CAP);
      onChunk?.(s);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    let timedOut = false;
    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, NPM_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: output.trimEnd() });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: e.message });
    });
  });
}

// { version, upstream, behind, canCheck, updateAvailable }. Mirrors
// pluginLibrary.list()'s per-entry detection: a bounded best-effort fetch so
// the behind-count reflects the real remote, then getProjectUpstreamStatus.
// canCheck:false (behind null) when HEAD is detached or the branch has no
// configured upstream (e.g. a dev worktree) — the UI shows "can't check".
export async function getSelfUpdateStatus({ repoRoot = defaultRepoRoot() } = {}) {
  const version = await readVersion(repoRoot);
  await fetchOriginBounded(repoRoot);
  const status = await getProjectUpstreamStatus(repoRoot);
  const canCheck = typeof status.behind === 'number';
  const behind = canCheck ? status.behind : null;
  return {
    version,
    upstream: status.upstream,
    behind,
    canCheck,
    updateAvailable: canCheck && behind > 0,
  };
}

// Apply an update: `git pull --ff-only` in the repo root, then `npm install`
// iff the pull moved a dependency manifest. `--ff-only` never mutates on
// failure (diverged/dirty/no-remote all refuse cleanly) — surface the tail.
// onValidated flips the route into NDJSON streaming (nothing done before it);
// onChunk(phase, text) streams live pull/npm output. Returns restartRequired
// so the caller knows to bounce the process; the restart itself is NOT done
// here (the client owns it via the existing restart+resume engine).
export async function applySelfUpdate({
  repoRoot = defaultRepoRoot(),
  npmCmd = process.env.SELF_UPDATE_NPM_CMD || 'npm install',
  onChunk,
  onValidated,
} = {}) {
  const before = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  const beforeSha = before.code === 0 ? before.stdout.trim() : '';

  onValidated?.();

  const pull = await runGitLive(['pull', '--ff-only'], repoRoot, { onChunk: (t) => onChunk?.('pull', t) });
  if (pull.code !== 0) {
    const tail = (pull.stderr || pull.stdout || '').slice(-TAIL_CAP);
    throw Object.assign(new Error('git pull --ff-only failed'), { statusCode: 502, tail });
  }

  // Which tracked files did the pull move? If any is a dependency manifest,
  // run npm install before the restart so the new deps are on disk.
  let depsChanged = false;
  if (beforeSha) {
    const diff = await runGit(repoRoot, ['diff', '--name-only', `${beforeSha}..HEAD`]);
    if (diff.code === 0) {
      depsChanged = diff.stdout.split('\n').map(s => s.trim()).some(f => DEP_FILES.has(f));
    }
  }

  let npm = null;
  if (depsChanged) {
    const r = await runNpmInstall(npmCmd, repoRoot, { onChunk: (t) => onChunk?.('npm', t) });
    npm = { ran: true, ok: r.code === 0, code: r.code, tail: (r.output ?? '').slice(-TAIL_CAP) };
  }

  return { ok: true, version: await readVersion(repoRoot), depsChanged, npm, restartRequired: true };
}
