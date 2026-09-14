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
  projectsRoot, getProject, projectStoreDir, worktreeStoreDir, worktreesStoreRoot, listProjects,
  EXTERNAL_DIRNAME,
  type ProjectInfo,
} from './projects.ts';
import { LOCAL_SYSTEM_ID, isSystemRefusal, projectPlacement, resolveSystem } from './systems/registry.ts';
import {
  transcriptCollisionReason, transcriptCwdCollision,
} from './systems/transcriptKey.ts';
import { classifySpawnError } from './systems/protocol.ts';
import type { System } from './systems/system.ts';

const WORKTREE_META_FILENAME = 'worktree.json';

// THE TARGET IS DELIBERATELY ABSENT. A worktree re-derives its (system,
// remoteId, path) from its parent project on every operation, and storing a
// second copy would be a second thing that can go stale — plus a migration for
// every existing `worktree.json` and a mismatch policy no caller exercises.
//
// What makes re-derivation safe is that the parent's target CANNOT MOVE while a
// worktree registration exists: `writeProjectRecord` is module-private and
// reachable from exactly three exported functions, two of which require the
// name to be free, and the third (setProjectRemote) refuses on
// registeredWorktreeNames. A hand-edited `project.json` bypasses this, which is
// the same trust model the `system` field already has.
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
// OUTPUT IS FENCED, NOT CAPPED, and the difference is the whole design. Every
// caller parses git's output WHOLE — porcelain, numstat, a unified diff — so a
// cap that clipped it would hand back a short parse that reads as the truth. So
// past GIT_OUTPUT_LIMIT_BYTES the command is killed and the call FAILS, with
// whatever arrived first still in `stdout`. Callers need no new branch: a
// non-zero code is what they already handle (a 500 from the diff surfaces, an
// empty history from getProjectCommits).
//
// The fence is not optional. cc is a single process hosting every worker
// session, and git output is unbounded in the ordinary case — a vendored-tree
// deletion, a many-file rename, `status --porcelain` on a huge working tree.
// Measured: 37 MB of output retained a 37 MB string at 248 MB RSS.
export const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

// A SPAWN ERROR IS NOT A GIT RESULT, and shaping it like one is the single
// root cause of an entire family of wrong answers.
//
// A `code: 1` return with the transport diagnostic in `stderr` is byte-for-byte
// the shape of git having RUN and said no. Every caller checks `code !== 0`, so
// "the command never ran" becomes a fact about a repository: `listWorktrees`
// invents a worktree's absence, a merge reports a git-conflict code carrying a
// transport cause, and — worst — safety checks whose FAILURE reads as PASS,
// deleting a worktree whose dirtiness was never measured.
//
// So it THROWS, and the throw is tagged as a system refusal so the structured
// vocabularies (merge, sync, adopt, the listings) can convert it to their own
// named entry. A marker on the result would not do: 57 call sites already treat
// a non-zero code as git's answer, and the default behaviour of an unaudited one
// has to be LOUD, not silently wrong.
//
// This covers the local system too. `system 'local'` in the message is honest —
// a git binary that could not be started is not git saying no there either.
export async function runGit(system: System, cwd: string, args: string[]): Promise<GitResult> {
  const r = await system.exec({ argv: ['git', '-C', cwd, ...args] }, { cwd, maxBufferBytes: GIT_OUTPUT_LIMIT_BYTES });
  // THE SUBCOMMAND, NOT `args[0]`, and shared by BOTH throws below so they
  // cannot drift: the diff argv builders (src/gitDiff.ts) lead with
  // `--literal-pathspecs` and `-c core.quotePath=false`, so `args[0]` renders
  // "git -c did not answer" / "git -c could not be run" and names nothing a
  // reader can act on. First non-option that is not `-c`'s value.
  const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? '';
  // A COMMAND WHOSE ANSWER NEVER ARRIVED IS THE SAME EPISTEMIC STATE AS ONE
  // THAT NEVER RAN, so it takes the same route out — see the spawn-error
  // reasoning directly below rather than a second copy of it here. The concrete
  // falsehood this stops: `isGitRepo` read the `{code:124, stdout:''}` a
  // provider deadline produces as git ANSWERING, so the project list reported
  // `isGitRepo: false` with `systemUnreachable: null` — the positive claim
  // "not a git repo" about a box cc never got an answer from.
  // 504, and its own code: the repair is fix the provider, not fix the path.
  if (r.timedOut) {
    throw httpError(504, `git ${sub} did not answer on system '${system.id}' in ${cwd} `
      + 'before the operation deadline', { code: 'GIT_TIMED_OUT', systemRefusal: true });
  }
  if (r.spawnError) {
    // NOT every spawn failure is a transport failure, and conflating them would
    // launder in the OTHER direction: a missing cwd or a non-executable git is a
    // real, local, actionable fact about THIS command, and reporting it as
    // "the system could not be reached" would send the reader to the wrong
    // machine.
    //
    // But WHICH it is comes from `transportFailure`, set by the wire layer that
    // knows its own code paths — NEVER from the message text. A transport
    // failure's message embeds the dying provider's stderr tail, so classifying
    // it by substring reads the corpse as the diagnosis: a provider that dies of
    // (or merely logs) an errno was taken for the far side answering about a
    // command, and the throw was skipped. That decay compounds, because the tail
    // is then captured into the backoff refusal every later call gets.
    //
    // The command-level branch keeps the previous shape deliberately: the
    // diagnostic in `stderr` names the real cause, callers already surface it,
    // and the safety property still holds because a non-zero code now reads as
    // UNKNOWN at every guard rather than as "passed". `local` does not set
    // `transportFailure` — but this branch turns on the CLASSIFICATION too, and
    // an unclassifiable spawn error therefore throws on `local` as well. The
    // mechanism, not a list: classifySpawnError names the errnos
    // FS_ERROR_CODES tables and answers EUNKNOWN for anything else, and
    // EUNKNOWN fails the second conjunct below. Measured on `local`, each
    // reaching the 502: `spawn git EMFILE` under fd pressure, `spawn
    // ENAMETOOLONG` from an over-long cwd, `spawn E2BIG` from an over-long
    // argv. What is unchanged locally is the CLASSIFIED case — a missing cwd
    // or a non-executable git still returns here, diagnostic in `stderr`.
    if (!r.transportFailure && classifySpawnError(r.spawnError) !== 'EUNKNOWN') {
      return { stdout: r.stdout, stderr: r.stderr || r.spawnError, code: r.code };
    }
    throw httpError(502, `git ${sub} could not be run on system '${system.id}' in ${cwd}: ${r.spawnError}`,
      { code: 'GIT_DID_NOT_RUN', systemRefusal: true });
  }
  return { stdout: r.stdout, stderr: r.stderr, code: r.code };
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
  // Why the hook did not run, when a hook was found: `'disabled'` for the
  // kill-switch, `'STORE_HOOK_LOCAL_ONLY'` for a store-sourced script on a
  // non-local system (see runPostWorktreeHook).
  skipped?: 'disabled' | 'STORE_HOOK_LOCAL_ONLY';
  source?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  timedOut?: boolean;
  // The hook was killed on a system whose provider cannot signal a process
  // GROUP, so only `bash` itself was reached and whatever it started may still
  // be running. This hook is the exact case groupedCommand.ts's header
  // documents — a timed-out `npm ci` in a fresh worktree — and the caller has
  // to know the install may still be going before it uses the worktree.
  descendantsMaySurvive?: true;
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

  // BUCKET 3: A STORE-SOURCED HOOK IS LOCAL-ONLY. The script lives under cc's
  // own store, so running it through the project's system would hand the remote
  // `bash` a path that exists only on THIS machine — an exit-127 wearing the
  // shape of a broken hook at best, and at worst whatever file happens to sit at
  // that spelling on the system running instead. Shipping the body across would
  // need a cc-owned place to put a file on the system, and there is none — a
  // worker reads the project's tree through the union at its real path — so
  // this refusal is the standing answer, not a stopgap. It
  // is reported rather than silently skipped, because a hook that quietly does
  // nothing is the same defect restated. An IN-TREE hook is unaffected — it is
  // already on the system.
  if (source === 'store' && system.id !== LOCAL_SYSTEM_ID) {
    return { ran: false, source, skipped: 'STORE_HOOK_LOCAL_ONLY' };
  }

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
  // THE `CC_*` VARS RIDE IN ARGV, through `env(1)` — the same idiom the derived
  // operations use for `LC_ALL=C`. That ADDS them to the environment of the
  // machine the hook runs on rather than replacing it, which is the whole point:
  // a hook is a build step, so it needs that machine's PATH and toolchain. They
  // are argv entries, not shell words, so a value containing a space or an `=`
  // crosses intact.
  const hookArgv = [
    'env',
    `CC_WORKTREE_PATH=${meta.worktreePath}`,
    `CC_PROJECT_NAME=${meta.parentProject}`,
    `CC_BRANCH=${meta.branch}`,
    `CC_BASE_BRANCH=${meta.baseBranch}`,
    `CC_PARENT_PATH=${meta.parentPath}`,
    'bash', scriptPath,
  ];

  // detached=true (inside the system's exec) puts bash + all its children in
  // their own process group, so a timeout kills the whole tree — a hook running
  // `npm ci` would otherwise leave grandchildren orphaned. This hook keeps its
  // OWN result shaping rather than the shared one: it reports `timedOut` as a
  // flag with a null exitCode instead of the runner's 124 convention, and it
  // prefixes a truncation marker at a clean line boundary.
  const r = await system.exec({ argv: hookArgv }, {
    cwd: meta.worktreePath, timeoutMs, cap: HOOK_OUTPUT_CAP,
  });

  if (r.spawnError) {
    // REPORTS ONLY — deliberately does not classify, and must stay that way.
    // `ran: true` is load-bearing: spawnDialog gates the hook result's
    // visibility on it, so collapsing this into "did not run" would delete a
    // user-visible fallback rather than fix anything. It invents no fact about
    // the tree either; the message is quoted, not interpreted.
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
  if (r.descendantsMaySurvive) result.descendantsMaySurvive = true;
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
    // The base may itself have a base: chains nest to any depth. Two structural
    // facts hold that up, and the obvious "improvements" undo them:
    //   - `baseWorktree` is written at ONE site (the meta literal below), at
    //     creation, naming a record that already exists. Creation order is
    //     therefore a topological order and the graph is a DAG by construction,
    //     which is why no cycle check exists anywhere. A re-parenting API would
    //     end that.
    //   - every dependents guard is scoped to the one branch its operation
    //     rewrites, and exactly one hop of records references that branch, so the
    //     DIRECT child is always the first blocker to fire. The refusal predicate
    //     is depth-independent; only the LIST it hands back walks the subtree.
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
  //
  // THE THIRD BRANCH. A remote project's worktree goes ON THE SYSTEM, beside
  // its tree. Both local answers are paths under cc's own projects root, and
  // either of them here would create the worktree DIRECTORY on this machine
  // while every `runGit` below ran on the system: a split-brain worktree, and a
  // `git worktree add` pointed at a path the repo's machine cannot see.
  //
  // A sibling — not a cc-owned directory like `.external/` — because cc owns no
  // area on another machine to put one in, and inventing one would be a
  // convention the system's owner never agreed to. The dir name already carries
  // the project name, so it is recognisable where it lands.
  const worktreePath = worktreePathFor({ ...proj, system: proj.system.id }, dirName);
  const branch = worktreeBranchName(id);

  // THE TRANSCRIPT DIRECTORY THIS WORKTREE WOULD LAND IN, checked before any
  // git state is touched — the reverse of createProject's order, and the other
  // half of the same pair: a project named `<project>_worktree_<slug>` can
  // already hold it. `dirName`, not `id`: the stored worktreeName is the
  // directory name, and the cwd is built from that.
  const candidate = { project: projectName, worktree: dirName, system: system.id, cwd: worktreePath };
  const keyHit = await transcriptCwdCollision(candidate);
  if (keyHit) {
    throw httpError(
      409,
      transcriptCollisionReason(`worktree '${id}' of project '${projectName}'`, candidate, keyHit),
      { code: 'TRANSCRIPT_DIR_COLLISION' },
    );
  }

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
// STORE-DERIVED, with git as an optional FILTER rather than the source.
//
// A worktree's REGISTRATION is cc's own record, not a git fact, so it must list
// whether or not the system can be reached — which is the contract the listing
// callers' comments already state ("worktree registrations are store-derived and
// need no System, so they still list; only their git-measured divergence goes
// unknown"). Gating the whole enumeration on `isGitRepo` broke that silently: a
// project on a down system showed NO worktrees, and the delete dialog then told
// the user it was about to unregister zero of them while one was registered.
//
// git is still consulted when it can answer, and only to PRUNE: a worktree
// removed outside cc should stop listing. When git cannot answer, no filter is
// applied — every registration lists, which is the honest answer, because the
// registration is exactly what cc knows without asking the system.
export async function listWorktrees(projectName: string): Promise<WorktreeMeta[]> {
  let live: Set<string> | null = null;
  try {
    const proj = await getProject(projectName);
    if (await isGitRepo(proj.system, proj.path)) {
      const r = await runGit(proj.system, proj.path, ['worktree', 'list', '--porcelain']);
      if (r.code === 0) {
        live = new Set(
          r.stdout.split('\n')
            .filter(l => l.startsWith('worktree '))
            .map(l => path.basename(l.slice('worktree '.length))),
        );
      }
    }
  } catch (e) {
    // Only a system refusal degrades to "no filter". Anything else is a real
    // fault and must not be swallowed into a silently unfiltered listing.
    if (!isSystemRefusal(e)) throw e;
  }

  const out: WorktreeMeta[] = [];
  for (const dirName of await registeredWorktreeNames(projectName)) {
    if (live && !live.has(dirName)) continue;
    const meta = await readMeta(projectName, dirName).catch(() => null);
    if (meta && meta.parentProject === projectName) out.push(meta);
  }
  out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return out;
}

// The worktree names REGISTERED under this project, read from cc's own store
// and nothing else.
//
// Different from listWorktrees in the way that matters to a GUARD: it neither
// reaches the system nor filters by what git currently reports, so no caller,
// and no system being down, can change its answer. A registration is what makes
// a worktree re-derive its target from the parent project — so a registration
// is what has to be gone before that target may move (setProjectRemote).
// WHERE A WORKTREE'S DIRECTORY GOES, in one place. `createWorktree` creates it
// here and the transcript-collision guard derives every registered worktree's
// cwd with the same call, so the guard cannot disagree with the thing it
// guards. A placed project's worktrees sit beside it on ITS machine; a local
// project's sit in cc's projects root, under `.external/` when the project is.
export function worktreePathFor(
  proj: { path: string; system: string; external?: boolean }, dirName: string,
): string {
  return path.join(
    proj.system !== LOCAL_SYSTEM_ID
      ? path.dirname(proj.path)
      : proj.external ? path.join(projectsRoot(), EXTERNAL_DIRNAME) : projectsRoot(),
    dirName,
  );
}

export async function registeredWorktreeNames(projectName: string): Promise<string[]> {
  try {
    return (await fs.readdir(worktreesStoreRoot(projectName), { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

export async function getWorktree(projectName: string, worktreeName: string): Promise<WorktreeMeta | null> {
  const all = await listWorktrees(projectName);
  const name = resolveWorktreeName(projectName, worktreeName, all.map(w => w.worktreeName));
  return all.find(w => w.worktreeName === name) ?? null;
}

// Every worktree that descends from this one — the whole subtree, DEEPEST FIRST.
// The predicate is over worktree RECORDS, not live instances: killing a worker is
// not enough — a surviving child whose base sha was rewritten under it is
// genuinely broken, so the worktree must actually be deleted before its base is
// allowed to move.
//
// TRANSITIVE FOR THE MESSAGE, NOT FOR THE GATE. The walk permits and refuses
// nothing new: a subtree is empty exactly when the direct-child set is, so every
// guard built on this fires on precisely the records it fired on before, at any
// depth. What it buys is the design value the gate was built for — naming the
// real blocker on the first call. Direct children alone, `sync(A)` on A -> B -> C
// answers "delete B"; the caller obeys and the delete of B is refused for C.
// Deepest first because that is the order they have to go in.
//
// Bounded like agentTreeBackends (src/instances.ts): downward-only over one
// already-loaded listWorktrees array, each record visited at most once. `seen`
// costs nothing and terminates a hand-edited cycle that createWorktree cannot
// produce.
//
// What is guaranteed is the order ACROSS levels — deeper before shallower, which
// is what makes the list a delete order. Sibling order WITHIN a level is simply
// listWorktrees's (`createdAt`, readdir order on an equal timestamp) and is NOT
// guaranteed: siblings are independent, so any order of them deletes cleanly.
export async function listDependentWorktrees(projectName: string, worktreeName: string): Promise<string[]> {
  const all = await listWorktrees(projectName);
  // Alias here too, not just at getWorktree: the foreign key is matched
  // literally below, so a bare slug would silently return [] and bypass every
  // dependents refusal built on it.
  const root = resolveWorktreeName(projectName, worktreeName, all.map(w => w.worktreeName)) ?? worktreeName;
  const seen = new Set<string>([root]);
  const levels: string[][] = [];
  let frontier = new Set<string>([root]);
  while (frontier.size > 0) {
    const next: string[] = [];
    for (const w of all) {
      if (seen.has(w.worktreeName)) continue;
      if (w.baseWorktree === undefined || !frontier.has(w.baseWorktree)) continue;
      seen.add(w.worktreeName);
      next.push(w.worktreeName);
    }
    if (next.length > 0) levels.push(next);
    frontier = new Set(next);
  }
  return levels.reverse().flat();
}

// The shared refusal for "this worktree is somebody's base". Minted once here
// rather than per surface: unlike WORKTREE_BEHIND (where the REST user clicks
// Sync and the conductor calls sync_worktree), both audiences act identically —
// delete the subtree, deepest first — so the wording names no button and no
// tool, and it hands back `dependents` in the order they must go. `verb`
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
    ? 'deleting it would delete the branch its children are based on'
    : `${verb} it would rewrite the base its children were created from`;
  return {
    ok: false,
    code: 'WORKTREE_HAS_DEPENDENTS',
    dependents,
    reason: `worktree '${worktreeName}' is the base for ${dependents.length} other worktree(s), ` +
      `directly or further down the chain, and ${consequence}. ` +
      `Delete them first, in this order: ${dependents.join(', ')} ` +
      `(killing their workers is not enough).`,
  };
}

// Remove a worktree: deregister it via git and drop the directory, drop the
// central-store entry, then delete the branch. We refuse if the working
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
    // A check that FAILED is not a check that passed. This read `dirty.ok &&
    // …`, so a `git status` that never answered fell through to
    // `git worktree remove --force`, deleting a tree whose dirtiness had never
    // been measured. Unknown refuses; force is still the deliberate override.
    if (!dirty.ok) {
      throw httpError(
        409,
        `could not check whether worktree '${worktreeName}' has uncommitted changes on system `
        + `'${system.id}' — refusing rather than deleting a worktree cc has not measured; `
        + `pass force=true to delete it anyway`,
      );
    }
    if (dirty.lines.length > 0) {
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
  // THE REGISTRATION GOES HERE, NOT AFTER THE BRANCH DELETE, because the step
  // below can THROW: runGit raises a system refusal when git could not be run
  // or never answered, on `local` as well as over a provider. Written last, that
  // throw left cc's record of a worktree git had already forgotten — and the two
  // listings then disagreed, because listWorktrees prunes by `git worktree list`
  // and stopped showing it while registeredWorktreeNames still counted it, so
  // setProjectRemote refused 409 naming a worktree no listing displayed
  // (measured). Ordered here, no git step after the removal decides whether
  // cc's record survives.
  //
  // THE BOUND ON THAT GUARANTEE IS STATED HERE AND CROSS-REFERENCED ELSEWHERE,
  // because this is where it is readable beside the helper it is about:
  // dropWorktreeStoreEntry swallows its own `fs.rm` failure, so a failing local
  // store write still strands the registration, silently and with nothing
  // raised. Pre-existing, a different mechanism, and unchanged here — the
  // ordering buys the GIT steps and nothing further.
  await dropWorktreeStoreEntry(projectName, meta.worktreeName);
  // Branch deletion is best-effort — if the rebase-back already
  // fast-forwarded the base onto the worktree branch then `-d` will
  // succeed; otherwise the branch may be ahead and we use `-D`.
  //
  // Best-effort means GIT'S NO is tolerated: the exit code stays unread. It does
  // not extend to a system refusal — "git could not be run on this box" is a
  // real diagnosis about a real machine, and hiding it would report a transport
  // failure as a clean removal. So the refusal is re-raised, ANNOTATED: the
  // removal above already succeeded, and the bare refusal reads as a delete that
  // failed. statusCode / code / systemRefusal are carried through, so both
  // surfaces map it as they did.
  //
  // THE MESSAGE ASSERTS ONLY WHAT THIS CODE MEASURED, which is `rm.code`,
  // tested above. Two claims it deliberately does NOT make. The store-entry drop
  // ran first but reports nothing back (bound stated above), so "unregistered"
  // would be a claim cc did not measure, false in exactly the case that bound
  // describes. And the branch's fate is not known either: GIT_DID_NOT_RUN means
  // the delete never started, but GIT_TIMED_OUT means the ANSWER never arrived
  // and the far side may have deleted it — the same uncertainty
  // mergeWorktreeIntoParent reports as `mayHaveCompleted`. So the branch clause
  // is hedged, and it is still the actionable half: go look.
  const delArgs = ['branch', force ? '-D' : '-d', meta.branch];
  try {
    await runGit(system, parentPath, delArgs);
  } catch (e) {
    if (!isSystemRefusal(e)) throw e;
    const refusal = e as Error & { statusCode?: number; code?: string };
    throw httpError(
      refusal.statusCode ?? 502,
      `worktree '${meta.worktreeName}' was removed, but its branch `
      + `'${meta.branch}' may still exist: ${refusal.message}`,
      { code: refusal.code, systemRefusal: true },
    );
  }
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
  // THE WHOLE BODY sits inside this try, not just the prelude.
  //
  // The prelude-only version caught a system that was unreachable AT ENTRY —
  // the case that already worked — and left every step after it laundering a
  // dead transport into a git answer. Callers here are promised a RETURNED
  // refusal carrying a code they render; a throw would surface as a 500 with
  // nothing to act on.
  //
  // `mergeStarted` is the uncertainty this function owes its caller. The design
  // assumed git's steps are individually atomic, and for `git merge` THAT IS
  // FALSE: killed mid-merge, the orphaned command was observed completing the
  // merge commit AFTER cc had already reported failure, leaving the parent's
  // HEAD moved, MERGE_HEAD set, and the worktree branch never fast-forwarded. So
  // once step 6 is issued, a refusal must say the merge MAY have landed — the
  // same rule as descendantsMaySurvive, applied to a merge.
  let mergeStarted = false;
  try {
    return await runMerge();
  } catch (e) {
    if (!isSystemRefusal(e)) throw e;
    return {
      ok: false,
      code: 'SYSTEM_UNREACHABLE',
      reason: (e as Error).message + (mergeStarted
        ? ' — the merge had already been started on the system, so it MAY have completed there; '
          + 'check the parent repo before retrying'
        : ''),
      ...(mergeStarted ? { mayHaveCompleted: true as const } : {}),
    };
  }

  async function runMerge(): Promise<MergeSuccess | MergeFailure> {
  const meta = await getWorktree(projectName, worktreeName);
  const system = await resolveSystem(projectName);
  if (!meta) {
    throw httpError(404, `worktree '${worktreeName}' not found under project '${projectName}'`);
  }
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
  // A parent left MID-MERGE reads as dirty to `status`, and "commit or stash
  // them" is a repair that does not apply to it — so it is checked first and
  // named for what it is. This is the state a merge killed mid-flight leaves
  // behind, which is exactly when a caller most needs the right instruction.
  const midMerge = await runGit(system, meta.parentPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  if (midMerge.code === 0) {
    return {
      ok: false,
      code: 'PARENT_MID_MERGE',
      reason: `parent repo is in the middle of a merge (MERGE_HEAD is set) — finish it with 'git commit', `
        + `or abandon it with 'git merge --abort', before merging again`,
    };
  }
  const dirty = await runGit(system, meta.parentPath, ['status', '--porcelain']);
  // A status that FAILED is not a clean one. Skipping the guard on a non-zero
  // code merged into a tree whose state had never been read.
  if (dirty.code !== 0) {
    return {
      ok: false,
      code: 'PARENT_STATUS_UNKNOWN',
      reason: `could not read the parent repo's working-tree state (git status exited ${dirty.code}: `
        + `${dirty.stderr.trim() || 'no output'}) — refusing rather than merging into a tree cc has not measured`,
    };
  }
  if (dirty.stdout.trim().length > 0) {
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
    // The fifth member of the same class as removeWorktree's gate, the MCP
    // delete precheck and PARENT_STATUS_UNKNOWN: a check that FAILED is not a
    // check that passed. Reading `wtDirty.ok && …` merged anyway on an
    // unreadable tree, silently not landing the uncommitted work this step
    // exists to protect. `allowDirty:true` is still the deliberate override.
    if (!wtDirty.ok) {
      return {
        ok: false,
        code: 'WORKTREE_STATUS_UNKNOWN',
        reason: `could not read the worktree's own working-tree state — refusing rather than merging `
          + `while uncommitted work there might be silently left behind; pass allowDirty:true to merge anyway`,
      };
    }
    if (wtDirty.lines.length > 0) {
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
  // PAST THIS LINE cc can no longer be sure nothing happened (see the header).
  mergeStarted = true;
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
  // Same rule as the merge: callers are promised a RETURNED refusal carrying a
  // reason they render. A dead transport that nulls out ahead/behind is
  // reported here as "base branch may have been deleted or renamed" — a repair
  // aimed at a branch cc never managed to ask about.
  try {
    return await runSync();
  } catch (e) {
    if (!isSystemRefusal(e)) throw e;
    return { ok: false, reason: (e as Error).message };
  }

  async function runSync(): Promise<SyncResult> {
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
  // nested `base <- merge <- merge <- …` history this exists to produce, however
  // deep the chain runs. It works off the commit graph, not branch names, so it
  // still recreates a merge whose side branch has since been deleted. Keep it in step
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
  // D11 REACHES THE CASCADE. Deleting a project on a non-local system
  // unregisters it and never touches the tree — and `git worktree remove
  // --force` plus `git branch -D` are exactly touching it: they delete a
  // checkout and a branch inside the user's own repo, on their own machine.
  // So here the registrations go and the directories and branches stay, for the
  // same reason the project's own tree does.
  //
  // Deleting ONE worktree deliberately still removes it (removeWorktree,
  // unchanged): cc created that directory, and the user asked for that
  // directory. This is the whole-project cascade, where the user asked to stop
  // tracking a project — not to delete work on another machine.
  const { system } = await projectPlacement(projectName);
  const unregisterOnly = system !== LOCAL_SYSTEM_ID;
  for (const wt of known) {
    try {
      if (unregisterOnly) await dropWorktreeStoreEntry(projectName, wt.worktreeName);
      else await removeWorktree(projectName, wt.worktreeName, { force: true });
    } catch { /* ignore */ }
  }
}

// The central-store entry for one worktree (metadata + attachments + debug).
// cc's own, always local.
async function dropWorktreeStoreEntry(projectName: string, worktreeName: string): Promise<void> {
  try { await fs.rm(worktreeStoreDir(projectName, worktreeName), { recursive: true, force: true }); }
  catch { /* best-effort */ }
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
  // Reachable from HEAD but not from `aheadOf` — i.e. this exact commit is part
  // of what `aheadCount` counts. Always false when `aheadOf` is null (no base,
  // so nothing is claimed about any commit). NOT derivable from the row's
  // position: see the aheadSet comment in getProjectCommits.
  ahead: boolean;
}

// Return the commit history of a project's current branch (HEAD), newest first, in
// TOPOLOGICAL order (a parent never precedes any of its children).
// Validates the project via getProject (throws 404 if not found). Caps the log
// at `limit` (default `COMMITS_DEFAULT_LIMIT`, max `COMMITS_MAX_LIMIT`) and sets `truncated` when more commits exist.
// Returns { project, branch, commits, truncated, limit, hasUncommitted, aheadCount, aheadOf },
// where each commit is { sha, shortSha, subject, author, relativeDate, isoDate, parents },
// and `parents` is the array of parent SHAs (empty for the root, ≥2 for a merge) — the
// frontend uses it to compute the branch/merge graph lanes.
// hasUncommitted: true when `git status --porcelain` is non-empty, undefined
// (with uncommittedUnknown:true) when that status did not answer.
// aheadCount/aheadOf: how many commits are ahead of the base (upstream or
// worktree base branch), or null when unknown/not applicable; each commit's own
// `ahead` says whether IT is one of them.
export async function getProjectCommits(
  projectName: string,
  { limit = COMMITS_DEFAULT_LIMIT }: { limit?: number } = {},
): Promise<{
  project: string;
  branch: string | null;
  commits: CommitRow[];
  truncated: boolean;
  limit: number;
  // `undefined` when `git status` did not answer — absent rather than `false`,
  // because "no uncommitted changes" is a positive claim about the tree.
  // `uncommittedUnknown` is set in exactly that case, so a consumer that only
  // checks truthiness is not silently told the tree is clean.
  hasUncommitted: boolean | undefined;
  uncommittedUnknown?: true;
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

  // Detect uncommitted changes (staged or unstaged). A status that did NOT
  // answer is reported as unknown rather than as `false`: "no uncommitted
  // changes" is a positive claim about the tree, and the realistic trigger is
  // runGit's own output fence firing on a pathological working tree — precisely
  // the tree least safe to describe as clean.
  const statusR = await runGit(proj.system, proj.path, ['status', '--porcelain']);
  const hasUncommitted = statusR.code === 0
    ? (statusR.stdout || '').split('\n').some(l => l.trim().length > 0)
    : undefined;

  // Determine how many commits are "ahead" of the base (not how many LEADING
  // commits: the ahead set is not a contiguous prefix of the log — see below).
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

  // WHICH commits are ahead, not just how many. The set is NOT a prefix of the
  // log: --topo-order fixes only parents-after-children, and among commits that
  // are neither ancestor nor descendant of one another git falls back to
  // committer date — so merging a moved-on base back into your branch
  // interleaves already-merged commits among ahead ones. The executable record
  // of that shape is `makeNonPrefixWorktree` in tests/project-commits.test.mjs:
  // it emits M, m2, w2, w1, m1 with {M, w2, w1} ahead — re-run it rather than
  // trusting this sentence.
  //
  // Resolved from `aheadOf` itself, the ref the count above was measured
  // against, so both answer about the same BASE. They also answer about the
  // same TIP wherever HEAD is the ref the count was measured for: on the
  // upstream path by construction (the count compares the checked-out branch to
  // its own upstream), but on the worktree path the count is measured off the
  // recorded branch ref while this set is measured off HEAD — so a detached
  // HEAD inside a worktree can make the two disagree. That mismatch predates
  // the per-commit flag and is left alone here; the flags are the more truthful
  // half of it.
  //
  // aheadCount counts the WHOLE ahead set, which can exceed the window, so the
  // flags count out to aheadCount only when `truncated` is false.
  //
  // No base (aheadOf === null) means nothing is claimed: every row false.
  const aheadSet = new Set<string>();
  if (aheadOf) {
    const rl = await runGit(proj.system, proj.path, ['rev-list', 'HEAD', `^${aheadOf}`]);
    if (rl.code === 0) {
      for (const line of rl.stdout.split('\n')) {
        const sha = line.trim();
        if (sha) aheadSet.add(sha);
      }
    } else {
      // The base answered for the count but not for the set; reporting one
      // without the other would let the two disagree. Claim neither.
      aheadCount = null;
      aheadOf = null;
    }
  }

  // Field separator \x1f between fields; %s/%h/%H/%an/%ar/%aI/%P are all single-line.
  // %P = parent SHAs (space-separated): empty for the root commit, ≥2 for a merge.
  // --topo-order, not git's default committer-date order: the frontend's lane
  // assignment (computeGraph, public/commits.js) requires that no parent precede
  // its child. A rebase stamps a whole branch with one committer second, the date
  // sort key goes constant, and the emitted order degenerates — branch points
  // then attach to the wrong rows, and lanes end abruptly where the rail gives
  // up on a parent already drawn above (computeGraph's `seen` guard).
  const r = await runGit(proj.system, proj.path, [
    'log', '--topo-order', `--max-count=${cap + 1}`,
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%aI%x1f%P',
  ]);
  if (r.code !== 0) {
    // `git log` exits non-zero for TWO unrelated reasons, and only ONE of them
    // is legitimately an empty history: a repo with no commits yet. The other is
    // git not answering — and rendering that as "this repo has no commits" is
    // the same read-side defect as an unreadable status rendering as clean.
    //
    // The discriminator is asked ONLY on this failure path, so the normal case
    // pays nothing for it.
    if (!(await hasUnbornHead(proj.system, proj.path))) {
      throw httpError(502, `could not read the commit history of '${projectName}' on system `
        + `'${proj.system.id}': git log exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''}`);
    }
    return {
      project: projectName, branch, commits: [], truncated: false, limit: cap,
      hasUncommitted, ...(hasUncommitted === undefined ? { uncommittedUnknown: true as const } : {}),
      aheadCount, aheadOf,
    };
  }
  const rows = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, shortSha, subject, author, relativeDate, isoDate, parentField] = line.split('\x1f');
    const parents = parentField ? parentField.trim().split(' ').filter(Boolean) : [];
    return {
      sha: sha ?? '', shortSha: shortSha ?? '', subject: subject ?? '',
      author: author ?? '', relativeDate: relativeDate ?? '', isoDate: isoDate ?? '',
      parents, ahead: aheadSet.has(sha ?? ''),
    };
  });
  const truncated = rows.length > cap;
  const commits = truncated ? rows.slice(0, cap) : rows;
  return {
    project: projectName, branch, commits, truncated, limit: cap,
    hasUncommitted, ...(hasUncommitted === undefined ? { uncommittedUnknown: true as const } : {}),
    aheadCount, aheadOf,
  };
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

