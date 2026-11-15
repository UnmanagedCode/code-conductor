// Project lifecycle: create, adopt, retarget (setProjectRemote) and delete.
// src/projects.ts imports it and re-exports its public names, so it must never
// import src/projects.ts — nor, statically, worktrees.ts or projectClaudeMd.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { httpError } from './httpError.ts';
import { markProjectsChanged, projectsOperation } from './projectsChanged.ts';
import { forgetWorktreeLandings } from './worktreeLandings.ts';
import { projectsRoot, orchStoreRoot, projectStoreDir, localWorktreesRoot, pluginsRoot } from './storeRoot.ts';
import {
  NAME_RE, validateName, readProjectRecord,
  type ProjectLocation, type ProjectRecord,
} from './projectRecord.ts';
import {
  heldNameReason, listProjects, projectKeyCollisionReason, registerProject, writeProjectRecord,
} from './projectRegistry.ts';
import { LOCAL_SYSTEM_ID, localSystem, placementOf, systemById } from './systems/registry.ts';
import { REMOTE_ID_MAX, remoteIdDefect } from './systems/protocol.ts';
import type { System } from './systems/system.ts';
import { samePath } from './platform/index.ts';
import { errCode, errMsg } from '../shared/basics.ts';

// One `projects` signal once the project is whole: record, repository and seed files.
export function createProject(...args: Parameters<typeof createProjectSteps>) {
  return projectsOperation(() => createProjectSteps(...args));
}

async function createProjectSteps(
  name: string,
  { conventionsDoc = null, system: systemId = null, remoteId = null, systemPath = null }: {
    conventionsDoc?: string | null;
    // The system to place the project on, and the path on it. Both or neither:
    // a system with no path is not a placement, and a path with no system is a
    // path on the wrong machine. Omitting them creates an in-root local project,
    // which is what every existing caller does. Typed `unknown` because they
    // arrive from a request body; validatePlacementInput is what narrows them.
    system?: unknown;
    // WHICH TARGET of that system, when it serves more than one. Optional even
    // with a system: absence means the provider's own default target.
    remoteId?: unknown;
    systemPath?: unknown;
  } = {},
): Promise<{ name: string; path: string; system: string; remoteId: string | null; gitSkipped?: string }> {
  validateName(name);
  const placement = validatePlacementInput(systemId, remoteId, systemPath);
  // THE THIRD BRANCH. On a non-local system the mkdir, `git init` and the seed
  // files below all happen ON THE SYSTEM at the caller's path, rather than under
  // the local projects root — and the record, not a directory here, is what
  // registers the project.
  const system = placement
    ? await systemById(placement.system, placement.remoteId, `project '${name}'`)
    : localSystem();
  const full = placement ? placement.systemPath : path.join(projectsRoot(), name);
  // The RECORD, not the mkdir alone: a project registered ANYWHERE holds the
  // name, and a tree outside the root is invisible to this mkdir — two records
  // for one name would share one store entry and one encoded session dir. The
  // EEXIST branch below stays as the race backstop.
  if (await heldNameReason(name)) {
    throw httpError(409, `project '${name}' already exists`);
  }
  // A name is free and still unusable when the CLI's TRANSCRIPT DIRECTORY for
  // its working directory is already taken — by any place, on any system. Not
  // placement-only any more: a remote cwd is now the project's real path on its
  // system rather than something under cc's store, so it can collide with a
  // local project's path.
  {
    const why = await projectKeyCollisionReason(
      placement?.system ?? LOCAL_SYSTEM_ID, placement?.remoteId ?? null, name, full);
    if (why) throw httpError(409, why, { code: 'TRANSCRIPT_DIR_COLLISION' });
  }
  // The projects root may not exist yet on a cold start, and `mkdir` below is
  // deliberately non-recursive — EEXIST is what proves the tree was not already
  // somebody else's. Only for a LOCAL create: cc does not invent directories on
  // another machine.
  if (!placement) await fs.mkdir(projectsRoot(), { recursive: true });
  try {
    await system.mkdir(full);
  } catch (e) {
    if (errCode(e) === 'EEXIST') {
      throw httpError(409, placement
        ? `'${full}' already exists on ${describePlacement(placement)}`
        : `project '${name}' already exists`);
    }
    // A failure caused by a REMOTE machine has to name that machine. A raw
    // SystemError carries no statusCode, so this surfaced as a bare 500 reading
    // `mkdir '<path>': provider exited` — which a reader takes for cc's own
    // mkdir failing on cc's own disk. adoptProject's twin already answers "on
    // system 's'"; this is the same sentence for the create path. A LOCAL create
    // is left alone: there is no other machine to name.
    if (placement) {
      throw httpError(502, `could not create '${full}' on ${describePlacement(placement)}: ${errMsg(e)}`);
    }
    throw e;
  }
  // Registered only once the directory is ours: the mkdir above is what proves
  // the path was not already someone else's tree, and a record written ahead of
  // it would adopt whatever was there on a refusal. BOTH branches register now —
  // there is no in-root directory that registers a project by existing.
  await registerProject(name, placement
    ? { kind: 'remote', system: placement.system, remoteId: placement.remoteId, path: placement.systemPath }
    : { kind: 'local', path: full });
  // A repo from birth when git can make one — worktrees, diffs and commits are
  // the whole workflow — and otherwise an ordinary non-git project, the same as
  // an adopted plain directory. The mkdir above proves the dir is brand new, so
  // there is nothing to clobber and no repo check to make: isGitRepo() walks UP,
  // so it would answer "yes" for this empty dir whenever the projects root
  // itself sits inside a repo, and skip the init. Dynamic import because
  // worktrees.ts statically imports this module (as with listWorktrees below).
  //
  // NOT FATAL, and the failure is reported rather than thrown: by now the dir
  // and the record exist, so a 500 here would leave a half-created project whose
  // retry is a 409. The try wraps the CALL, not just `code`: runGit throws
  // httpError(504 GIT_TIMED_OUT) / httpError(502 GIT_DID_NOT_RUN) before it
  // returns a result — a timed-out init may even have run on the far side, so
  // the reason for that shape is the throw's own text.
  const { runGit } = await import('./worktrees.ts');
  let gitSkipped: string | undefined;
  try {
    const init = await runGit(system, full, ['init', '-q']);
    if (init.code !== 0) {
      gitSkipped = `git init failed in ${full}: ${init.stderr.trim() || init.stdout.trim()}`;
    }
  } catch (e) {
    gitSkipped = errMsg(e);
  }
  if (gitSkipped !== undefined) {
    gitSkipped += ' — the project was created without a repository; its first worktree needs '
      + '`git init` and a commit first';
    console.warn(`createProject: ${gitSkipped}`);
  }
  // Seed a CLAUDE.md importing the in-project CONVENTIONS.md — the sole channel
  // for both workspace and project conventions, so it is unconditional and
  // travels with the tree wherever the project is mounted. The caller passes the
  // composed document (no circular dep on projectConventions here); that file is
  // app-owned + regenerated later (src/projectClaudeMd.ts), which also re-ensures
  // this import line, so a caller that passes none still converges.
  const importLine = '@CONVENTIONS.md\n';
  const claudeMdPath = path.join(full, 'CLAUDE.md');
  // Collected as the files are written, and handed to commitScaffold so the
  // commit is guaranteed to hold them whatever the user's ignore rules say.
  // Appended at each write site rather than declared as a list up front: a
  // literal list is a second source of truth for what creation wrote, and it
  // would go stale silently.
  const scaffolded: string[] = ['CLAUDE.md'];
  try {
    await system.writeFile(claudeMdPath, importLine, { exclusive: true });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  if (conventionsDoc != null) {
    await system.writeFile(path.join(full, 'CONVENTIONS.md'), conventionsDoc);
    scaffolded.push('CONVENTIONS.md');
  }
  if (gitSkipped === undefined) await commitScaffold(system, full, runGit, scaffolded);
  return {
    name, path: full, system: system.id, remoteId: system.remoteId,
    // Present only when skipped — its presence is the signal.
    ...(gitSkipped === undefined ? {} : { gitSkipped }),
  };
}

// The identity a scaffold commit falls back to when the repo has none of its
// own. The email is under RFC 2606's reserved `.invalid` TLD, so it is
// unroutable by construction and can never be mistaken for a real mailbox.
// Not exported: tests assert the literals a user reads in `git log`, which an
// imported constant would not pin.
const SCAFFOLD_AUTHOR_NAME = 'code-conductor';
const SCAFFOLD_AUTHOR_EMAIL = 'code-conductor@invalid';

// Subject reads correctly in `git log --oneline`; the body names the tool so an
// unfamiliar author in the history is self-explaining. It does NOT enumerate the
// files — `git show` already does, and a list would go stale the moment the
// scaffold set changes.
const SCAFFOLD_COMMIT_MESSAGE =
  'Initial commit\n\nScaffolded by code-conductor when the project was created.\n';

// Close creation with a commit of exactly what creation wrote, so a brand-new
// project is worktree-ready immediately (worktrees branch off HEAD, and
// createWorktree refuses an unborn one).
//
// NON-FATAL BY DESIGN. By the time this runs the directory, the store record,
// the repo and every seed file exist and are correct, so throwing would surface
// a 500 over a project that is already fully on disk — the half-created state
// this ordering exists to avoid. The observable for "no commit" already exists
// and needs no second channel: `unbornHead` on the project listings.
// `deliverAdoptedConventions` warns-and-continues for the same reason.
//
// `runGit` is passed in rather than imported: worktrees.ts statically imports
// this module, so createProject reaches it through a dynamic import and there is
// no reason for a second one here. `scaffolded` is the project-relative path of
// every file creation actually wrote.
async function commitScaffold(
  system: System, full: string, runGit: typeof import('./worktrees.ts').runGit,
  scaffolded: string[],
): Promise<void> {
  // The try must wrap the CALLS, not just their `code`: runGit throws
  // httpError(504 GIT_TIMED_OUT) / httpError(502 GIT_DID_NOT_RUN) before it
  // ever returns a result.
  try {
    // COMMIT ONLY TO THE REPO CREATION JUST MADE, and establish that BEFORE
    // anything is staged. An ambient `GIT_DIR` can send the `git init` above to
    // a foreign repo that accepts it (a pre-existing dent, pinned by
    // tests/project-initial-commit-foreign-repo.test.mjs), and without this check the staging
    // below then writes a commit into somebody else's history: measured, the
    // stray "Initial commit" lands on their branch carrying a tree that DELETES
    // every file they had tracked. Misplacing a repo is recoverable; rewriting
    // a user's branch is a different class of harm, so the identity of the
    // target is a precondition rather than something to notice afterwards.
    //
    // Both halves matter and both come from one command: the git dir says WHICH
    // repository the commit would land in, the top level says which working
    // tree `add -A` would sweep. git resolves symlinks in both answers, so the
    // comparison is against the realpath — `full` itself can differ by a
    // symlinked ancestor and would then mismatch for no real reason.
    const real = await system.realpath(full);
    const where = await runGit(system, full, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
    const [gitDir, topLevel] = where.stdout.trim().split('\n');
    if (where.code !== 0 || !samePath(gitDir, path.join(real, '.git')) || !samePath(topLevel, real)) {
      console.warn(`createProject: refusing the initial commit in ${full} — git resolves that `
        + `directory to a different repository (git dir '${gitDir ?? ''}', work tree `
        + `'${topLevel ?? ''}'), and committing there would write into history that is not this `
        + 'project\'s; the project was created and its HEAD is unborn, so its first worktree needs '
        + 'a commit first');
      return;
    }
    // PER FIELD, and probed rather than defaulted: git has no "use this only if
    // unset" config precedence — `-c` always wins — so the only way to leave a
    // configured identity alone is to ask first. This is the user's repo and
    // their history; overriding a name they set would be gratuitous.
    const idArgs: string[] = [];
    const name = await runGit(system, full, ['config', '--get', 'user.name']);
    if (name.code !== 0 || !name.stdout.trim()) {
      idArgs.push('-c', `user.name=${SCAFFOLD_AUTHOR_NAME}`);
    }
    const email = await runGit(system, full, ['config', '--get', 'user.email']);
    if (email.code !== 0 || !email.stdout.trim()) {
      idArgs.push('-c', `user.email=${SCAFFOLD_AUTHOR_EMAIL}`);
    }
    // `add -A` with NO PATHSPEC keeps the commit forwards-compatible with
    // whatever a future scaffold writes — but it HONOURS the user's
    // `core.excludesFile`, so on its own a global ignore listing `CLAUDE.md`
    // (a real habit) would silently drop it, and a worktree branched off that
    // HEAD would check out no CLAUDE.md and lose the `@CONVENTIONS.md` import
    // chain for every worker. Hence the second, forced add of exactly the paths
    // creation wrote: `-A` decides the SCOPE, `-f` guarantees the FLOOR.
    //
    // `-c` PAIRS IN THE ARGV, never a persisted config and never an env frame:
    // the fallback is this one command's and must outlive nothing. (A frame
    // `env` REPLACES the far side's environment — see providerSystem.ts — and
    // runGit takes no env parameter anyway. src/gitDiff.ts is the precedent for
    // leading `-c` in a runGit argv, and runGit's `sub` extraction already skips
    // them, so a refusal still names `commit`.)
    //
    // No `--no-verify` and no gpgsign override: a user's hooks and signing key
    // are theirs, and a failure from one degrades below like any other.
    const steps: string[][] = [
      ['add', '-A'],
      ['add', '-f', '--', ...scaffolded],
      [...idArgs, 'commit', '-q', '-m', SCAFFOLD_COMMIT_MESSAGE],
    ];
    for (const argv of steps) {
      const r = await runGit(system, full, argv);
      // Rethrown into this function's own catch, so every failure — a non-zero
      // git and a runGit throw alike — leaves by one route and warns once.
      if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
    }
  } catch (e) {
    console.warn(`createProject: initial commit failed in ${full} — the project was created and its `
      + 'HEAD is unborn, so its first worktree needs a commit first: ' + errMsg(e));
  }
}

// The (system, remoteId, systemPath) triple a creation path was given, or null
// for a local project. Shared by createProject and adoptProject so the two
// cannot drift on what a placement means.
//
// The path is required to be ABSOLUTE because a relative one would be resolved
// against whatever working directory the provider process happens to have —
// which is not a property of the system, and not one the caller can see.
function validatePlacementInput(
  systemId: unknown, remoteId: unknown, systemPath: unknown,
): { system: string; remoteId: string | null; systemPath: string } | null {
  const id = typeof systemId === 'string' ? systemId.trim() : '';
  const p = typeof systemPath === 'string' ? systemPath.trim() : '';
  const remote = validateRemoteId(remoteId);
  if (!id || id === LOCAL_SYSTEM_ID) {
    if (p) throw httpError(400, `systemPath '${p}' was given without a system — a path with no system is a path on cc's own machine, which is what omitting both already means`);
    if (remote) throw httpError(400, `remoteId '${remote}' was given without a system — cc's own machine is one machine, so it has no named targets`);
    return null;
  }
  if (!p) throw httpError(400, `system '${id}' was named without a systemPath — cc has no default location on another machine`);
  if (!path.isAbsolute(p)) throw httpError(400, `systemPath must be absolute (got '${p}')`);
  // NORMALISED, NOT MERELY TRIMMED, and this is a correctness fix rather than
  // tidiness. The value is stored verbatim and is the candidate the transcript
  // guard compares, so `/srv/app/` and `/srv/app` — one directory — encoded
  // differently and did NOT collide: two projects could take one CLI transcript
  // directory and interleave their sessions in it. It is also what the adopt
  // duplicate check compares against a realpath'd string.
  //
  // POSIX, always: this is a path on the SYSTEM's filesystem, which A4 fixes at
  // `/`, so `path.posix` and not the host's `path` — a Windows-hosted cc must
  // not fold `/srv/app` into `\srv\app`. The trailing slash is stripped after
  // normalising (`normalize` keeps it), except at the root itself.
  return { system: id, remoteId: remote, systemPath: normalizeSystemPath(p) };
}

// ONE spelling per directory, in the system's own path space. Exported because
// migrations/0034 closes already-stored records with the same rule, and the
// transcript guard derives `samePath` from it.
export function normalizeSystemPath(p: string): string {
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

// The rule itself is `remoteIdDefect` (src/systems/protocol.ts), shared with
// the wire's `remoteList` so a listed id is always one this accepts. What is
// this function's own: null and blank mean "no remote", and the trim.
export function validateRemoteId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw httpError(400, 'remoteId must be a string or null');
  const t = v.trim();
  const defect = remoteIdDefect(t);
  if (defect === 'empty') return null;
  if (defect === 'too-long') {
    throw httpError(400, `remoteId is ${t.length} characters, above the ${REMOTE_ID_MAX}-character limit`);
  }
  if (defect === 'invalid-char') {
    throw httpError(400, `invalid remoteId ${JSON.stringify(v)} — whitespace and control characters are not allowed`);
  }
  return t;
}

// "system 's'", or "remote 'r' of system 's'" — one spelling of the placement
// in a message, so a refusal about a multi-target system says WHICH target.
function describePlacement(p: { system: string; remoteId: string | null }): string {
  return p.remoteId === null ? `system '${p.system}'` : `remote '${p.remoteId}' of system '${p.system}'`;
}

// CHANGING WHICH TARGET A PROJECT IS ON — the one mutation path for `remoteId`,
// so every surface inherits the same guard rather than each route carrying its
// own copy.
//
// `liveInstanceIds` is REQUIRED and has no default. src/instances.ts imports
// this module, so the reverse import would close a cycle and the manager cannot
// be reached from here; a required, non-defaultable getter is what raises the
// bar over a plain array, since a caller has to consciously supply a source
// rather than pass `[]`. BE HONEST ABOUT WHAT THAT IS: a caller that supplies
// `() => []` still defeats it, so the instance half is a CALLER CONTRACT. The
// worktree half below is an INVARIANT — read inside this function, unreachable
// by any caller — and it is the half the "a worktree only ever re-derives to
// the target it was created against" property rests on (see WorktreeMeta).
//
// The refusal NAMES what must be cleared rather than clearing it: nothing the
// user did not ask about is discarded. Same contract as removeSystem's 409.
export async function setProjectRemote(
  name: string,
  remoteId: unknown,
  { liveInstanceIds }: { liveInstanceIds: () => string[] },
): Promise<{ name: string; system: string; remoteId: string | null; systemPath: string | null }> {
  validateName(name);
  const record = await readProjectRecord(name);
  if (!record) throw httpError(404, `project '${name}' not found`);
  const location = record.location;
  if (location.kind === 'local') {
    throw httpError(400, `project '${name}' is on cc's own machine, which is one machine — it has no named targets. `
      + `Register it on a system to give it one.`);
  }
  const next = validateRemoteId(remoteId);

  // Dynamic, as elsewhere in this module: worktrees.ts statically imports it.
  const { registeredWorktreeNames } = await import('./worktrees.ts');
  const worktrees = await registeredWorktreeNames(name);
  const instances = liveInstanceIds();
  if (worktrees.length > 0 || instances.length > 0) {
    const parts = [
      instances.length > 0 ? `${instances.length} live session(s): ${instances.join(', ')}` : null,
      worktrees.length > 0 ? `${worktrees.length} registered worktree(s): ${worktrees.join(', ')}` : null,
    ].filter(Boolean);
    throw httpError(
      409,
      `project '${name}' cannot change target while it has ${parts.join(' and ')}. `
      + `A live session's shells and union mount are coherent only against the target they were opened on, `
      + `and a worktree re-derives its target from this project. Clear them first.`,
      { code: 'PROJECT_PLACEMENT_IN_USE', systemRefusal: true, instances, worktrees },
    );
  }

  // VERIFY BEFORE PERSIST, the same shape addSystem has: a target the provider
  // does not serve refuses here, with nothing written.
  await systemById(location.system, next, `project '${name}'`);

  // Nothing local to clean up: under the FUSE-union geometry a remote session
  // reads the project's tree through the union at its real path on the system,
  // so retargeting leaves no cc-owned copy of the old target's bytes behind.

  await writeProjectRecord(name, { location: { ...location, remoteId: next } });
  // The cached git facts were measured on the target the project just left.
  const { invalidate } = await import('./projectsCache.ts');
  invalidate(name);
  return { name, system: location.system, remoteId: next, systemPath: location.path };
}

// Delete the entire project directory + the project's central-store
// entry. Caller is responsible for first killing any running instances
// and removing worktree registrations (the cascade is orchestrated in
// src/routes/projects.ts). Sessions under ~/.claude/projects/<encoded>/ are
// deliberately left in place — they might still be referenced by
// `claude --resume` outside the orchestrator.
// The project a DELETE addresses, resolved WITHOUT reaching its system.
//
// Unregistering needs the name and the placement, never the tree. `getProject`
// resolves the system, so putting it in front of `deleteProject` made
// deleteProject's remote branch — written precisely so a project on a system
// that is down is never stranded — unreachable from the only surface a user
// has, and turned that into a DEADLOCK: the project stayed registered, and
// `removeSystem` then refused 409 because that project still named the system.
//
// A remote project EXISTS by virtue of its record, including when that record is
// malformed (a `system` with no `systemPath`): deleting it is the repair for
// exactly that state, so this must not refuse it. Only the local branch can 404,
// and resolving a local project never consults a remote system.
export async function getProjectForDelete(
  name: string,
): Promise<{ name: string; location: ProjectLocation | null }> {
  validateName(name);
  let record: ProjectRecord | null;
  // A MALFORMED RECORD STILL DELETES. The project exists by virtue of the file
  // being there, and deleting it is the repair for exactly that state — a
  // reader that refused here would make the broken record permanent.
  try { record = await readProjectRecord(name); }
  catch { return { name, location: null }; }
  if (!record) throw httpError(404, `project '${name}' not found`);
  return { name, location: record.location };
}

// DELETE MEANS DEREGISTER. The record goes; the TREE stays unless the caller
// ticks `deleteDirectory`, and for a project on another machine there is no
// such tick at all — cc owns no area there and removing a directory on a
// machine it does not own needs its own design.
//
// Nothing here resolves the SYSTEM: nothing needs to reach it, and a project on
// a system that is down must not be stranded in the registry for ever.
export async function deleteProject(
  name: string,
  { deleteDirectory = false }: { deleteDirectory?: boolean } = {},
): Promise<{ name: string; path: string; system: string; remoteId: string | null; directoryDeleted: boolean }> {
  const { location } = await getProjectForDelete(name);
  if (deleteDirectory && location?.kind === 'remote') {
    throw httpError(400, `project '${name}' is on system '${location.system}' — cc removes its record of a `
      + `tree on another machine and never the tree itself, so there is no directory for it to delete.`);
  }
  let directoryDeleted = false;
  if (deleteDirectory && location?.kind === 'local') {
    try { await localSystem().removeTree(location.path); }
    catch (e) { throw httpError(500, `failed to delete project '${name}': ${errMsg(e)}`); }
    directoryDeleted = true;
  }
  await removeProjectStoreDir(name);
  // cc's OWN worktree area for this project — always removed, whether or not
  // the tree was. Its checkouts are cc-created, and the worktree cascade has
  // already emptied it of anything registered.
  try { await fs.rm(path.join(localWorktreesRoot(), name), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  const placement = location ? placementOf(name, location) : null;
  return {
    name,
    path: placement?.path ?? '',
    system: placement?.system ?? LOCAL_SYSTEM_ID,
    remoteId: placement?.remoteId ?? null,
    directoryDeleted,
  };
}

// The central-store entry holds attachments, debug captures and worktree
// metadata — all of it cc-owned bookkeeping about a project cc no longer
// tracks, so all of it goes with the project. Always LOCAL, on every branch:
// the store is cc's own, wherever the tree lives.
export async function removeProjectStoreDir(name: string): Promise<void> {
  forgetWorktreeLandings(name);
  try { await fs.rm(projectStoreDir(name), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  markProjectsChanged();
}

// Is `inner` the same directory as `outer`, or inside it? Decided with
// path.relative rather than a string prefix, which needs TWO corrections to be
// right and still isn't: a bare prefix test matches a merely prefix-SHARING
// sibling (`<root>-backup` "inside" `<root>`), anchoring it with a separator
// fixes that but then misses the filesystem root (`'/' + path.sep` is `'//'`,
// which prefixes nothing — so `/`, which contains everything, tested as
// containing nothing). path.relative gets every case right with no special
// case: '' means equal, a result that escapes upward means outside.
// Both paths must already be resolved — every caller passes a realpath.
function isWithin(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  if (rel === '') return true;                       // the same directory
  if (path.isAbsolute(rel)) return false;            // no relative route at all
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export type AdoptResult =
  | { ok: true; name: string; path: string; system: string; remoteId: string | null }
  | {
    ok: false; code: string; reason: string;
    // PROJECT_EXISTS_STALE only: where the held record points, and what a
    // 'replace' would throw away with it.
    heldPath?: string;
    discards?: { attachments: number; debug: number; worktrees: number };
  };

// What to do when the name is held by a record whose path no longer resolves.
//   'relocate' — repoint that record at the new target, KEEPING its store
//                subtree (attachments, debug captures, worktree registrations).
//   'replace'  — discard the store subtree and register the target afresh.
export type StaleRecordAction = 'relocate' | 'replace';

// Adopt a directory that already exists on disk as the project `name`, by
// writing its record. Shared by the REST and MCP surfaces. Every refusal is
// RETURNED with a machine-readable `code`, never thrown — same contract as
// syncWorktree / mergeWorktreeIntoParent.
//
// Every check runs BEFORE any filesystem mutation, so a refused adopt writes
// nothing.
// The refusal for a system that answered nothing. Separate from every code that
// asserts something about the TREE: those are facts, and cc has none here.
function unreachableDuring(systemId: string, what: string, e: unknown): AdoptResult {
  return {
    ok: false,
    code: 'SYSTEM_UNREACHABLE',
    reason: `could not ${what} on system '${systemId}': ${errMsg(e)}`,
  };
}

// One `projects` signal for an adopt, a replaced or relocated stale record included.
export function adoptProject(...args: Parameters<typeof adoptProjectSteps>) {
  return projectsOperation(() => adoptProjectSteps(...args));
}

async function adoptProjectSteps(
  name: unknown,
  target: unknown,
  { system: systemId = null, remoteId = null, onStaleRecord = null }: {
    system?: unknown; remoteId?: unknown; onStaleRecord?: unknown;
  } = {},
): Promise<AdoptResult> {
  if (onStaleRecord !== null && onStaleRecord !== undefined
    && onStaleRecord !== 'relocate' && onStaleRecord !== 'replace') {
    return {
      ok: false, code: 'INVALID_STALE_ACTION',
      reason: `onStaleRecord must be 'relocate' or 'replace' (got ${JSON.stringify(onStaleRecord)}).`,
    };
  }
  const staleAction = (onStaleRecord ?? null) as StaleRecordAction | null;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, code: 'INVALID_NAME', reason: 'project name must match ^[a-zA-Z0-9._-]+$.' };
  }
  // Dot-leading names are reserved for orchestrator-managed projects — this is
  // what stops an adopted project shadowing `.conduct`. (The create path enforces
  // the same rule in src/routes/projects.ts; this one lives in the shared function so both
  // adopt surfaces are covered.)
  if (name.startsWith('.')) {
    return { ok: false, code: 'INVALID_NAME', reason: `project name '${name}' cannot start with "." — reserved for orchestrator-managed projects.` };
  }
  if (typeof target !== 'string' || target.trim() === '' || !path.isAbsolute(target)) {
    return { ok: false, code: 'INVALID_TARGET_PATH', reason: 'path must be a non-empty absolute path.' };
  }
  // WHICH MACHINE. Adoption has no record yet to read a system from, so the
  // CALLER names it; absent, the tree is on cc's own machine and the location
  // is `local`.
  //
  // Every check below then runs ON THE NAMED SYSTEM — the realpath, the stat and
  // the git-toplevel probe are all questions about the tree, and asking cc's own
  // machine about a path on another one is the wrong-machine read this phase
  // exists to close.
  // `target` is already known to be a non-empty absolute path here, so the
  // placement is decided by the system alone.
  const namedSystem = typeof systemId === 'string' ? systemId.trim() : '';
  let namedRemote: string | null;
  try { namedRemote = validateRemoteId(remoteId); }
  catch (e) { return { ok: false, code: 'INVALID_REMOTE_ID', reason: errMsg(e) }; }
  if (namedRemote && (!namedSystem || namedSystem === LOCAL_SYSTEM_ID)) {
    return {
      ok: false, code: 'INVALID_REMOTE_ID',
      reason: `remoteId '${namedRemote}' was given without a system — cc's own machine is one machine, so it has no named targets.`,
    };
  }
  const placement = (!namedSystem || namedSystem === LOCAL_SYSTEM_ID)
    ? null
    : { system: namedSystem, remoteId: namedRemote, systemPath: target };
  let system: System;
  if (placement) {
    try { system = await systemById(placement.system, placement.remoteId, `project '${name}'`); }
    catch (e) { return { ok: false, code: 'SYSTEM_UNREACHABLE', reason: errMsg(e) }; }
  } else {
    system = localSystem();
  }
  // TARGET_NOT_FOUND is a claim ABOUT THE TREE, so it is only made when the
  // system actually answered "no such path". A transport that died mid-probe
  // asserted a fact cc never got to ask about — and sent the user hunting for a
  // missing directory that was there all along.
  let real: string;
  try { real = await system.realpath(target); }
  catch (e) {
    if (errCode(e) !== 'ENOENT') return unreachableDuring(system.id, `resolve '${target}'`, e);
    return { ok: false, code: 'TARGET_NOT_FOUND', reason: `cannot resolve '${target}': ${errMsg(e)}` };
  }
  let targetStat;
  try { targetStat = await system.stat(real); }
  catch (e) {
    if (errCode(e) !== 'ENOENT') return unreachableDuring(system.id, `stat '${real}'`, e);
    return { ok: false, code: 'TARGET_NOT_FOUND', reason: `cannot stat '${real}': ${errMsg(e)}` };
  }
  // Absent after a successful realpath is a raced deletion, not a bad shape —
  // same code the throwing form reported.
  if (!targetStat) {
    return { ok: false, code: 'TARGET_NOT_FOUND', reason: `cannot stat '${real}': no such file or directory` };
  }
  if (targetStat.kind !== 'dir') {
    return { ok: false, code: 'TARGET_NOT_A_DIRECTORY', reason: `'${real}' is not a directory.` };
  }

  // NESTING UNDER THE PROJECTS ROOT IS LEGAL. A directory there is only a
  // project when a record says so, so a grouping directory can hold projects at
  // any depth and the containment test that used to refuse them is gone.
  //
  // What stays refused is a target that CONTAINS the projects root — adopting
  // it would put every managed project, cc's own checkout and the store itself
  // inside one "project" the conductor's hard boundary then forbids anyone from
  // working inside — and a target inside cc's OWN STATE: the store, the
  // worktree area, or the Library's plugin checkouts. `.plugins` is not
  // optional there: a Library install's post-clone step is best-effort, so a
  // half-installed directory can sit under it for a free-text adopt to find.
  //
  // SKIPPED FOR A REMOTE ADOPT, and not as a shortcut: these are paths on cc's
  // OWN machine, so a path on another one neither is inside them nor contains
  // them however the two strings compare. Running the test anyway would refuse
  // a perfectly good remote tree for resembling a local one.
  if (!placement) {
    let rootReal = projectsRoot();
    try { rootReal = await fs.realpath(rootReal); } catch { /* root may not exist yet */ }
    if (isWithin(rootReal, real)) {
      return { ok: false, code: 'TARGET_ALREADY_MANAGED', reason: `'${real}' contains the projects root '${rootReal}' — adopting it would put every managed project inside one project.` };
    }
    for (const owned of [orchStoreRoot(), localWorktreesRoot(), pluginsRoot()]) {
      let ownedReal = owned;
      try { ownedReal = await fs.realpath(owned); } catch { /* may not exist yet */ }
      if (isWithin(real, ownedReal)) {
        return { ok: false, code: 'TARGET_IS_CC_STATE', reason: `'${real}' is inside '${owned}', which is code-conductor's own state — adopt a directory cc does not manage.` };
      }
    }
  }
  // A path identifies a tree only together with the machine it is on — and one
  // registered system can BE many machines, so the machine is (system,
  // remoteId). Two targets each hosting `/app` are two different trees, so the
  // duplicate test compares the whole triple and not a path alone. It runs for
  // BOTH kinds now: a local record carries its path too.
  const wantSystem = placement?.system ?? LOCAL_SYSTEM_ID;
  const wantRemote = placement?.remoteId ?? null;
  for (const p of await listProjects()) {
    if (p.system === wantSystem && p.remoteId === wantRemote && samePath(p.path, real)) {
      return { ok: false, code: 'TARGET_ALREADY_MANAGED', reason: `'${real}' is already adopted as project '${p.name}'${placement ? ` on ${describePlacement(placement)}` : ''}.` };
    }
  }

  // NOT A REPO IS NOT A REFUSAL — a plain directory is an adoptable non-git
  // project, a state the rest of cc already models (projectStatus and
  // computeGitFacts short-circuit on isGitRepo, getProjectCommits returns an
  // empty history, createWorktree refuses by name).
  //
  // TWO PROBES, AND THE ORDER IS LOAD-BEARING. Each answers ONE question, and
  // neither answers the other's:
  //
  //   --show-toplevel  "which work tree claims `real`?" It ANSWERS only when one
  //                    does; its failure says no more than "none does" — equally
  //                    true of a plain directory, of a git dir with no work
  //                    tree, and of a system carrying no `git` binary at all.
  //   --git-dir        "is there a git dir at or above `real`?" — asked ONLY on
  //                    that failure, which is where it separates those three.
  //
  // Do not merge the probes and do not reorder them. Asking the second only on
  // the first's failure holds the common repo-root path to one exec, and a system with no
  // git fails BOTH and lands in the allow branch — the case this whole check
  // exists to admit.
  //
  // REASON FROM THOSE TWO MEANINGS, never from a table of shapes and exit codes:
  // which shape lands in which branch is git's business and it moves. A
  // submodule's git dir, for one, ANSWERS `--show-toplevel` — with the work tree
  // its back-reference names — so it refuses as TARGET_INSIDE_REPO and never
  // reaches here.
  //
  // `isGitRepo()` walks UP, which is why it cannot answer the FIRST question —
  // it says "yes" for any subdirectory of a repo. Reusing it here is still
  // sound, and NOT because the walk finds nothing: from a `.git`, or inside a
  // bare repo, it does find a git dir — that is how it answers true at all. It
  // is sound because no work tree ANSWERED for `real`, or the branch above would
  // have run, so the walk can only confirm a git dir and can never turn up a
  // work tree this refusal would be wrong about.
  //
  // Dynamic import for the same reason as createProject's — worktrees.ts
  // statically imports this module.
  //
  // Git refusing the repo on ownership answers neither question, and reading it
  // as "no repo" would adopt a foreign-owned repo as a plain directory and
  // write into it — so it is a refusal of its own, carrying git's fix.
  const { runGit, isGitRepo, isGitOwnershipRefusal } = await import('./worktrees.ts');
  let top: Awaited<ReturnType<typeof runGit>>;
  let bareOrGitDir = false;
  try {
    top = await runGit(system, real, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) bareOrGitDir = await isGitRepo(system, real);
  } catch (e) {
    if (!isGitOwnershipRefusal(e)) throw e;
    return { ok: false, code: 'TARGET_DUBIOUS_OWNERSHIP', reason: errMsg(e) };
  }
  if (top.code === 0) {
    let topReal = top.stdout.trim();
    try { topReal = await system.realpath(topReal); } catch { /* compare what git printed */ }
    if (!samePath(topReal, real)) {
      return {
        ok: false, code: 'TARGET_INSIDE_REPO',
        reason: `'${real}' is inside the git repository whose toplevel is '${topReal}' — adopt that instead.`,
      };
    }
  } else if (bareOrGitDir) {
    // A repository cc cannot host a project in. Adopting one writes
    // CONVENTIONS.md and the @CONVENTIONS.md import INTO A REPOSITORY'S
    // INTERNALS — and for a `.git` that repository is an ENCLOSING one the user
    // never chose, which is the exact hazard the branch above refuses and the
    // one `--show-toplevel` is blind to. A bare repo is the other half: it
    // reports `isGitRepo: true`, promising a full git surface, while `git
    // status` fails in it and project_status answers `dirtyUnknown` instead of a
    // measurement. Half-working is worse than a named refusal.
    return {
      ok: false, code: 'TARGET_NO_WORK_TREE',
      reason: `'${real}' is a git directory with no work tree (a bare repository, or a repo's own '.git') — adopt a work tree instead.`,
    };
  }

  const location: ProjectLocation = placement
    ? { kind: 'remote', system: placement.system, remoteId: placement.remoteId, path: real }
    : { kind: 'local', path: real };

  // THE NAME. A record that still resolves is an ordinary PROJECT_EXISTS. One
  // whose path no longer resolves is a STALE record — the project moved, or its
  // volume went — and the caller is offered the two repairs rather than told to
  // pick another name for a project it already has.
  let heldRecord: ProjectRecord | null;
  try { heldRecord = await readProjectRecord(name); }
  catch (e) {
    return {
      ok: false, code: 'PROJECT_EXISTS',
      reason: `project '${name}' already exists but its record could not be read (${errMsg(e)}) — `
        + `delete it to unregister the name, or pick another name.`,
    };
  }
  if (heldRecord) {
    const verdict = await heldRecordVerdict(name, heldRecord);
    if (verdict === 'resolves') {
      return { ok: false, code: 'PROJECT_EXISTS', reason: `project '${name}' already exists at ${heldRecord.location.path}.` };
    }
    if (verdict === 'undecidable') {
      return {
        ok: false, code: 'PROJECT_EXISTS_UNRESOLVABLE',
        reason: `project '${name}' already exists at ${heldRecord.location.path}, and cc could not ask its `
          + `system whether that is still there — so it cannot tell a moved project from a machine that is `
          + `merely down. Fix the system, or delete the project to unregister the name.`,
      };
    }
    if (staleAction === null) {
      return {
        ok: false, code: 'PROJECT_EXISTS_STALE',
        reason: `project '${name}' is registered at ${heldRecord.location.path}, which no longer exists. `
          + `Pass onStaleRecord:'relocate' to repoint it at '${real}' and keep its stored state, or `
          + `onStaleRecord:'replace' to discard that state and register '${real}' afresh.`,
        heldPath: heldRecord.location.path,
        discards: await staleDiscards(name),
      };
    }
    if (staleAction === 'relocate') {
      // A WORKTREE RE-DERIVES ITS PATH FROM ITS PARENT, SO THE PARENT CANNOT
      // MOVE WHILE A REGISTRATION EXISTS — the same invariant, in the same
      // refusal shape, that `setProjectRemote` already enforces for a target
      // change.
      //
      // THE PREDICATE IS OVER THE DERIVATION, NOT OVER EITHER ENDPOINT.
      // `worktreePathFor` derives a LOCAL checkout from cc's own `.worktrees`
      // root, which does not depend on where the project's tree is, and a
      // REMOTE one from `dirname(location.path)`. So the derivation survives a
      // relocation only when BOTH ends are local; every other combination
      // changes where the checkout is derived to while the checkout itself
      // stays put. Stored and derived then diverge permanently — and the
      // transcript guard, which re-derives precisely so it cannot disagree with
      // what it guards, checks paths that hold nothing while the real checkout
      // goes unprotected. A remote→local move is worse still: the repair below
      // would run `git worktree repair` through cc's own handle on paths that
      // exist on another machine, and rewrite `parentPath` to a tree neither
      // the checkout nor its gitdir is under.
      //
      // NOT narrowed to "only when the system has no `worktreesDir`": that
      // override can be cleared afterwards, and the divergence would appear
      // retroactively over a move nothing refused. `'replace'` needs no such
      // guard — it discards the registrations along with the store subtree,
      // which is what its `discards.worktrees` count tells the caller.
      if (heldRecord.location.kind !== 'local' || location.kind !== 'local') {
        const { registeredWorktreeNames } = await import('./worktrees.ts');
        const held = await registeredWorktreeNames(name);
        if (held.length > 0) {
          return {
            ok: false, code: 'PROJECT_PLACEMENT_IN_USE',
            reason: `project '${name}' cannot be relocated while it has ${held.length} registered `
              + `worktree(s): ${held.join(', ')}. A worktree on a system re-derives its path from this `
              + `project's, and its checkout does not move — delete them first, or pass `
              + `onStaleRecord:'replace' to discard them along with the rest of its stored state.`,
          };
        }
      }
      // THE TRANSCRIPT-KEY GUARD RUNS HERE TOO. This is the one registration
      // path that cannot go through `registerProject` — the name is held, by
      // the very record being repointed — so the check it would have made is
      // made explicitly. Without it a relocation writes a path that encodes to
      // a CLI transcript directory another project already occupies, and the
      // two interleave their sessions in it with nothing refusing: the
      // duplicate-target loop above compares paths EXACTLY, and `encodeCwd`
      // folds `/` and `-` alike, so `/srv/a-b` and `/srv/a/b` pass it.
      // `transcriptCwdCollision` skips the candidate's own identity, so the
      // stale record being replaced cannot refuse its own relocation.
      //
      // BOTH COORDINATES OF THE LOCATION, not the system alone: a transcript
      // directory is keyed on (system, remoteId, cwd), so a candidate that
      // dropped the target would be compared against the provider's DEFAULT
      // target's directory — refused by a holder it shares nothing with, and
      // admitted past one it does.
      const why = await projectKeyCollisionReason(
        location.kind === 'remote' ? location.system : LOCAL_SYSTEM_ID,
        location.kind === 'remote' ? location.remoteId : null,
        name, real);
      if (why) return { ok: false, code: 'TRANSCRIPT_DIR_COLLISION', reason: why };
      await writeProjectRecord(name, { location });
      // The cached git facts were measured at the path the project just left.
      const { invalidate } = await import('./projectsCache.ts');
      invalidate(name);
      // And so were its worktrees' back-references, in both directions. Lazy
      // import for the projects.ts ↔ worktrees.ts edge, as everywhere here.
      //
      // NON-FATAL, for the same reason deliverAdoptedConventions below is: the
      // RECORD is what makes the relocation stand, and it is already written.
      // Throwing here would answer a 500 for a relocation that succeeded — and
      // the retry then gets an ordinary PROJECT_EXISTS, because the name now
      // resolves. The git half already warns and continues on its own; this
      // covers the two steps that are not git (resolving the project, and the
      // store writes).
      try {
        const { repairWorktreesAfterProjectMove } = await import('./worktrees.ts');
        await repairWorktreesAfterProjectMove(name);
      } catch (e) {
        console.warn(`adoptProject: '${name}' was relocated to '${real}', but its worktree `
          + `back-references could not be repaired: ${errMsg(e)}`);
      }
      await deliverAdoptedConventions(name, real);
      return { ok: true, name, path: real, system: location.kind === 'remote' ? location.system : LOCAL_SYSTEM_ID, remoteId: placement?.remoteId ?? null };
    }
    // This drops locked worktrees' registrations too, deliberately: the lock
    // guards branches against being landed or destroyed, and this touches no
    // branch, checkout or commit — only cc's records of them.
    await removeProjectStoreDir(name);
  }

  try {
    await registerProject(name, location);
  } catch (e) {
    // registerProject re-runs the name and transcript-key guards at the write —
    // its refusals are this surface's, in this surface's returned shape.
    const code = (e as { code?: unknown }).code;
    return {
      ok: false,
      code: typeof code === 'string' ? code : 'PROJECT_EXISTS',
      reason: errMsg(e),
    };
  }
  await deliverAdoptedConventions(name, real);
  return { ok: true, name, path: real, system: location.kind === 'remote' ? location.system : LOCAL_SYSTEM_ID, remoteId: placement?.remoteId ?? null };
}

// Does the path a held record names still exist? Three answers, because "cc
// could not ask" is not "it is gone": offering relocation on an unreachable
// system would repoint a perfectly good project because a box was down.
async function heldRecordVerdict(
  name: string, record: ProjectRecord,
): Promise<'resolves' | 'stale' | 'undecidable'> {
  const placement = placementOf(name, record.location);
  let system: System;
  try {
    system = placement.system === LOCAL_SYSTEM_ID
      ? localSystem()
      : await systemById(placement.system, placement.remoteId, `project '${name}'`);
  } catch { return 'undecidable'; }
  try {
    const stat = await system.stat(placement.path);
    return stat?.kind === 'dir' ? 'resolves' : 'stale';
  } catch { return 'undecidable'; }
}

// What a 'replace' would throw away with the store subtree. Counts, not names:
// the caller needs to know whether anything is at stake, and the names are one
// `ls` away in a directory the refusal has already located.
async function staleDiscards(name: string): Promise<{ attachments: number; debug: number; worktrees: number }> {
  const count = async (dir: string): Promise<number> => {
    try { return (await fs.readdir(dir)).length; } catch { return 0; }
  };
  const store = projectStoreDir(name);
  return {
    attachments: await count(path.join(store, 'attachments')),
    debug: await count(path.join(store, 'debug')),
    worktrees: await count(path.join(store, 'worktrees')),
  };
}

// Deliver the conventions into the adopted tree NOW — symmetric with
// createProject, which seeds both files at creation. Without this the first
// write into the user's tree would happen silently at some later boot sweep
// instead of inside the call they authorised. Non-fatal: the RECORD (the
// symlink, or the project.json placement) is what makes the adoption stand, so
// a failure here leaves the project adopted and the next boot sweep retries.
async function deliverAdoptedConventions(name: string, real: string): Promise<void> {
  try {
    const { ensureProjectConventionsMd } = await import('./projectClaudeMd.ts');
    await ensureProjectConventionsMd(name);
  } catch (e) {
    console.warn(`adoptProject: CONVENTIONS.md not written into '${real}': ${errMsg(e)}`);
  }
}
