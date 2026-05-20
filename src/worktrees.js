// Git worktree operations for isolated agent runs. Each worktree lives as
// a sibling directory at `<projectsRoot>/<project>_worktree_<short-id>/`
// with a `.claude-orch-app/worktree.json` metadata file inside it. The
// metadata records the parent project + the branch / SHA that HEAD was
// on at creation time, so a later rebase-back targets the right base.
// `.claude-orch-app/` also holds the per-message attachments dir.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectsRoot, getProject } from './projects.js';

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

// Per-worktree dotfolder layout: `<worktree>/.claude-orch-app/worktree.json`
// for metadata, `<worktree>/.claude-orch-app/attachments/` for files attached
// to user messages.
export const ORCH_DOTDIR = '.claude-orch-app';
export const WORKTREE_META_FILENAME = 'worktree.json';

export function orchDotdir(worktreePath) {
  return path.join(worktreePath, ORCH_DOTDIR);
}

export function attachmentsDir(worktreePath) {
  return path.join(orchDotdir(worktreePath), 'attachments');
}

function metaPath(worktreePath) {
  return path.join(orchDotdir(worktreePath), WORKTREE_META_FILENAME);
}

// Shorter-than-uuid identifier — 6 hex chars is plenty for collision
// avoidance across a handful of worktrees per project.
function shortId() {
  return randomBytes(3).toString('hex');
}

function worktreeBranchName(id) {
  return `claude-orch/${id}`;
}

function worktreeDirName(project, id) {
  return `${project}_worktree_${id}`;
}

async function runGit(cwd, args) {
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

// `git status --porcelain` for a worktree path, with our orchestrator-
// owned dotdir filtered out (it's untracked by design). Returns
// { ok: boolean, lines: string[] }. Callers can decide whether a
// non-empty `lines` means "refuse" or "fall back to the agent flow".
export async function worktreeDirtyLines(worktreePath) {
  const dirty = await runGit(worktreePath, ['status', '--porcelain']);
  if (dirty.code !== 0) return { ok: false, lines: [] };
  const lines = (dirty.stdout || '').split('\n').filter(l => {
    const t = l.trim();
    if (!t) return false;
    // Porcelain "XY <path>" → grab the path and check the prefix.
    const m = t.match(/^..\s+(.*)$/);
    const p = m ? m[1] : t;
    if (p === ORCH_DOTDIR || p.startsWith(`${ORCH_DOTDIR}/`)) return false;
    return true;
  });
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

async function writeMeta(worktreePath, meta) {
  await fs.mkdir(orchDotdir(worktreePath), { recursive: true });
  await fs.writeFile(metaPath(worktreePath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export async function readMeta(worktreePath) {
  let text;
  try { text = await fs.readFile(metaPath(worktreePath), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch { return null; }
}

// One-line append to <worktree>/.git/info/exclude so the dotdir doesn't
// surface as untracked clutter in `git status`. Worktree-local — the
// project's tracked .gitignore is left alone. Idempotent.
async function excludeOrchDotdir(worktreePath) {
  // In a linked worktree, .git is a file pointing at the real gitdir.
  // We want the per-worktree info/exclude, which lives at <gitdir>/info/exclude.
  const r = await runGit(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
  if (r.code !== 0) return;
  const rel = r.stdout.trim();
  if (!rel) return;
  const excludeFile = path.isAbsolute(rel) ? rel : path.join(worktreePath, rel);
  let current = '';
  try { current = await fs.readFile(excludeFile, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') return; }
  const line = `/${ORCH_DOTDIR}/`;
  const lines = current.split('\n').map(s => s.trim());
  if (lines.includes(line)) return;
  const next = (current.endsWith('\n') || current.length === 0 ? current : current + '\n') + line + '\n';
  try {
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    await fs.writeFile(excludeFile, next, 'utf8');
  } catch { /* best-effort */ }
}

export async function isWorktreeDir(absDir) {
  const meta = await readMeta(absDir).catch(() => null);
  return meta != null;
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
  await writeMeta(worktreePath, meta);
  await excludeOrchDotdir(worktreePath);
  return meta;
}

// List every worktree on disk that we own for a given project. Reads
// the parent repo's `git worktree list --porcelain` and filters down to
// entries whose dir carries our metadata file. (We use git's view rather
// than scanning `projectsRoot` so stale orphaned directories don't show
// up if they were already deregistered from git.)
export async function listWorktrees(projectName) {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.path))) return [];
  const r = await runGit(proj.path, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) {
        // Skip the parent repo itself (no metadata, no relevance).
        const meta = await readMeta(cur.path).catch(() => null);
        if (meta && meta.parentProject === projectName) out.push(meta);
      }
      cur = { path: line.slice('worktree '.length) };
    }
  }
  if (cur) {
    const meta = await readMeta(cur.path).catch(() => null);
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
// the branch. We refuse if the working tree has uncommitted changes so
// the user can't silently throw away in-progress agent work.
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

  // Always pass --force to `git worktree remove`: the only thing we
  // tolerate in the working tree is our own (untracked) metadata file,
  // and we've already validated that above. Without --force, git would
  // refuse on that untracked file alone.
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

// Run `git merge --no-ff --no-edit <branch>` on the parent repo. Always
// produces a merge commit (even when a fast-forward would be possible)
// so each worktree's contribution is a visible branch in the parent's
// history — easy to spot in `git log --graph` and revertable as a single
// commit via `git revert -m 1 <mergeSha>`. The commit message uses git's
// default ("Merge branch 'claude-orch/<id>'"). Returns {ok:true, newSha}
// on success or {ok:false, reason} when the merge can't proceed (parent
// on wrong branch, dirty parent, conflicts, etc.) — caller surfaces the
// reason to the UI rather than throwing.
export async function mergeWorktreeIntoParent(projectName, worktreeName) {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    const err = new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    err.statusCode = 404;
    throw err;
  }
  // 1. Parent must currently be on the captured base branch — otherwise
  //    the merge would land work somewhere unexpected.
  const head = await getHeadBranchAndSha(meta.parentPath);
  if (head.branch !== meta.baseBranch) {
    return {
      ok: false,
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
      reason: (merge.stderr.trim() || merge.stdout.trim() ||
        `git merge --no-ff ${meta.branch} failed`),
    };
  }
  const newHead = await runGit(meta.parentPath, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    output: merge.stdout.trim() || merge.stderr.trim(),
    newSha: newHead.stdout.trim(),
  };
}

// Bring a worktree's branch up to date with the parent's baseBranch.
// Picks the cheapest path:
//   - behind == 0                                 → already in sync (no-op).
//   - behind > 0, ahead == 0, worktree tree clean → server-side `git
//     merge --ff-only <baseBranch>` inside the worktree.
//   - anything else (diverged, or pure-behind but dirty)
//                                                 → caller must send
//     buildRebasePrompt(meta) to the worktree's agent (the rebase is
//     async + interactive, so we don't drive `git rebase` ourselves).
// Returns one of:
//   { ok:true,  action:"already-in-sync",  ahead, behind }
//   { ok:true,  action:"fast-forwarded",   ahead:0, behind:0, newSha }
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
  // Diverged → agent must rebase interactively.
  if (ahead > 0) {
    return { ok: true, action: 'rebase-required', ahead, behind };
  }
  // Pure-behind: try a clean fast-forward inside the worktree. Fall
  // back to the rebase path if the working tree is dirty (the agent
  // will commit / discard before rebasing).
  const dirty = await worktreeDirtyLines(meta.worktreePath);
  if (!dirty.ok) {
    return { ok: false, reason: `git status failed inside worktree '${meta.worktreePath}'` };
  }
  if (dirty.lines.length > 0) {
    return { ok: true, action: 'rebase-required', ahead, behind };
  }
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
// project, plus any orphan sibling dirs that carry our metadata marker
// but aren't registered with git (left behind by manual filesystem
// mucking). Used by the project-delete cascade — failures are
// swallowed because the caller is about to `rm -rf` the parent anyway.
export async function removeAllWorktreesForProject(projectName) {
  let known = [];
  try { known = await listWorktrees(projectName); } catch { /* repo may be gone */ }
  for (const wt of known) {
    try { await removeWorktree(projectName, wt.worktreeName, { force: true }); } catch { /* ignore */ }
  }
  // Sweep the projects root for orphan dirs that point at this project.
  let entries = [];
  try { entries = await fs.readdir(projectsRoot(), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(projectsRoot(), e.name);
    const meta = await readMeta(full).catch(() => null);
    if (meta && meta.parentProject === projectName) {
      try { await fs.rm(full, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// Re-exported for tests / route handlers.
export const _internal = {
  worktreeBranchName,
  worktreeDirName,
  runGit,
  shortId,
};
