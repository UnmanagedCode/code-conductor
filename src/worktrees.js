// Git worktree operations for isolated agent runs. Each worktree lives as
// a sibling directory at `<projectsRoot>/<project>_worktree_<short-id>/`.
// All orchestrator-owned metadata for the worktree (worktree.json,
// attachments/, debug/) lives in the central store under
// `<projectsRoot>/.code-conductor/projects/<project>/worktrees/<worktreeDir>/`
// — the worktree dir itself stays clean.

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectsRoot, getProject, projectStoreDir, worktreeStoreDir, listProjects } from './projects.js';

// Manual execFile wrapper. `promisify(execFile)` would be tempting but
// this Node build (Termux's android port) doesn't ship the
// util.promisify.custom symbol on execFile, so the promisified version
// resolves to just stdout (a string) instead of {stdout, stderr}.
// Wrap it ourselves so the shape is reliable across runtimes.
function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const WORKTREE_META_FILENAME = 'worktree.json';

// Where this project / worktree's central-store entry lives. Pass
// `worktreeName: null` for the project root.
function baseStoreDir(project, worktreeName) {
  return worktreeName
    ? worktreeStoreDir(project, worktreeName)
    : projectStoreDir(project);
}

export function attachmentsDir(project, worktreeName) {
  return path.join(baseStoreDir(project, worktreeName), 'attachments');
}

export function debugBaseDir(project, worktreeName) {
  return path.join(baseStoreDir(project, worktreeName), 'debug');
}

function metaPath(project, worktreeName) {
  return path.join(worktreeStoreDir(project, worktreeName), WORKTREE_META_FILENAME);
}

// Shorter-than-uuid identifier — 6 hex chars is plenty for collision
// avoidance across a handful of worktrees per project.
function shortId() {
  return randomBytes(3).toString('hex');
}

function worktreeBranchName(id) {
  return `code-conductor/${id}`;
}

function worktreeDirName(project, id) {
  return `${project}_worktree_${id}`;
}

export async function runGit(cwd, args) {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    // execFile rejects with an error that carries stdout/stderr/code.
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export async function isGitRepo(projectPath) {
  const r = await runGit(projectPath, ['rev-parse', '--git-dir']);
  return r.code === 0;
}

// `git status --porcelain` for a worktree path. Returns
// { ok: boolean, lines: string[] }. Callers can decide whether a
// non-empty `lines` means "refuse" or "fall back to the agent flow".
export async function worktreeDirtyLines(worktreePath) {
  const dirty = await runGit(worktreePath, ['status', '--porcelain']);
  if (dirty.code !== 0) return { ok: false, lines: [] };
  const lines = (dirty.stdout || '').split('\n').filter(l => l.trim().length > 0);
  return { ok: true, lines };
}

// Look up the parent repo's current branch + commit. Detached HEAD is
// allowed (we record null for `branch`) — the rebase-back path will
// require a named branch, but creation itself shouldn't be blocked.
export async function getHeadBranchAndSha(projectPath) {
  const head = await runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() || null : null;
  const sha = await runGit(projectPath, ['rev-parse', 'HEAD']);
  if (sha.code !== 0) {
    const err = new Error(`unable to resolve HEAD in ${projectPath}: ${sha.stderr.trim()}`);
    err.statusCode = 400;
    throw err;
  }
  return { branch, sha: sha.stdout.trim() };
}

async function writeMeta(project, worktreeName, meta) {
  await fs.mkdir(worktreeStoreDir(project, worktreeName), { recursive: true });
  await fs.writeFile(metaPath(project, worktreeName), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

async function readMeta(project, worktreeName) {
  let text;
  try { text = await fs.readFile(metaPath(project, worktreeName), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch { return null; }
}
// Store-only read (no `git worktree list` verification) — for scans that
// must stay cheap across many projects (plugin manifest discovery). A stale
// entry's worktreePath simply won't resolve for the caller.
export { readMeta as readWorktreeMeta };

// Cap on hook output kept in memory — tail of this many bytes is retained.
// Chatty scripts (npm ci, etc.) can emit MBs; keep only the tail so the
// result field stays network-friendly. ~16 KB is generous for diagnostics.
const HOOK_OUTPUT_CAP = 16 * 1024;

// Run `.code-conductor/post-worktree-create.sh`, read from the parent
// checkout (it need not be committed), with cwd in the new worktree.
// Always resolves — never rejects — so a broken hook cannot abort a
// successful worktree create. Result is attached to the createWorktree()
// return value as `postWorktreeCreate`.
async function runPostWorktreeHook(meta) {
  if (process.env.ORCH_DISABLE_POST_WORKTREE_HOOK === '1') {
    return { ran: false, skipped: 'disabled' };
  }

  const scriptPath = path.join(
    meta.parentPath, '.code-conductor', 'post-worktree-create.sh',
  );
  try {
    await fs.access(scriptPath);
  } catch {
    return { ran: false };
  }

  // Ensure the executable bit is set — the script may have been committed
  // without it (e.g. on Windows / FAT filesystems). Non-fatal if chmod fails.
  try {
    const stat = await fs.stat(scriptPath);
    if (!(stat.mode & 0o111)) {
      await fs.chmod(scriptPath, stat.mode | 0o111);
    }
  } catch { /* best-effort */ }

  const timeoutMs = Number(process.env.ORCH_POST_WORKTREE_TIMEOUT_MS) || 120_000;
  const env = {
    ...process.env,
    CC_WORKTREE_PATH: meta.worktreePath,
    CC_PROJECT_NAME: meta.parentProject,
    CC_BRANCH: meta.branch,
    CC_BASE_BRANCH: meta.baseBranch,
    CC_PARENT_PATH: meta.parentPath,
  };

  return new Promise((resolve) => {
    const start = Date.now();
    let timedOut = false;
    const chunks = [];

    // detached=true puts bash + all its children in their own process group so
    // we can kill the whole group (including long-running child processes like
    // `npm ci`) with a single process.kill(-pid, signal) on timeout.
    const proc = spawn('bash', [scriptPath], {
      cwd: meta.worktreePath,
      env,
      detached: true,
    });

    const onData = (chunk) => chunks.push(chunk);
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      // SIGKILL backstop: sends SIGKILL if the process group doesn't die
      // from SIGTERM within 100 ms (e.g. `sleep` ignoring SIGTERM on some
      // platforms). Unref'd so it can't keep the process alive.
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const raw = Buffer.concat(chunks).toString('utf8');
      const truncated = raw.length > HOOK_OUTPUT_CAP;
      let output;
      if (truncated) {
        const tail = raw.slice(raw.length - HOOK_OUTPUT_CAP);
        // Start at the next newline so output begins on a clean line.
        const nl = tail.indexOf('\n');
        output = '… [truncated]\n' + (nl >= 0 ? tail.slice(nl + 1) : tail);
      } else {
        output = raw;
      }
      const result = {
        ran: true,
        exitCode: timedOut ? null : (code ?? null),
        durationMs,
        output: output.trimEnd(),
      };
      if (truncated) result.truncated = true;
      if (timedOut) result.timedOut = true;
      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        exitCode: null,
        durationMs: Date.now() - start,
        output: err.message,
        error: true,
      });
    });
  });
}

// Create a fresh worktree off the parent repo's current HEAD. Returns
// the metadata that was written to disk.
export async function createWorktree(projectName) {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.path))) {
    const err = new Error(`project '${projectName}' is not a git repository`);
    err.statusCode = 400;
    throw err;
  }
  const head = await getHeadBranchAndSha(proj.path);
  if (!head.branch) {
    // git worktree add can work off a detached HEAD, but tracking down
    // "what was the base" later is messy. Refuse cleanly instead.
    const err = new Error(`project '${projectName}' is on a detached HEAD; check out a branch before creating a worktree`);
    err.statusCode = 400;
    throw err;
  }
  const id = shortId();
  const dirName = worktreeDirName(projectName, id);
  const worktreePath = path.join(projectsRoot(), dirName);
  const branch = worktreeBranchName(id);

  // `git worktree add <path> -b <branch> <start-point>` creates the
  // branch off the captured SHA so subsequent activity on the parent
  // branch can't drift our base.
  const add = await runGit(proj.path, ['worktree', 'add', worktreePath, '-b', branch, head.sha]);
  if (add.code !== 0) {
    const err = new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    err.statusCode = 500;
    throw err;
  }

  const meta = {
    parentProject: projectName,
    parentPath: proj.path,
    worktreeName: dirName,
    worktreePath,
    branch,
    baseBranch: head.branch,
    baseSha: head.sha,
    createdAt: new Date().toISOString(),
  };
  await writeMeta(projectName, dirName, meta);
  // Run the per-project post-worktree-create hook. Runs AFTER the worktree
  // dir + branch + metadata are written, BEFORE the instance subprocess is
  // created — so a slow hook never interferes with the 5 s control-request
  // timeout. Non-fatal: a failure warns but does not roll back the worktree.
  const postWorktreeCreate = await runPostWorktreeHook(meta);
  return { ...meta, postWorktreeCreate };
}

// List every worktree on disk that we own for a given project. Reads
// the parent repo's `git worktree list --porcelain` and filters down to
// entries whose dir has a matching record in the central store.
export async function listWorktrees(projectName) {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.path))) return [];
  const r = await runGit(proj.path, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const candidates = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      candidates.push(line.slice('worktree '.length));
    }
  }
  const out = [];
  for (const wtPath of candidates) {
    // Skip the parent repo itself (no store entry).
    const dirName = path.basename(wtPath);
    const meta = await readMeta(projectName, dirName).catch(() => null);
    if (meta && meta.parentProject === projectName) out.push(meta);
  }
  out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return out;
}

export async function getWorktree(projectName, worktreeName) {
  const all = await listWorktrees(projectName);
  return all.find(w => w.worktreeName === worktreeName) ?? null;
}

// Remove a worktree: deregister it via git, drop the directory, delete
// the branch, drop the central-store entry. We refuse if the working
// tree has uncommitted changes so the user can't silently throw away
// in-progress agent work.
export async function removeWorktree(projectName, worktreeName, { force = false } = {}) {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    const err = new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    err.statusCode = 404;
    throw err;
  }
  const parentPath = meta.parentPath;

  if (!force) {
    const dirty = await worktreeDirtyLines(meta.worktreePath);
    if (dirty.ok && dirty.lines.length > 0) {
      const err = new Error(
        `worktree '${worktreeName}' has uncommitted changes — commit / discard them, or pass force=true`,
      );
      err.statusCode = 409;
      throw err;
    }
  }

  // Pass --force to `git worktree remove`. We already validated the
  // tree is clean above (or the caller opted into force); the flag
  // also keeps git from refusing on minor leftover state.
  const rm = await runGit(parentPath, ['worktree', 'remove', '--force', meta.worktreePath]);
  if (rm.code !== 0) {
    const err = new Error(`git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`);
    err.statusCode = 500;
    throw err;
  }
  // Branch deletion is best-effort — if the rebase-back already
  // fast-forwarded the base onto the worktree branch then `-d` will
  // succeed; otherwise the branch may be ahead and we use `-D`.
  const delArgs = ['branch', force ? '-D' : '-d', meta.branch];
  await runGit(parentPath, delArgs);
  // Drop the central-store entry (metadata + attachments + debug).
  try { await fs.rm(worktreeStoreDir(projectName, worktreeName), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  return meta;
}

// Compare the worktree branch to its captured base branch from inside
// the parent repo (worktrees share the same gitdir, so the branch is
// visible from there). Returns:
//   ahead  = commits on worktreeBranch not yet on baseBranch (= work
//            that hasn't been fast-forwarded into the parent yet)
//   behind = commits on baseBranch not yet on worktreeBranch (= parent
//            moved on since the worktree was branched)
// Returns { ahead: null, behind: null } when the comparison fails (base
// branch renamed/deleted, ref missing, etc.) — callers treat null as
// "unknown" and render no indicator.
export async function getWorktreeMergeStatus(meta) {
  if (!meta?.parentPath || !meta?.baseBranch || !meta?.branch) {
    return { ahead: null, behind: null };
  }
  const r = await runGit(meta.parentPath, [
    'rev-list', '--left-right', '--count',
    `${meta.baseBranch}...${meta.branch}`,
  ]);
  if (r.code !== 0) return { ahead: null, behind: null };
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return { ahead: null, behind: null };
  const behind = Number.parseInt(parts[0], 10);
  const ahead = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { ahead: null, behind: null };
  }
  return { ahead, behind };
}

// Compare the project's currently-checked-out branch against its
// configured upstream (whatever `git branch --set-upstream-to` picked —
// usually `origin/<branch>`, matching what `git status` reports).
// Reads cached remote refs only — never runs `git fetch` — so numbers
// reflect the last manual fetch/pull. Returns
//   { ahead, behind, upstream } when both sides are known
//   { ahead: null, behind: null, upstream: null } when the branch has
//     no upstream configured, HEAD is detached, the project isn't a
//     git repo, or the rev-list comparison fails. Callers treat the
//     null shape as "no indicator to render".
export async function getProjectUpstreamStatus(projectPath) {
  const headRef = await runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (headRef.code !== 0) return { ahead: null, behind: null, upstream: null };
  const branch = headRef.stdout.trim();
  if (!branch) return { ahead: null, behind: null, upstream: null };
  const upRef = await runGit(projectPath, [
    'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
  ]);
  if (upRef.code !== 0) return { ahead: null, behind: null, upstream: null };
  const upstream = upRef.stdout.trim();
  if (!upstream) return { ahead: null, behind: null, upstream: null };
  const r = await runGit(projectPath, [
    'rev-list', '--left-right', '--count',
    `${upstream}...${branch}`,
  ]);
  if (r.code !== 0) return { ahead: null, behind: null, upstream: null };
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return { ahead: null, behind: null, upstream: null };
  const behind = Number.parseInt(parts[0], 10);
  const ahead = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { ahead: null, behind: null, upstream: null };
  }
  return { ahead, behind, upstream };
}

// Run `git merge --no-ff --no-edit <branch>` on the parent repo. Always
// produces a merge commit (even when a fast-forward would be possible)
// so each worktree's contribution is a visible branch in the parent's
// history — easy to spot in `git log --graph` and revertable as a single
// commit via `git revert -m 1 <mergeSha>`. The commit message uses git's
// default ("Merge branch 'code-conductor/<id>'"). Once the merge commit
// lands, fast-forwards the worktree's own branch up to it too (best-
// effort — the worktree branch is always an ancestor of the new parent
// HEAD, so this keeps a kept worktree at ahead:0/behind:0 instead of
// looking permanently one commit behind). Returns {ok:true, newSha,
// worktreeFastForwarded} on success or {ok:false, reason} when the merge
// can't proceed (parent on wrong branch, dirty parent, conflicts, etc.)
// — caller surfaces the reason to the UI rather than throwing.
export async function mergeWorktreeIntoParent(projectName, worktreeName) {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    const err = new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    err.statusCode = 404;
    throw err;
  }
  // 0. Refuse if the worktree branch is behind its base — the merge would
  //    still work, but conflicts would surface on the parent side instead of
  //    being resolved inside the worktree (where the agent can help). Checked
  //    first so it takes precedence over the branch-mismatch / dirty gates,
  //    matching the order the REST + MCP callers used before this moved in.
  //    Returns data fields only; each caller maps the code to its own
  //    audience-specific reason string (REST "click Sync first" / MCP "call
  //    sync_worktree first").
  const status = await getWorktreeMergeStatus(meta);
  if (status.behind != null && status.behind > 0) {
    return { ok: false, code: 'WORKTREE_BEHIND', behind: status.behind, baseBranch: meta.baseBranch };
  }
  // 1. Parent must currently be on the captured base branch — otherwise
  //    the merge would land work somewhere unexpected.
  const head = await getHeadBranchAndSha(meta.parentPath);
  if (head.branch !== meta.baseBranch) {
    return {
      ok: false,
      code: 'BASE_BRANCH_MISMATCH',
      reason: `parent repo is on '${head.branch}', but this worktree was branched from '${meta.baseBranch}'. ` +
        `Switch the parent back to '${meta.baseBranch}' before merging.`,
    };
  }
  // 2. Parent's working tree must be clean — `git merge` refuses
  //    otherwise, but the error message is friendlier from us.
  const dirty = await runGit(meta.parentPath, ['status', '--porcelain']);
  if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'PARENT_DIRTY',
      reason: `parent repo has uncommitted changes — commit or stash them before merging`,
    };
  }
  // 3. Attempt the merge. --no-ff forces a merge commit even when FF would
  //    be possible; --no-edit makes git use its default message non-
  //    interactively (we'd hang otherwise waiting on an editor).
  const merge = await runGit(meta.parentPath, ['merge', '--no-ff', '--no-edit', meta.branch]);
  if (merge.code !== 0) {
    return {
      ok: false,
      code: 'MERGE_FAILED',
      reason: (merge.stderr.trim() || merge.stdout.trim() ||
        `git merge --no-ff ${meta.branch} failed`),
    };
  }
  const newHead = await runGit(meta.parentPath, ['rev-parse', 'HEAD']);
  // 4. Fast-forward the worktree's own branch up to the merge commit. The
  //    worktree branch is one of that commit's two parents, so it's always
  //    an ancestor of the new HEAD — --ff-only can't fail on divergence.
  //    Must run from inside the worktree dir: the branch is checked out
  //    there, not in the parent repo, so `git branch -f` from the parent
  //    would refuse. Best-effort — the merge already succeeded and the
  //    parent is correct regardless of whether this step lands, so a
  //    failure here (e.g. a worktree tree that went dirty mid-merge) must
  //    not turn the overall result into a failure.
  const ff = await runGit(meta.worktreePath, ['merge', '--ff-only', meta.baseBranch]);
  return {
    ok: true,
    output: merge.stdout.trim() || merge.stderr.trim(),
    newSha: newHead.stdout.trim(),
    worktreeFastForwarded: ff.code === 0,
  };
}

// Bring a worktree's branch up to date with the parent's baseBranch.
// Picks the cheapest path:
//   - behind == 0                                 → already in sync (no-op).
//   - behind > 0, ahead == 0, worktree tree clean → server-side `git
//     merge --ff-only <baseBranch>` inside the worktree.
//   - dirty working tree (any ahead count)        → caller must send
//     buildRebasePrompt(meta) to the worktree's agent (the agent
//     commits/discards before rebasing).
//   - ahead > 0, clean tree                       → attempt server-side
//     `git rebase <baseBranch>`; on success return 'rebased'; on
//     conflict abort cleanly and fall back to the agent rebase prompt.
// Returns one of:
//   { ok:true,  action:"already-in-sync",  ahead, behind }
//   { ok:true,  action:"fast-forwarded",   ahead:0, behind:0, newSha }
//   { ok:true,  action:"rebased",          ahead, behind:0, newSha }
//   { ok:true,  action:"rebase-required",  ahead, behind }
//   { ok:false, reason: "..." }
export async function syncWorktree(projectName, worktreeName) {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    const err = new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    err.statusCode = 404;
    throw err;
  }
  const { ahead, behind } = await getWorktreeMergeStatus(meta);
  if (ahead == null || behind == null) {
    return {
      ok: false,
      reason: `couldn't compare worktree branch '${meta.branch}' to '${meta.baseBranch}' (base branch may have been deleted or renamed)`,
    };
  }
  if (behind === 0) {
    return { ok: true, action: 'already-in-sync', ahead, behind };
  }
  // Dirty working tree → agent must commit/discard before any rebase can
  // proceed (git rebase refuses a dirty tree). Send the rebase prompt.
  const dirty = await worktreeDirtyLines(meta.worktreePath);
  if (!dirty.ok) {
    return { ok: false, reason: `git status failed inside worktree '${meta.worktreePath}'` };
  }
  if (dirty.lines.length > 0) {
    return { ok: true, action: 'rebase-required', ahead, behind };
  }
  // Pure-behind + clean tree → fast-forward; no rebase needed.
  if (ahead === 0) {
    const merge = await runGit(meta.worktreePath, ['merge', '--ff-only', meta.baseBranch]);
    if (merge.code !== 0) {
      return {
        ok: false,
        reason: (merge.stderr.trim() || merge.stdout.trim() ||
          `git merge --ff-only ${meta.baseBranch} failed inside worktree`),
      };
    }
    const newHead = await runGit(meta.worktreePath, ['rev-parse', 'HEAD']);
    return {
      ok: true,
      action: 'fast-forwarded',
      ahead: 0,
      behind: 0,
      newSha: newHead.stdout.trim(),
    };
  }
  // Diverged + clean tree → attempt automatic rebase. On conflict, abort
  // cleanly so the worktree is never left mid-rebase, then fall back to
  // the agent rebase prompt.
  const rebase = await runGit(meta.worktreePath, ['rebase', meta.baseBranch]);
  if (rebase.code === 0) {
    const newHead = await runGit(meta.worktreePath, ['rev-parse', 'HEAD']);
    return {
      ok: true,
      action: 'rebased',
      ahead,
      behind: 0,
      newSha: newHead.stdout.trim(),
    };
  }
  // Abort unconditionally — safe no-op if rebase never started.
  await runGit(meta.worktreePath, ['rebase', '--abort']);
  return { ok: true, action: 'rebase-required', ahead, behind };
}

// Build the prompt text the orchestrator sends to the agent when the
// user clicks "Ask agent to rebase". Kept in this module so the on-disk
// metadata and the prompt phrasing stay consistent.
export function buildRebasePrompt(meta) {
  return [
    `You are running in an isolated git worktree.`,
    `Worktree branch: ${meta.branch}`,
    `Originally branched from: ${meta.baseBranch} at ${meta.baseSha.slice(0, 12)}`,
    ``,
    `Please:`,
    `1. Commit any meaningful uncommitted changes in the worktree (ignore noise).`,
    `2. Run \`git rebase ${meta.baseBranch}\` inside this worktree so the work sits on top of the parent's current ${meta.baseBranch}.`,
    `3. If you hit conflicts you can't resolve with high confidence, STOP and use AskUserQuestion to consult the user before continuing.`,
    `4. When the rebase is clean, run \`git status\` to confirm, then reply with the line "REBASE_DONE" on its own so I can fast-forward the parent.`,
  ].join('\n');
}

// Best-effort sweep: remove every orchestrator-owned worktree under a
// project. Used by the project-delete cascade — failures are swallowed
// because the caller is about to `rm -rf` the parent anyway.
export async function removeAllWorktreesForProject(projectName) {
  let known = [];
  try { known = await listWorktrees(projectName); } catch { /* repo may be gone */ }
  for (const wt of known) {
    try { await removeWorktree(projectName, wt.worktreeName, { force: true }); } catch { /* ignore */ }
  }
}

// Maximum bytes of raw git diff output to keep. Shared by both diff surfaces
// (REST structured diff here + the MCP project_diff handler) so they
// behave consistently.
export const DIFF_BYTE_CAP = 200 * 1024;

// Security-relevant allow-list for a user-supplied diff base ref. The single
// definition of this regex — both the REST and MCP diff surfaces validate
// through assertValidBaseRef so the option-injection guard can't drift apart.
// Rejects leading '-' (would be parsed as a git flag) and anything outside the
// conservative ref-name character set.
const BASE_REF_RE = /^[A-Za-z0-9._/-]+$/;

// Throw a 400 if `ref` isn't a safe base ref. Callers decide WHEN to validate
// (each surface has its own "a baseRef was supplied" trigger) — this owns only
// the check + the canonical error.
export function assertValidBaseRef(ref) {
  if (ref.startsWith('-') || !BASE_REF_RE.test(ref)) {
    throw Object.assign(new Error('invalid baseRef'), { statusCode: 400 });
  }
}

// Parse a raw unified diff string (from `git diff --unified=N base...HEAD`)
// into a per-file array of structured objects. Pure string-walking, no deps.
function parseUnifiedDiff(raw) {
  const files = [];
  if (!raw || !raw.trim()) return files;

  // Each file section starts with "diff --git ...". Split there.
  const rawSections = raw.split('\ndiff --git ');
  for (let si = 0; si < rawSections.length; si++) {
    const section = si === 0 ? rawSections[si] : 'diff --git ' + rawSections[si];
    if (!section.startsWith('diff --git ')) continue;
    const lines = section.split('\n');

    const headerMatch = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!headerMatch) continue;

    let status = 'modified';
    let filePath = headerMatch[2]; // b-side path (current name)
    let oldPath = null;
    const hunks = [];
    let currentHunk = null;
    let adds = 0;
    let dels = 0;
    let inHunks = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!inHunks) {
        if (line.startsWith('new file mode')) {
          status = 'added';
        } else if (line.startsWith('deleted file mode')) {
          status = 'deleted';
        } else if (line.startsWith('rename from ')) {
          oldPath = line.slice('rename from '.length);
        } else if (line.startsWith('rename to ')) {
          filePath = line.slice('rename to '.length);
          status = 'renamed';
        } else if (line.startsWith('@@ ')) {
          inHunks = true;
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        }
      } else {
        if (line.startsWith('@@ ')) {
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        } else if (line.startsWith('+') && currentHunk) {
          currentHunk.lines.push({ type: 'add', content: line.slice(1) });
          adds++;
        } else if (line.startsWith('-') && currentHunk) {
          currentHunk.lines.push({ type: 'del', content: line.slice(1) });
          dels++;
        } else if (line.startsWith(' ') && currentHunk) {
          currentHunk.lines.push({ type: 'ctx', content: line.slice(1) });
        }
        // "\ No newline at end of file" and other metadata lines are skipped.
      }
    }

    files.push({ path: filePath, oldPath, status, adds, dels, hunks });
  }
  return files;
}

// Return structured diff data for a worktree relative to its base branch.
// Validates ownership via getWorktree (throws 404 if not found).
// Returns { project, worktreeName, baseRef, files, totalAdds, totalDels, truncated }.
export async function getWorktreeDiff(projectName, worktreeName, { baseRef, contextLines = 3 } = {}) {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    const err = new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    err.statusCode = 404;
    throw err;
  }
  const ctx = Math.max(0, Math.min(50, Number.isFinite(Number(contextLines)) ? Math.floor(Number(contextLines)) : 3));
  const ref = baseRef || meta.baseBranch;
  if (baseRef) assertValidBaseRef(ref);
  const r = await runGit(meta.worktreePath, ['diff', `--unified=${ctx}`, `${ref}...HEAD`]);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim() || `git diff ${ref}...HEAD failed`;
    const err = new Error(msg);
    err.statusCode = 500;
    throw err;
  }
  const rawOutput = r.stdout;
  const truncated = rawOutput.length > DIFF_BYTE_CAP;
  const raw = truncated ? rawOutput.slice(0, DIFF_BYTE_CAP) : rawOutput;
  const files = parseUnifiedDiff(raw);
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  return { project: projectName, worktreeName, baseRef: ref, files, totalAdds, totalDels, truncated };
}

// Default / maximum number of commits returned by getProjectCommits.
const COMMITS_DEFAULT_LIMIT = 100;

// Scan the metadata store for a worktree whose worktreePath matches
// the given absolute path. Returns the metadata object or null.
// Metadata lives at: projectStoreDir(project)/worktrees/<worktreeName>/worktree.json
// so we list subdirectories under the per-project 'worktrees/' dir.
async function findWorktreeMetaForPath(targetPath) {
  let projects;
  try { projects = await listProjects(); } catch { return null; }
  for (const proj of projects) {
    const wtListDir = path.join(projectStoreDir(proj.name), 'worktrees');
    let entries;
    try { entries = await fs.readdir(wtListDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta(proj.name, entry.name);
      if (meta?.worktreePath === targetPath) return meta;
    }
  }
  return null;
}
const COMMITS_MAX_LIMIT = 500;

// Return the commit history of a project's current branch (HEAD), newest first.
// Validates the project via getProject (throws 404 if not found). Caps the log
// at `limit` (default 100, max 500) and sets `truncated` when more commits exist.
// Returns { project, branch, commits, truncated, limit, hasUncommitted, aheadCount, aheadOf },
// where each commit is { sha, shortSha, subject, author, relativeDate, isoDate, parents },
// and `parents` is the array of parent SHAs (empty for the root, ≥2 for a merge) — the
// frontend uses it to compute the branch/merge graph lanes.
// hasUncommitted: true when `git status --porcelain` is non-empty.
// aheadCount/aheadOf: how many leading commits are ahead of the base (upstream or
// worktree base branch), or null when unknown/not applicable.
export async function getProjectCommits(projectName, { limit = COMMITS_DEFAULT_LIMIT } = {}) {
  const proj = await getProject(projectName);
  const n = Number(limit);
  const cap = Math.max(1, Math.min(COMMITS_MAX_LIMIT, Number.isFinite(n) ? Math.floor(n) : COMMITS_DEFAULT_LIMIT));
  if (!(await isGitRepo(proj.path))) {
    return {
      project: projectName, branch: null, commits: [], truncated: false, limit: cap,
      hasUncommitted: false, aheadCount: null, aheadOf: null,
    };
  }
  const head = await runGit(proj.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.code === 0 ? (head.stdout.trim() || null) : null;

  // Detect uncommitted changes (staged or unstaged).
  const statusR = await runGit(proj.path, ['status', '--porcelain']);
  const hasUncommitted = statusR.code === 0
    ? (statusR.stdout || '').split('\n').some(l => l.trim().length > 0)
    : false;

  // Determine how many leading commits are "ahead" of the base.
  // Try upstream tracking first (normal project with a configured remote).
  // Fall back to worktree base-branch metadata (orchestrator-managed worktrees).
  let aheadCount = null;
  let aheadOf = null;
  const upstreamStatus = await getProjectUpstreamStatus(proj.path);
  if (upstreamStatus.ahead !== null) {
    aheadCount = upstreamStatus.ahead;
    aheadOf = upstreamStatus.upstream;
  } else {
    const worktreeMeta = await findWorktreeMetaForPath(proj.path);
    if (worktreeMeta) {
      const mergeStatus = await getWorktreeMergeStatus(worktreeMeta);
      if (mergeStatus.ahead !== null) {
        aheadCount = mergeStatus.ahead;
        aheadOf = worktreeMeta.baseBranch;
      }
    }
  }

  // Field separator \x1f between fields; %s/%h/%H/%an/%ar/%aI/%P are all single-line.
  // %P = parent SHAs (space-separated): empty for the root commit, ≥2 for a merge.
  const r = await runGit(proj.path, [
    'log', `--max-count=${cap + 1}`,
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%aI%x1f%P',
  ]);
  if (r.code !== 0) {
    // A fresh repo with no commits exits non-zero — treat as empty history.
    return {
      project: projectName, branch, commits: [], truncated: false, limit: cap,
      hasUncommitted, aheadCount, aheadOf,
    };
  }
  const rows = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, shortSha, subject, author, relativeDate, isoDate, parentField] = line.split('\x1f');
    const parents = parentField ? parentField.trim().split(' ').filter(Boolean) : [];
    return { sha, shortSha, subject, author, relativeDate, isoDate, parents };
  });
  const truncated = rows.length > cap;
  const commits = truncated ? rows.slice(0, cap) : rows;
  return { project: projectName, branch, commits, truncated, limit: cap, hasUncommitted, aheadCount, aheadOf };
}

// Return structured diff data for the change introduced by a single commit.
// Mirrors getWorktreeDiff's response shape so the same frontend renderer works.
// Validates the project via getProject; guards `sha` to a hex object name.
// Uses `git show` (handles root commits automatically). Returns
// { project, sha, files, totalAdds, totalDels, truncated }.
export async function getCommitDiff(projectName, sha, { contextLines = 3 } = {}) {
  const proj = await getProject(projectName);
  if (!/^[0-9a-fA-F]{4,40}$/.test(String(sha))) {
    const err = new Error('invalid commit sha');
    err.statusCode = 400;
    throw err;
  }
  const ctx = Math.max(0, Math.min(50, Number.isFinite(Number(contextLines)) ? Math.floor(Number(contextLines)) : 3));
  const [r, msgR] = await Promise.all([
    runGit(proj.path, ['show', `--unified=${ctx}`, '--format=', '--no-color', sha]),
    runGit(proj.path, ['log', '-1', '--format=%B', sha]),
  ]);
  if (r.code !== 0) {
    const stderr = (r.stderr || '').trim();
    const notFound = /unknown revision|bad revision|ambiguous argument/i.test(stderr);
    const err = new Error(stderr || `git show ${sha} failed`);
    err.statusCode = notFound ? 404 : 500;
    throw err;
  }
  const commitMessage = msgR.code === 0 ? (msgR.stdout.trim() || null) : null;
  const rawOutput = r.stdout;
  const truncated = rawOutput.length > DIFF_BYTE_CAP;
  const raw = truncated ? rawOutput.slice(0, DIFF_BYTE_CAP) : rawOutput;
  const files = parseUnifiedDiff(raw);
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  return { project: projectName, sha, commitMessage, files, totalAdds, totalDels, truncated };
}

// Return structured diff data for all uncommitted changes in a project's
// working tree (staged + unstaged vs HEAD). Uses `git diff HEAD` so both
// staged and unstaged changes are included in one pass.
// Returns { project, files, totalAdds, totalDels, truncated }.
// If HEAD doesn't exist (fresh repo with no commits), returns an empty file
// list rather than throwing — the frontend treats this as "no diff to show".
export async function getProjectUncommittedDiff(projectName, { contextLines = 3 } = {}) {
  const proj = await getProject(projectName);
  const ctx = Math.max(0, Math.min(50, Number.isFinite(Number(contextLines)) ? Math.floor(Number(contextLines)) : 3));
  const r = await runGit(proj.path, ['diff', 'HEAD', `--unified=${ctx}`, '--no-color']);
  if (r.code !== 0) {
    return { project: projectName, files: [], totalAdds: 0, totalDels: 0, truncated: false };
  }
  const rawOutput = r.stdout;
  const truncated = rawOutput.length > DIFF_BYTE_CAP;
  const raw = truncated ? rawOutput.slice(0, DIFF_BYTE_CAP) : rawOutput;
  const files = parseUnifiedDiff(raw);
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  return { project: projectName, files, totalAdds, totalDels, truncated };
}
