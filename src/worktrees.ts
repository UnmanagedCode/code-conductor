// Git worktree operations for isolated agent runs. A worktree dir lives beside
// the project's RECORD, inside cc's own tree: `<projectsRoot>/<project>_worktree_<short-id>/`
// for an in-root project, `<projectsRoot>/.external/<project>_worktree_<short-id>/`
// for an adopted one — whose `path` is the target's realpath, so a literal
// sibling would put a cc-owned, cc-deleted directory in the user's own parent dir.
// All orchestrator-owned metadata for the worktree (worktree.json,
// attachments/, debug/) lives in the central store under
// `<projectsRoot>/.code-conductor/projects/<project>/worktrees/<worktreeDir>/`
// — the worktree dir itself stays clean.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { httpError } from './httpError.ts';
import {
  projectsRoot, getProject, projectStoreDir, worktreeStoreDir, listProjects,
  EXTERNAL_DIRNAME,
  type ProjectInfo,
} from './projects.ts';
import { resolveSystem } from './systems/registry.ts';
import type { System } from './systems/system.ts';

const WORKTREE_META_FILENAME = 'worktree.json';

export interface WorktreeMeta {
  parentProject: string;
  parentPath: string;
  worktreeName: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  // Set only when this worktree was created off ANOTHER worktree of the same
  // project ("a feature branch"): the base worktree's worktreeName. Absent
  // means based on the project root — the canonical shape, not a legacy one.
  // `parentProject` stays the ROOT project name either way: listWorktrees
  // filters on it, so a derived worktree that recorded its base there would
  // disappear from every listing in the app.
  baseWorktree?: string;
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

// Max slug length. Long enough for a readable feature name, short enough to
// keep `<project>_worktree_<slug>` a manageable directory name.
const SLUG_MAX_LEN = 40;

// Human-readable name → the id that goes into the branch + directory name. A
// feature branch is read in `git log` for weeks, so a hash is the wrong id for
// one. The result always matches /^[a-z0-9][a-z0-9-]*$/, which is both a valid
// git ref component and a safe directory suffix — so the callers below need no
// further escaping. Returns '' when the name has no usable characters; the
// caller refuses.
function slugifyWorktreeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/, '');
}

function worktreeBranchName(id: string): string {
  return `code-conductor/${id}`;
}

function worktreeDirName(project: string, id: string): string {
  return `${project}_worktree_${id}`;
}

// A caller-supplied worktree name → the canonical worktreeName among `known`.
// Accepts the full dir name or the bare slug the GUI displays (it strips the
// `<project>_worktree_` prefix everywhere it renders one), so the string a user
// reads is a string the API accepts. Exact match wins, so the full spelling can
// never be shadowed. Composes the alias rather than stripping a prefix off the
// input: that makes it a pure function of (project, input) which can match at
// most one record, so no ambiguity — and no ambiguity refusal — is reachable.
export function resolveWorktreeName(
  project: string,
  input: string,
  known: Iterable<string>,
): string | null {
  const names = [...known];
  if (names.includes(input)) return input;
  const composed = worktreeDirName(project, input);
  return names.includes(composed) ? composed : null;
}

// The create-side mirror of the read side: a caller echoing a full dir name
// back into `create_worktree` names the worktree they meant, not a mangled
// sibling. Strips at most one literal prefix, and must run BEFORE
// slugifyWorktreeName — that maps `_` to `-`, destroying the prefix before it
// could be recognised. An empty remainder falls through to the caller's refusal.
function stripWorktreeDirPrefix(project: string, name: string): string {
  const prefix = `${project}_worktree_`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

// EVERY git invocation in the app funnels through here, which is why it is the
// single site that gives git a System: one signature converts the whole git
// surface. Git is DERIVED from the `exec` primitive — it is not a system
// operation of its own, so a provider never implements it.
//
// `-C <cwd>` is kept alongside the exec cwd: it anchors git to the repo even
// if a provider normalises the working directory, and it is what makes the
// argv self-describing in a protocol trace.
//
// Output is uncapped: callers parse git porcelain whole, so a tail cap would
// silently corrupt a large diff instead of reporting one. `spawnError` folds
// into `stderr` because callers read stderr for the diagnostic and a git that
// never started has none of its own.
export async function runGit(system: System, cwd: string, args: string[]): Promise<GitResult> {
  const r = await system.exec({ argv: ['git', '-C', cwd, ...args] }, { cwd });
  return { stdout: r.stdout, stderr: r.stderr || r.spawnError || '', code: r.code };
}

export async function isGitRepo(system: System, projectPath: string): Promise<boolean> {
  const r = await runGit(system, projectPath, ['rev-parse', '--git-dir']);
  return r.code === 0;
}

// True when `projectPath`'s HEAD points at a branch with no commits yet — a
// `git init`ed dir nothing has been committed to. `rev-parse --verify --quiet
// HEAD` exits non-zero and silent there, 0 on any resolvable HEAD (detached
// included). CALL ONLY WHEN isGitRepo() IS ALREADY TRUE: outside a repo it also
// exits non-zero, which would read as "unborn" rather than "no repo".
export async function hasUnbornHead(system: System, projectPath: string): Promise<boolean> {
  const r = await runGit(system, projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return r.code !== 0;
}

// `git status --porcelain` for a worktree path. Returns
// { ok: boolean, lines: string[] }. Callers can decide whether a
// non-empty `lines` means "refuse" or "fall back to the agent flow".
export async function worktreeDirtyLines(system: System, worktreePath: string): Promise<{ ok: boolean; lines: string[] }> {
  const dirty = await runGit(system, worktreePath, ['status', '--porcelain']);
  if (dirty.code !== 0) return { ok: false, lines: [] };
  const lines = (dirty.stdout || '').split('\n').filter(l => l.trim().length > 0);
  return { ok: true, lines };
}

// Look up the parent repo's current branch + commit. Detached HEAD is
// allowed (we record null for `branch`) — the rebase-back path will
// require a named branch, but creation itself shouldn't be blocked.
export async function getHeadBranchAndSha(system: System, projectPath: string): Promise<{ branch: string | null; sha: string }> {
  const head = await runGit(system, projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() || null : null;
  const sha = await runGit(system, projectPath, ['rev-parse', 'HEAD']);
  if (sha.code !== 0) {
    // `rev-parse HEAD` fails for more than one reason, and two of this
    // function's callers hand it a path nothing has repo-validated: the
    // `baseWorktree` branch of createWorktree (a path read straight out of a
    // store record, which readMeta's own comment says can be stale) and
    // mergeWorktreeIntoParent's `meta.parentPath`. A directory removed
    // out-of-band or a corrupt repo lands here too, so PROVE the unborn case
    // before naming it — an unborn HEAD is a symbolic ref whose target branch
    // has no commits, which neither of those other failures satisfies.
    const ref = await runGit(system, projectPath, ['symbolic-ref', '--quiet', 'HEAD']);
    const unborn = ref.code === 0
      && (await runGit(system, projectPath, ['show-ref', '--verify', '--quiet', ref.stdout.trim()])).code !== 0;
    if (unborn) {
      throw httpError(400, `${projectPath} has no commits yet — a worktree branches off HEAD, so make a first commit there first`);
    }
    // Anything else keeps git's own stderr, which is the only thing that names
    // the actual cause (a missing dir, a corrupt object store).
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

// The in-tree half of the same question, asked of the system the tree lives on.
async function systemFileExists(system: System, p: string): Promise<boolean> {
  try { return (await system.stat(p)) !== null; }
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
async function runPostWorktreeHook(system: System, meta: WorktreeMeta): Promise<PostWorktreeHookResult> {
  if (process.env.ORCH_DISABLE_POST_WORKTREE_HOOK === '1') {
    return { ran: false, skipped: 'disabled' };
  }

  const inTree = path.join(meta.parentPath, '.code-conductor', 'post-worktree-create.sh');
  const inStore = path.join(projectStoreDir(meta.parentProject), 'post-worktree-create.sh');
  let scriptPath: string | null = null;
  let source: string | null = null;
  // The in-tree script is read from the project's system; the store one is cc's
  // own, always local.
  if (await systemFileExists(system, inTree)) { scriptPath = inTree; source = 'in-tree'; }
  else if (await fileExists(inStore)) { scriptPath = inStore; source = 'store'; }
  if (!scriptPath) return { ran: false };

  // Ensure the executable bit is set — the script may have been committed
  // without it (e.g. on Windows / FAT filesystems). Non-fatal if chmod fails.
  try {
    if (source === 'in-tree') {
      const st = await system.stat(scriptPath);
      if (st && !(st.mode & 0o111)) await system.chmod(scriptPath, st.mode | 0o111);
    } else {
      const st = await fs.stat(scriptPath);
      if (!(st.mode & 0o111)) await fs.chmod(scriptPath, st.mode | 0o111);
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

  // detached=true (inside the system's exec) puts bash + all its children in
  // their own process group, so a timeout kills the whole tree — a hook running
  // `npm ci` would otherwise leave grandchildren orphaned. This hook keeps its
  // OWN result shaping rather than the shared one: it reports `timedOut` as a
  // flag with a null exitCode instead of the runner's 124 convention, and it
  // prefixes a truncation marker at a clean line boundary.
  const r = await system.exec({ argv: ['bash', scriptPath] }, {
    cwd: meta.worktreePath, env, timeoutMs, cap: HOOK_OUTPUT_CAP,
  });

  if (r.spawnError) {
    return { ran: true, source, exitCode: null, durationMs: r.durationMs, output: r.spawnError, error: true };
  }

  // Start the retained tail at the next newline so output begins on a clean line.
  let output = r.output;
  if (r.truncated) {
    const nl = output.indexOf('\n');
    output = '… [truncated]\n' + (nl >= 0 ? output.slice(nl + 1) : output);
  }

  const result: PostWorktreeHookResult = {
    ran: true,
    source,
    exitCode: r.timedOut ? null : r.code,
    durationMs: r.durationMs,
    output: output.trimEnd(),
  };
  if (r.truncated) result.truncated = true;
  if (r.timedOut) result.timedOut = true;
  return result;
}

interface CreateWorktreeResult extends WorktreeMeta {
  postWorktreeCreate: PostWorktreeHookResult;
}

interface CreateWorktreeOptions {
  // worktreeName of another worktree of the same project to base this one on
  // ("a feature branch"). Its HEAD supplies baseBranch/baseSha and its checkout
  // becomes parentPath — so this worktree syncs against, and merges into, that
  // worktree instead of the project root.
  baseWorktree?: string;
  // Human-readable name, slugified into the branch + directory name in place of
  // the random short id.
  name?: string;
}

// Create a fresh worktree off the base's current HEAD — the project root by
// default, or another worktree when `baseWorktree` names one. Returns the
// metadata that was written to disk.
export async function createWorktree(
  projectName: string,
  { baseWorktree, name }: CreateWorktreeOptions = {},
): Promise<CreateWorktreeResult> {
  const proj = await getProject(projectName);
  const system = proj.system;
  if (!(await isGitRepo(system, proj.path))) {
    throw httpError(400, `project '${projectName}' is not a git repository`);
  }
  // Resolve the base: either the project root or another worktree. A base
  // worktree is resolved through the store records, never by assembling a path —
  // getProject validates only the name charset and that the directory exists, so
  // it would happily resolve a worktree dir name.
  let basePath = proj.path;
  let baseLabel = `project '${projectName}'`;
  let baseWorktreeName: string | undefined;
  if (baseWorktree !== undefined) {
    const base = await getWorktree(projectName, baseWorktree);
    if (!base) {
      throw httpError(404, `base worktree '${baseWorktree}' not found under project '${projectName}'`);
    }
    // Depth cap of one. Not a safety guard: it is what keeps the
    // dependents refusal in syncWorktree / mergeWorktreeIntoParent
    // non-recursive — a base is always a leaf's direct parent, never a chain.
    if (base.baseWorktree) {
      throw httpError(
        400,
        `base worktree '${baseWorktree}' is itself based on '${base.baseWorktree}' — ` +
          `a worktree can only be based on one that is itself based on the project root (depth is capped at one)`,
      );
    }
    basePath = base.worktreePath;
    baseWorktreeName = base.worktreeName;
    baseLabel = `worktree '${baseWorktree}'`;
  }
  const head = await getHeadBranchAndSha(system, basePath);
  if (!head.branch) {
    // git worktree add can work off a detached HEAD, but tracking down
    // "what was the base" later is messy. Refuse cleanly instead.
    throw httpError(400, `${baseLabel} is on a detached HEAD; check out a branch before creating a worktree`);
  }

  let id: string;
  if (name !== undefined) {
    id = slugifyWorktreeName(stripWorktreeDirPrefix(projectName, name));
    if (!id) {
      throw httpError(400, `worktree name '${name}' has no usable characters — use letters or digits`);
    }
  } else {
    id = shortId();
  }
  const dirName = worktreeDirName(projectName, id);
  // See this file's header comment for why an external project's worktrees land
  // under `.external/` rather than beside the target repo.
  const worktreePath = path.join(
    proj.external ? path.join(projectsRoot(), EXTERNAL_DIRNAME) : projectsRoot(),
    dirName,
  );
  const branch = worktreeBranchName(id);

  // Collision pre-check. A random short id realistically never collides, but a
  // slug does ('auth' twice). What this buys is a clean 409 instead of the
  // httpError(500, 'git worktree add failed: …') git would otherwise produce —
  // NOT cleanup: on a branch collision git fails before creating the directory,
  // so there is nothing left behind either way.
  //
  // The branch ref is the only thing worth checking: the dir name and the branch
  // both derive from the same slug, and a registered worktree always still has
  // its branch (git refuses to delete a branch checked out in a worktree), so a
  // directory collision implies this one. It is also strictly stronger — it
  // catches a leftover branch with no worktree, which `removeWorktree`'s
  // best-effort `git branch -d` can leave behind and a directory check cannot
  // see.
  const existingBranch = await runGit(system, proj.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (existingBranch.code === 0) {
    throw httpError(
      409,
      `branch '${branch}' already exists in project '${projectName}' — ` +
        `either that worktree is still registered, or it was deleted and left the branch behind. ` +
        `Pick another name, or delete the branch.`,
    );
  }

  // `git worktree add <path> -b <branch> <start-point>` creates the
  // branch off the captured SHA so subsequent activity on the base
  // branch can't drift our base.
  const add = await runGit(system, proj.path, ['worktree', 'add', worktreePath, '-b', branch, head.sha]);
  if (add.code !== 0) {
    throw httpError(500, `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }

  const meta: WorktreeMeta = {
    parentProject: projectName,
    parentPath: basePath,
    worktreeName: dirName,
    worktreePath,
    branch,
    baseBranch: head.branch,
    baseSha: head.sha,
    // Written only when set, so a root-based record keeps its existing shape.
    // Canonical, never the caller's spelling: this is the foreign key
    // listDependentWorktrees matches on.
    ...(baseWorktreeName !== undefined ? { baseWorktree: baseWorktreeName } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeMeta(projectName, dirName, meta);
  // Run the per-project post-worktree-create hook. Runs AFTER the worktree
  // dir + branch + metadata are written, BEFORE the instance subprocess is
  // created — so a slow hook never interferes with the 5 s control-request
  // timeout. Non-fatal: a failure warns but does not roll back the worktree.
  const postWorktreeCreate = await runPostWorktreeHook(system, meta);
  return { ...meta, postWorktreeCreate };
}

// List every worktree on disk that we own for a given project. Reads
// the parent repo's `git worktree list --porcelain` and filters down to
// entries whose dir has a matching record in the central store.
export async function listWorktrees(projectName: string): Promise<WorktreeMeta[]> {
  const proj = await getProject(projectName);
  if (!(await isGitRepo(proj.system, proj.path))) return [];
  const r = await runGit(proj.system, proj.path, ['worktree', 'list', '--porcelain']);
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
  const name = resolveWorktreeName(projectName, worktreeName, all.map(w => w.worktreeName));
  return all.find(w => w.worktreeName === name) ?? null;
}

// Worktrees that name this one as their base. The predicate is over worktree
// RECORDS, not live instances: killing a worker is not enough — a surviving
// child whose base sha was rewritten under it is genuinely broken, so the
// worktree must actually be deleted before its base is allowed to move.
export async function listDependentWorktrees(projectName: string, worktreeName: string): Promise<string[]> {
  const all = await listWorktrees(projectName);
  // Alias here too, not just at getWorktree: the foreign key is matched
  // literally below, so a bare slug would silently return [] and bypass every
  // dependents refusal built on it.
  const name = resolveWorktreeName(projectName, worktreeName, all.map(w => w.worktreeName)) ?? worktreeName;
  return all.filter(w => w.baseWorktree === name).map(w => w.worktreeName);
}

// The shared refusal for "this worktree is somebody's base". Minted once here
// rather than per surface: unlike WORKTREE_BEHIND (where the REST user clicks
// Sync and the conductor calls sync_worktree), both audiences act identically —
// delete the children — so the wording names no button and no tool. `verb`
// distinguishes the three call sites, and keys the one clause whose content is
// verb-specific: sync and merge REWRITE the base under the children, delete
// takes the branch away entirely. Evaluated on the worktree being synced,
// merged, or deleted, NEVER on the worktree being merged INTO: it is this
// worktree's own history that must not be rewritten under its children, and a
// --no-ff merge onto it appends rather than rewrites. Applying it to a merge
// target would deadlock any feature with more than one child.
export function dependentsRefusal(
  worktreeName: string,
  dependents: string[],
  verb: 'syncing' | 'merging' | 'deleting',
): {
  ok: false; code: 'WORKTREE_HAS_DEPENDENTS'; dependents: string[]; reason: string;
} {
  const consequence = verb === 'deleting'
    ? 'deleting it would delete the branch they are based on'
    : `${verb} it would rewrite the base they were created from`;
  return {
    ok: false,
    code: 'WORKTREE_HAS_DEPENDENTS',
    dependents,
    reason: `worktree '${worktreeName}' is the base for ${dependents.length} other worktree(s) — ` +
      `${dependents.join(', ')} — and ${consequence}. ` +
      `Delete them first (killing their workers is not enough).`,
  };
}

// Remove a worktree: deregister it via git, drop the directory, delete
// the branch, drop the central-store entry. We refuse if the working
// tree has uncommitted changes so the user can't silently throw away
// in-progress agent work, or if another worktree is based on this one —
// the branch delete below would take that child's base out from under it.
// Both refusals precede every removal, so a refused delete leaves the
// directory, the branch, and the store entry intact.
export async function removeWorktree(
  projectName: string,
  worktreeName: string,
  { force = false }: { force?: boolean } = {},
): Promise<WorktreeMeta> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
  }
  const system = await resolveSystem(projectName);
  const parentPath = meta.parentPath;

  if (!force) {
    // Dependents first: a clean tree does not unblock this one, so checking it
    // second would name a blocker the caller can clear and still be refused.
    const dependents = await listDependentWorktrees(projectName, meta.worktreeName);
    if (dependents.length > 0) {
      throw httpError(409, dependentsRefusal(worktreeName, dependents, 'deleting').reason);
    }
    const dirty = await worktreeDirtyLines(system, meta.worktreePath);
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
  const rm = await runGit(system, parentPath, ['worktree', 'remove', '--force', meta.worktreePath]);
  if (rm.code !== 0) {
    throw httpError(500, `git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`);
  }
  // Branch deletion is best-effort — if the rebase-back already
  // fast-forwarded the base onto the worktree branch then `-d` will
  // succeed; otherwise the branch may be ahead and we use `-D`.
  const delArgs = ['branch', force ? '-D' : '-d', meta.branch];
  await runGit(system, parentPath, delArgs);
  // Drop the central-store entry (metadata + attachments + debug).
  try { await fs.rm(worktreeStoreDir(projectName, meta.worktreeName), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  return meta;
}

export interface MergeStatus {
  ahead: number | null;
  behind: number | null;
}

// Read `git rev-list --left-right --count <left>...<right>` from `cwd` and
// parse the pair. LEFT is BEHIND (commits on <left> missing from <right>),
// RIGHT is AHEAD. Returns { ahead: null, behind: null } on a non-zero exit or
// unparseable output — the shared "unknown" shape both callers render as
// "no indicator".
async function parseAheadBehind(system: System, cwd: string, left: string, right: string): Promise<MergeStatus> {
  const r = await runGit(system, cwd, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  if (r.code !== 0) return { ahead: null, behind: null };
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return { ahead: null, behind: null };
  const behind = Number.parseInt(parts[0], 10);
  const ahead = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ahead: null, behind: null };
  return { ahead, behind };
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
export async function getWorktreeMergeStatus(system: System, meta: WorktreeMeta): Promise<MergeStatus> {
  if (!meta?.parentPath || !meta?.baseBranch || !meta?.branch) {
    return { ahead: null, behind: null };
  }
  return parseAheadBehind(system, meta.parentPath, meta.baseBranch, meta.branch);
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
export async function getProjectUpstreamStatus(system: System, projectPath: string): Promise<UpstreamStatus> {
  const headRef = await runGit(system, projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (headRef.code !== 0) return { ahead: null, behind: null, upstream: null };
  const branch = headRef.stdout.trim();
  if (!branch) return { ahead: null, behind: null, upstream: null };
  const upRef = await runGit(system, projectPath, [
    'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
  ]);
  if (upRef.code !== 0) return { ahead: null, behind: null, upstream: null };
  const upstream = upRef.stdout.trim();
  if (!upstream) return { ahead: null, behind: null, upstream: null };
  const st = await parseAheadBehind(system, projectPath, upstream, branch);
  // ahead and behind are always set or nulled together, so one test covers both.
  // On a parse failure the resolved upstream ref is DISCARDED, not reported.
  if (st.ahead === null) return { ahead: null, behind: null, upstream: null };
  return { ...st, upstream };
}

interface MergeFailure {
  ok: false;
  code: string;
  reason?: string;
  behind?: number;
  baseBranch?: string;
  dependents?: string[];
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
  const system = await resolveSystem(projectName);
  // 0. Refuse if another worktree is based on this one. THIS merge moves their
  //    base on its own: step 7 below fast-forwards this worktree's own branch
  //    onto the merge commit, and that branch IS what the children were created
  //    from, so their baseSha stops being its tip the moment this call succeeds.
  //    A fast-forward only moves the tip — the old sha stays a reachable
  //    ancestor, so the children end up behind rather than broken — but the base
  //    is not allowed to move at all while children exist, which is what this
  //    gate enforces. Checked ahead of the behind-gate deliberately: merging
  //    requires a prior sync, and that sync also refuses, so without this gate a
  //    worktree with dependents and a moved base would report WORKTREE_BEHIND and
  //    send the caller to a sync_worktree that refuses for the real reason. This
  //    gate names the real blocker on the first call. Evaluated on the worktree
  //    being MERGED, never on the one being merged INTO — see dependentsRefusal.
  const dependents = await listDependentWorktrees(projectName, meta.worktreeName);
  if (dependents.length > 0) {
    return dependentsRefusal(worktreeName, dependents, 'merging');
  }
  // 1. Refuse if the worktree branch is behind its base — the merge would
  //    still work, but conflicts would surface on the parent side instead of
  //    being resolved inside the worktree (where the agent can help). Checked
  //    before the branch-mismatch / dirty gates, matching the order the REST +
  //    MCP callers used before this moved in.
  //    Returns data fields only; each caller maps the code to its own
  //    audience-specific reason string (REST "click Sync first" / MCP "call
  //    sync_worktree first").
  const status = await getWorktreeMergeStatus(system, meta);
  if (status.behind != null && status.behind > 0) {
    return { ok: false, code: 'WORKTREE_BEHIND', behind: status.behind, baseBranch: meta.baseBranch };
  }
  // 2. Parent must currently be on the captured base branch — otherwise
  //    the merge would land work somewhere unexpected. A worktree base
  //    satisfies this by construction: its HEAD *is* its own branch, which is
  //    exactly this worktree's baseBranch.
  const head = await getHeadBranchAndSha(system, meta.parentPath);
  if (head.branch !== meta.baseBranch) {
    return {
      ok: false,
      code: 'BASE_BRANCH_MISMATCH',
      reason: `parent repo is on '${head.branch}', but this worktree was branched from '${meta.baseBranch}'. ` +
        `Switch the parent back to '${meta.baseBranch}' before merging.`,
    };
  }
  // 3. Parent's working tree must be clean — `git merge` refuses
  //    otherwise, but the error message is friendlier from us. Note there is no
  //    override: a worktree used as a base is a merge target, so it has to be
  //    kept clean.
  const dirty = await runGit(system, meta.parentPath, ['status', '--porcelain']);
  if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'PARENT_DIRTY',
      reason: `parent repo has uncommitted changes — commit or stash them before merging`,
    };
  }
  // 4. The worktree's own tree must be clean too — only committed work gets
  //    merged, so uncommitted/untracked changes there would silently not
  //    land. Overridable: allowDirty:true merges anyway.
  if (!allowDirty) {
    const wtDirty = await worktreeDirtyLines(system, meta.worktreePath);
    if (wtDirty.ok && wtDirty.lines.length > 0) {
      return {
        ok: false,
        code: 'WORKTREE_DIRTY',
        reason: `worktree has uncommitted or untracked changes that would not be included in the merge — ` +
          `commit them first, or pass allowDirty:true to merge anyway`,
      };
    }
  }
  // 5. Nothing to do if the branch has no commits ahead of its base — a
  //    --no-ff merge here would either no-op ("Already up to date") or,
  //    depending on git version/state, still be a pointless call.
  if (status.ahead != null && status.ahead === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_MERGE',
      reason: `worktree branch has no commits ahead of '${meta.baseBranch}' — nothing to merge`,
    };
  }
  // 6. Attempt the merge. --no-ff forces a merge commit even when FF would
  //    be possible; --no-edit makes git use its default message non-
  //    interactively (we'd hang otherwise waiting on an editor).
  const merge = await runGit(system, meta.parentPath, ['merge', '--no-ff', '--no-edit', meta.branch]);
  if (merge.code !== 0) {
    return {
      ok: false,
      code: 'MERGE_FAILED',
      reason: (merge.stderr.trim() || merge.stdout.trim() ||
        `git merge --no-ff ${meta.branch} failed`),
    };
  }
  const newHead = await runGit(system, meta.parentPath, ['rev-parse', 'HEAD']);
  // 7. Fast-forward the worktree's own branch up to the merge commit. The
  //    worktree branch is one of that commit's two parents, so it's always
  //    an ancestor of the new HEAD — --ff-only can't fail on divergence.
  //    Must run from inside the worktree dir: the branch is checked out
  //    there, not in the parent repo, so `git branch -f` from the parent
  //    would refuse. Best-effort — the merge already succeeded and the
  //    parent is correct regardless of whether this step lands, so a
  //    failure here (e.g. a worktree tree that went dirty mid-merge) must
  //    not turn the overall result into a failure.
  const ff = await runGit(system, meta.worktreePath, ['merge', '--ff-only', meta.baseBranch]);
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
  | { ok: true; action: 'commit-required' | 'rebase-conflict'; ahead: number; behind: number;
      branch: string; baseBranch: string; baseSha: string; rebasePrompt: string }
  | { ok: false; code: 'WORKTREE_HAS_DEPENDENTS'; dependents: string[]; reason: string }
  | { ok: false; reason: string };

// One builder for both blocked results so the two call sites below cannot drift.
function rebaseBlocked(meta: WorktreeMeta, action: 'commit-required' | 'rebase-conflict',
                       ahead: number, behind: number): SyncResult {
  return {
    ok: true, action, ahead, behind,
    branch: meta.branch, baseBranch: meta.baseBranch, baseSha: meta.baseSha,
    rebasePrompt: buildRebasePrompt(meta, action === 'commit-required' ? 'dirty' : 'conflict'),
  };
}

// Bring a worktree's branch up to date with the parent's baseBranch.
// Picks the cheapest path:
//   - behind == 0                                 → already in sync (no-op).
//   - behind > 0, ahead == 0, worktree tree clean → server-side `git
//     merge --ff-only <baseBranch>` inside the worktree.
//   - behind > 0 + dirty tree (any ahead count)   → 'commit-required': the
//     worktree must commit or discard before any rebase can run. Reached only
//     after the behind == 0 short-circuit above, so a dirty worktree that is
//     not behind is 'already-in-sync', never this.
//   - ahead > 0, clean tree                       → attempt server-side
//     `git rebase <baseBranch>`; on success return 'rebased'; on conflict
//     abort cleanly and return 'rebase-conflict'.
// Prompts nobody: the two blocked results carry a rendered `rebasePrompt` for
// the caller to dispatch (or not) as its own explicit act.
// Returns one of:
//   { ok:true,  action:"already-in-sync",  ahead, behind }
//   { ok:true,  action:"fast-forwarded",   ahead:0, behind:0, newSha }
//   { ok:true,  action:"rebased",          ahead, behind:0, newSha }
//   { ok:true,  action:"commit-required"|"rebase-conflict", ahead, behind,
//               branch, baseBranch, baseSha, rebasePrompt }
//   { ok:false, reason: "..." }
export async function syncWorktree(projectName: string, worktreeName: string): Promise<SyncResult> {
  const meta = await getWorktree(projectName, worktreeName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
  }
  const system = await resolveSystem(projectName);
  // Refuse before anything is computed or touched if another worktree is based
  // on this one: every sync path below rewrites or moves this branch, which is
  // the base they were created from. Checked first, and unconditionally on
  // ahead/behind, so the outcome never depends on whether the base happened to
  // move — a caller must not learn this constraint only sometimes.
  const dependents = await listDependentWorktrees(projectName, meta.worktreeName);
  if (dependents.length > 0) {
    return dependentsRefusal(worktreeName, dependents, 'syncing');
  }
  const { ahead, behind } = await getWorktreeMergeStatus(system, meta);
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
  // proceed (git rebase refuses a dirty tree).
  const dirty = await worktreeDirtyLines(system, meta.worktreePath);
  if (!dirty.ok) {
    return { ok: false, reason: `git status failed inside worktree '${meta.worktreePath}'` };
  }
  if (dirty.lines.length > 0) {
    return rebaseBlocked(meta, 'commit-required', ahead, behind);
  }
  // Pure-behind + clean tree → fast-forward; no rebase needed.
  if (ahead === 0) {
    const merge = await runGit(system, meta.worktreePath, ['merge', '--ff-only', meta.baseBranch]);
    if (merge.code !== 0) {
      return {
        ok: false,
        reason: (merge.stderr.trim() || merge.stdout.trim() ||
          `git merge --ff-only ${meta.baseBranch} failed inside worktree`),
      };
    }
    const newHead = await runGit(system, meta.worktreePath, ['rev-parse', 'HEAD']);
    return {
      ok: true,
      action: 'fast-forwarded',
      ahead: 0,
      behind: 0,
      newSha: newHead.stdout.trim(),
    };
  }
  // Diverged + clean tree → attempt automatic rebase. On conflict, abort
  // cleanly so the worktree is never left mid-rebase, then report
  // 'rebase-conflict' with the brief the caller may dispatch.
  //
  // --rebase-merges is load-bearing, not a nicety: a worktree that other
  // worktrees merged into carries their merge commits, and a bare `git rebase`
  // FLATTENS those — silently, looking like a clean sync — collapsing the
  // two-level `base <- merge(feature) <- merge(task)` history this exists to
  // produce. It works off the commit graph, not branch names, so it still
  // recreates a merge whose side branch has since been deleted. Keep it in step
  // with buildRebasePrompt below: if only one of the two carries the flag, the
  // conflict path undoes what the automated path preserved.
  const rebase = await runGit(system, meta.worktreePath, ['rebase', '--rebase-merges', meta.baseBranch]);
  if (rebase.code === 0) {
    const newHead = await runGit(system, meta.worktreePath, ['rev-parse', 'HEAD']);
    return {
      ok: true,
      action: 'rebased',
      ahead,
      behind: 0,
      newSha: newHead.stdout.trim(),
    };
  }
  // Abort unconditionally — safe no-op if rebase never started.
  await runGit(system, meta.worktreePath, ['rebase', '--abort']);
  return rebaseBlocked(meta, 'rebase-conflict', ahead, behind);
}

// The prompt text a caller sends to the worktree's agent when git could not land
// the sync itself. Two briefs, because the two blockers need different first
// moves: 'dirty' must commit or discard before it can rebase; 'conflict' has a
// clean tree and only the rebase itself left to do. Neither brief asserts any
// history the sender observed — a dispatch can arrive against a worktree whose
// state has since moved (see the /rebase-prompt route), so the conflict brief
// states the request and the one invariant that always holds (the orchestrator
// aborts a failed rebase, never leaves one half-applied) and tells the agent to
// verify the rest itself. Kept in this module so the on-disk metadata and the
// prompt phrasing stay consistent, and so both briefs keep --rebase-merges in
// step with syncWorktree's own rebase above.
export function buildRebasePrompt(meta: WorktreeMeta, blocker: 'dirty' | 'conflict'): string {
  const rebaseStep = `Run \`git rebase --rebase-merges ${meta.baseBranch}\` inside this worktree so the work sits on top of the parent's current ${meta.baseBranch}. Keep \`--rebase-merges\`: without it any merge commit on this branch is silently flattened.`;
  const steps = blocker === 'dirty'
    ? [
        `This worktree has uncommitted changes, so it cannot be rebased onto ${meta.baseBranch} yet.`,
        ``,
        `Please:`,
        `1. Commit any meaningful uncommitted changes in the worktree (ignore noise).`,
        `2. ${rebaseStep}`,
      ]
    : [
        `This worktree needs to be rebased onto ${meta.baseBranch} by hand, and you are being asked to do it.`,
        `Start with \`git status\`: the tree should be clean with no rebase in progress — the orchestrator aborts a failed rebase rather than leaving one half-applied. If it turns out the branch needs nothing, say so instead of forcing a rebase.`,
        ``,
        `Please:`,
        `1. ${rebaseStep}`,
        `2. Resolve any conflicts as they come up (\`git status\` lists them, \`git rebase --continue\` after each).`,
      ];
  return [
    `You are running in an isolated git worktree.`,
    `Worktree branch: ${meta.branch}`,
    `Originally branched from: ${meta.baseBranch} at ${meta.baseSha.slice(0, 12)}`,
    ``,
    ...steps,
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
  if (!(await isGitRepo(proj.system, proj.path))) {
    return {
      project: projectName, branch: null, commits: [], truncated: false, limit: cap,
      hasUncommitted: false, aheadCount: null, aheadOf: null,
    };
  }
  const head = await runGit(proj.system, proj.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.code === 0 ? (head.stdout.trim() || null) : null;

  // Detect uncommitted changes (staged or unstaged).
  const statusR = await runGit(proj.system, proj.path, ['status', '--porcelain']);
  const hasUncommitted = statusR.code === 0
    ? (statusR.stdout || '').split('\n').some(l => l.trim().length > 0)
    : false;

  // Determine how many leading commits are "ahead" of the base.
  // Try upstream tracking first (normal project with a configured remote).
  // Fall back to worktree base-branch metadata (orchestrator-managed worktrees).
  let aheadCount: number | null = null;
  let aheadOf: string | null = null;
  const upstreamStatus = await getProjectUpstreamStatus(proj.system, proj.path);
  if (upstreamStatus.ahead !== null) {
    aheadCount = upstreamStatus.ahead;
    aheadOf = upstreamStatus.upstream;
  } else {
    const worktreeMeta = await findWorktreeMetaForPath(proj.path);
    if (worktreeMeta) {
      const mergeStatus = await getWorktreeMergeStatus(proj.system, worktreeMeta);
      if (mergeStatus.ahead !== null) {
        aheadCount = mergeStatus.ahead;
        aheadOf = worktreeMeta.baseBranch;
      }
    }
  }

  // Field separator \x1f between fields; %s/%h/%H/%an/%ar/%aI/%P are all single-line.
  // %P = parent SHAs (space-separated): empty for the root commit, ≥2 for a merge.
  const r = await runGit(proj.system, proj.path, [
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

