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
import {
  projectsRoot, getProject, projectStoreDir, worktreeStoreDir, listProjects,
  type ProjectInfo,
} from './projects.ts';

// Manual execFile wrapper. `promisify(execFile)` would be tempting but
// this Node build (Termux's android port) doesn't ship the
// util.promisify.custom symbol on execFile, so the promisified version
// resolves to just stdout (a string) instead of {stdout, stderr}.
// Wrap it ourselves so the shape is reliable across runtimes.
interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(file: string, args: string[], options: object = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

const WORKTREE_META_FILENAME = 'worktree.json';

export interface WorktreeMeta {
  parentProject: string;
  parentPath: string;
  worktreeName: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string;
}

// Where this project / worktree's central-store entry lives. Pass
// `worktreeName: null` for the project root.
function baseStoreDir(project: string, worktreeName: string | null): string {
  return worktreeName
    ? worktreeStoreDir(project, worktreeName)
    : projectStoreDir(project);
}

export function attachmentsDir(project: string, worktreeName: string | null): string {
  return path.join(baseStoreDir(project, worktreeName), 'attachments');
}

export function debugBaseDir(project: string, worktreeName: string | null): string {
  return path.join(baseStoreDir(project, worktreeName), 'debug');
}

function metaPath(project: string, worktreeName: string): string {
  return path.join(worktreeStoreDir(project, worktreeName), WORKTREE_META_FILENAME);
}

// Shorter-than-uuid identifier — 6 hex chars is plenty for collision
// avoidance across a handful of worktrees per project.
function shortId(): string {
  return randomBytes(3).toString('hex');
}

function worktreeBranchName(id: string): string {
  return `code-conductor/${id}`;
}

function worktreeDirName(project: string, id: string): string {
  return `${project}_worktree_${id}`;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown };
    // execFile rejects with an error that carries stdout/stderr/code.
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : typeof err.message === 'string' ? err.message : '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const r = await runGit(projectPath, ['rev-parse', '--git-dir']);
  return r.code === 0;
}

// `git status --porcelain` for a worktree path. Returns
// { ok: boolean, lines: string[] }. Callers can decide whether a
// non-empty `lines` means "refuse" or "fall back to the agent flow".
export async function worktreeDirtyLines(worktreePath: string): Promise<{ ok: boolean; lines: string[] }> {
  const dirty = await runGit(worktreePath, ['status', '--porcelain']);
  if (dirty.code !== 0) return { ok: false, lines: [] };
  const lines = (dirty.stdout || '').split('\n').filter(l => l.trim().length > 0);
  return { ok: true, lines };
}

// Look up the parent repo's current branch + commit. Detached HEAD is
// allowed (we record null for `branch`) — the rebase-back path will
// require a named branch, but creation itself shouldn't be blocked.
export async function getHeadBranchAndSha(projectPath: string): Promise<{ branch: string | null; sha: string }> {
  const head = await runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() || null : null;
  const sha = await runGit(projectPath, ['rev-parse', 'HEAD']);
  if (sha.code !== 0) {
    throw httpError(400, `unable to resolve HEAD in ${projectPath}: ${sha.stderr.trim()}`);
  }
  return { branch, sha: sha.stdout.trim() };
}

async function writeMeta(project: string, worktreeName: string, meta: WorktreeMeta): Promise<void> {
  await fs.mkdir(worktreeStoreDir(project, worktreeName), { recursive: true });
  await fs.writeFile(metaPath(project, worktreeName), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

async function readMeta(project: string, worktreeName: string): Promise<WorktreeMeta | null> {
  let text: string;
  try { text = await fs.readFile(metaPath(project, worktreeName), 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
  try {
    const obj: unknown = JSON.parse(text);
    return typeof obj === 'object' && obj !== null ? obj as WorktreeMeta : null;
  } catch { return null; }
}
// Store-only read (no `git worktree list` verification) — for scans that
// must stay cheap across many projects (plugin manifest discovery). A stale
// entry's worktreePath simply won't resolve for the caller.
export { readMeta as readWorktreeMeta };

// Cap on hook output kept in memory — tail of this many bytes is retained.
// Chatty scripts (npm ci, etc.) can emit MBs; keep only the tail so the
// result field stays network-friendly. `HOOK_OUTPUT_CAP` is generous for diagnostics.
const HOOK_OUTPUT_CAP = 16 * 1024;

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; }
  catch { return false; }
}

interface PostWorktreeHookResult {
  ran: boolean;
  skipped?: string;
  source?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  timedOut?: boolean;
  error?: boolean;
}

// Run `post-worktree-create.sh` with cwd in the new worktree. Resolved
// from two locations, in priority order:
//   1. in-tree: `<parentPath>/.code-conductor/post-worktree-create.sh`
//      (read from the parent checkout — need not be committed).
//   2. store:   `<projectStoreDir>/post-worktree-create.sh` (the central
//      orchestrator store, out of the tracked tree).
// Always resolves — never rejects — so a broken hook cannot abort a
// successful worktree create. Result is attached to the createWorktree()
// return value as `postWorktreeCreate`; `source` records which location ran.
async function runPostWorktreeHook(meta: WorktreeMeta): Promise<PostWorktreeHookResult> {
  if (process.env.ORCH_DISABLE_POST_WORKTREE_HOOK === '1') {
    return { ran: false, skipped: 'disabled' };
  }

  const inTree = path.join(meta.parentPath, '.code-conductor', 'post-worktree-create.sh');
  const inStore = path.join(projectStoreDir(meta.parentProject), 'post-worktree-create.sh');
  let scriptPath: string | null = null;
  let source: string | null = null;
  if (await fileExists(inTree)) { scriptPath = inTree; source = 'in-tree'; }
  else if (await fileExists(inStore)) { scriptPath = inStore; source = 'store'; }
  if (!scriptPath) return { ran: false };

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
    const chunks: Buffer[] = [];

    // detached=true puts bash + all its children in their own process group so
    // we can kill the whole group (including long-running child processes like
    // `npm ci`) with a single process.kill(-pid, signal) on timeout.
    const proc = spawn('bash', [scriptPath], {
      cwd: meta.worktreePath,
      env,
      detached: true,
    });

    const onData = (chunk: Buffer) => chunks.push(chunk);
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    const killGroup = (): void => {
      if (proc.pid != null) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      } else {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
      // SIGKILL backstop: sends SIGKILL if the process group doesn't die
      // from SIGTERM within the SIGKILL-backoff delay set in the setTimeout below (e.g. `sleep` ignoring SIGTERM on some
      // platforms). Unref'd so it can't keep the process alive.
      setTimeout(() => {
        if (proc.pid != null) {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
        } else {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 100).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const raw = Buffer.concat(chunks).toString('utf8');
      const truncated = raw.length > HOOK_OUTPUT_CAP;
      let output: string;
      if (truncated) {
        const tail = raw.slice(raw.length - HOOK_OUTPUT_CAP);
        // Start at the next newline so output begins on a clean line.
        const nl = tail.indexOf('\n');
        output = '… [truncated]\n' + (nl >= 0 ? tail.slice(nl + 1) : tail);
      } else {
        output = raw;
      }
      const result: PostWorktreeHookResult = {
        ran: true,
        source,
        exitCode: timedOut ? null : (code ?? null),
        durationMs,
        output: output.trimEnd(),
      };
      if (truncated) result.truncated = true;
      if (timedOut) result.timedOut = true;
      resolve(result);
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        source,
        exitCode: null,
        durationMs: Date.now() - start,
        output: err.message,
        error: true,
      });
    });
  });
}

interface CreateWorktreeResult extends WorktreeMeta {
  postWorktreeCreate: PostWorktreeHookResult;
}

// Create a fresh worktree off the parent repo's current HEAD. Returns
// the metadata that was written to disk.
export async function createWorktree(projectName: string): Promise<CreateWorktreeResult> {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.path))) {
    throw httpError(400, `project '${projectName}' is not a git repository`);
  }
  const head = await getHeadBranchAndSha(proj.path);
  if (!head.branch) {
    // git worktree add can work off a detached HEAD, but tracking down
    // "what was the base" later is messy. Refuse cleanly instead.
    throw httpError(400, `project '${projectName}' is on a detached HEAD; check out a branch before creating a worktree`);
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
    throw httpError(500, `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }

  const meta: WorktreeMeta = {
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
export async function listWorktrees(projectName: string): Promise<WorktreeMeta[]> {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.path))) return [];
  const r = await runGit(proj.path, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const candidates: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      candidates.push(line.slice('worktree '.length));
    }
  }
  const out: WorktreeMeta[] = [];
  for (const wtPath of candidates) {
    // Skip the parent repo itself (no store entry).
    const dirName = path.basename(wtPath);
    const meta = await readMeta(projectName, dirName).catch(() => null);
    if (meta && meta.parentProject === projectName) out.push(meta);
  }
  out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return out;
}

export async function getWorktree(projectName: string, worktreeName: string): Promise<WorktreeMeta | null> {
  const all = await listWorktrees(projectName);
  return all.find(w => w.worktreeName === worktreeName) ?? null;
}

// Remove a worktree: deregister it via git, drop the directory, delete
// the branch, drop the central-store entry. We refuse if the working
// tree has uncommitted changes so the user can't silently throw away
// in-progress agent work.
export async function removeWorktree(
  projectName: string,
  worktreeName: string,
  { force = false }: { force?: boolean } = {},
): Promise<WorktreeMeta> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
  }
  const parentPath = meta.parentPath;

  if (!force) {
    const dirty = await worktreeDirtyLines(meta.worktreePath);
    if (dirty.ok && dirty.lines.length > 0) {
      throw httpError(
        409,
        `worktree '${worktreeName}' has uncommitted changes — commit / discard them, or pass force=true`,
      );
    }
  }

  // Pass --force to `git worktree remove`. We already validated the
  // tree is clean above (or the caller opted into force); the flag
  // also keeps git from refusing on minor leftover state.
  const rm = await runGit(parentPath, ['worktree', 'remove', '--force', meta.worktreePath]);
  if (rm.code !== 0) {
    throw httpError(500, `git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`);
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

export interface MergeStatus {
  ahead: number | null;
  behind: number | null;
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
export async function getWorktreeMergeStatus(meta: WorktreeMeta): Promise<MergeStatus> {
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

export interface UpstreamStatus extends MergeStatus {
  upstream: string | null;
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
export async function getProjectUpstreamStatus(projectPath: string): Promise<UpstreamStatus> {
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

interface MergeFailure {
  ok: false;
  code: string;
  reason?: string;
  behind?: number;
  baseBranch?: string;
}

interface MergeSuccess {
  ok: true;
  output: string;
  newSha: string;
  worktreeFastForwarded: boolean;
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
export async function mergeWorktreeIntoParent(
  projectName: string,
  worktreeName: string,
  { allowDirty = false }: { allowDirty?: boolean } = {},
): Promise<MergeSuccess | MergeFailure> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
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
  // 3. The worktree's own tree must be clean too — only committed work gets
  //    merged, so uncommitted/untracked changes there would silently not
  //    land. Overridable: allowDirty:true merges anyway.
  if (!allowDirty) {
    const wtDirty = await worktreeDirtyLines(meta.worktreePath);
    if (wtDirty.ok && wtDirty.lines.length > 0) {
      return {
        ok: false,
        code: 'WORKTREE_DIRTY',
        reason: `worktree has uncommitted or untracked changes that would not be included in the merge — ` +
          `commit them first, or pass allowDirty:true to merge anyway`,
      };
    }
  }
  // 4. Nothing to do if the branch has no commits ahead of its base — a
  //    --no-ff merge here would either no-op ("Already up to date") or,
  //    depending on git version/state, still be a pointless call.
  if (status.ahead != null && status.ahead === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_MERGE',
      reason: `worktree branch has no commits ahead of '${meta.baseBranch}' — nothing to merge`,
    };
  }
  // 5. Attempt the merge. --no-ff forces a merge commit even when FF would
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
  // 6. Fast-forward the worktree's own branch up to the merge commit. The
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

type SyncResult =
  | { ok: true; action: 'already-in-sync'; ahead: number; behind: number }
  | { ok: true; action: 'fast-forwarded'; ahead: 0; behind: 0; newSha: string }
  | { ok: true; action: 'rebased'; ahead: number; behind: 0; newSha: string }
  | { ok: true; action: 'rebase-required'; ahead: number; behind: number }
  | { ok: false; reason: string };

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
export async function syncWorktree(projectName: string, worktreeName: string): Promise<SyncResult> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
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
export function buildRebasePrompt(meta: WorktreeMeta): string {
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
export async function removeAllWorktreesForProject(projectName: string): Promise<void> {
  let known: WorktreeMeta[] = [];
  try { known = await listWorktrees(projectName); } catch { /* repo may be gone */ }
  for (const wt of known) {
    try { await removeWorktree(projectName, wt.worktreeName, { force: true }); } catch { /* ignore */ }
  }
}

// Default / maximum number of commits returned by getProjectCommits.
const COMMITS_DEFAULT_LIMIT = 100;

// Scan the metadata store for a worktree whose worktreePath matches
// the given absolute path. Returns the metadata object or null.
// Metadata lives at: projectStoreDir(project)/worktrees/<worktreeName>/worktree.json
// so we list subdirectories under the per-project 'worktrees/' dir.
async function findWorktreeMetaForPath(targetPath: string): Promise<WorktreeMeta | null> {
  let projects: ProjectInfo[];
  try { projects = await listProjects(); } catch { return null; }
  for (const proj of projects) {
    const wtListDir = path.join(projectStoreDir(proj.name), 'worktrees');
    let entries: import('node:fs').Dirent[];
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

interface CommitRow {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  parents: string[];
}

// Return the commit history of a project's current branch (HEAD), newest first.
// Validates the project via getProject (throws 404 if not found). Caps the log
// at `limit` (default `COMMITS_DEFAULT_LIMIT`, max `COMMITS_MAX_LIMIT`) and sets `truncated` when more commits exist.
// Returns { project, branch, commits, truncated, limit, hasUncommitted, aheadCount, aheadOf },
// where each commit is { sha, shortSha, subject, author, relativeDate, isoDate, parents },
// and `parents` is the array of parent SHAs (empty for the root, ≥2 for a merge) — the
// frontend uses it to compute the branch/merge graph lanes.
// hasUncommitted: true when `git status --porcelain` is non-empty.
// aheadCount/aheadOf: how many leading commits are ahead of the base (upstream or
// worktree base branch), or null when unknown/not applicable.
export async function getProjectCommits(
  projectName: string,
  { limit = COMMITS_DEFAULT_LIMIT }: { limit?: number } = {},
): Promise<{
  project: string;
  branch: string | null;
  commits: CommitRow[];
  truncated: boolean;
  limit: number;
  hasUncommitted: boolean;
  aheadCount: number | null;
  aheadOf: string | null;
}> {
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
  let aheadCount: number | null = null;
  let aheadOf: string | null = null;
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
    return {
      sha: sha ?? '', shortSha: shortSha ?? '', subject: subject ?? '',
      author: author ?? '', relativeDate: relativeDate ?? '', isoDate: isoDate ?? '',
      parents,
    };
  });
  const truncated = rows.length > cap;
  const commits = truncated ? rows.slice(0, cap) : rows;
  return { project: projectName, branch, commits, truncated, limit: cap, hasUncommitted, aheadCount, aheadOf };
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// Throw an Error carrying an HTTP statusCode for the REST layer, using the
// same Object.assign pattern the routes consume (`err.statusCode`). Typed as
// `Error & { statusCode: number }` so callers can rely on the code without a
// cast.
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
