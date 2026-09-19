import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAll as loadAllTitles, deleteTitle as deleteSessionTitle } from './sessionTitles.ts';
import { loadAll as loadAllConducted, unmarkConducted } from './conductedSessions.ts';
import { loadAllTemps } from './tempSessions.ts';
import { loadAllArchived, markArchived, unmarkArchived } from './archivedSessions.ts';
import { loadAll as loadAllSessionModes, effectiveResumeMode, unmarkSessionMode } from './sessionModes.ts';
import { lastActivityOf } from './sessionActivity.ts';
import type { WorktreeMeta } from './worktrees.ts';
import { httpError } from './httpError.ts';
import { isSessionId } from './identifiers.ts';
import {
  CONDUCT_PROJECT_NAME, LOCAL_SYSTEM_ID, localSystem, placementOf, projectPlacement,
  resolveSystem, systemById,
} from './systems/registry.ts';
import { writeFileAtomic } from './systems/localSystem.ts';
import type { System } from './systems/system.ts';
import type { ProjectPlacement } from './systems/registry.ts';

// Re-exported from its implementation on the local system: the store is always
// local, so cc's own atomic writes and the local System's are one operation.
export { writeFileAtomic };

// Default projects root = parent directory of the code-conductor repo,
// resolved once at module load. Layout: <parent>/code-conductor/src/
// projects.ts → <parent>/. Matches the convention that the orchestrator
// + its sibling projects all live under a single workspace dir (the
// user's ~/cc-projects/ by default). Override with PROJECTS_ROOT.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// The conductor's own repo root — one level up from src/, unlike
// DEFAULT_PROJECTS_ROOT above which goes two levels up to the *parent* of
// the repo (where sibling projects, including this one, live).
const SELF_PROJECT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Workspace names are becoming path segments (a directory-per-workspace
// layout), so they're restricted to the project charset: no spaces, no `/`
// or `\`, and `a/../b` can't traverse. This deliberately reverses the earlier
// "natural label" looseness ("Side projects", "client/Foo") — path-safety at
// the source beats sanitising at every future call site. The 40-char bound
// (1 + 39) is kept: the UI and the error text depend on a bounded label.
//
// The first character additionally excludes `.`, so `..`, `.` and `.hidden`
// are refused — a dot-leading or dot-only name is exactly the path hazard
// this regex exists to prevent. That's a deliberate deviation from NAME_RE
// above, which still admits `.hidden` because `.conduct` is a real project
// name; the dot-ONLY half of the hazard (`.` / `..`) is closed in
// validateName instead, since NAME_RE has no positional rules to close it in.
// Do NOT "restore parity" by loosening this regex — it reopens the hazard for
// workspaces, which have no `.conduct` case to accommodate.
const WORKSPACE_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,39}$/;

// All orchestrator-owned state lives under a single dotfolder at the
// workspace root (`<projectsRoot>/.code-conductor/`). Layout:
//   <store>/projects/<name>/project.json
//   <store>/projects/<name>/attachments/<file>
//   <store>/projects/<name>/debug/<instance-id>/
//   <store>/projects/<name>/worktrees/<worktreeDir>/worktree.json
//   <store>/projects/<name>/worktrees/<worktreeDir>/attachments/<file>
//   <store>/projects/<name>/worktrees/<worktreeDir>/debug/<instance-id>/
// Project + worktree directories themselves stay clean.
export const ORCH_STORE_DIRNAME = '.code-conductor';

export function projectsRoot(): string {
  return process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

// The conductor's own running checkout dir (the dir holding server.ts /
// package.json). Exposed so the plugin supervisor can hand it to backends as
// CONDUCTOR_PROJECT_DIR — they surface the conductor as an app even when its
// checkout isn't under projectsRoot().
export function selfProjectDir(): string {
  return SELF_PROJECT_DIR;
}

export function orchStoreRoot(): string {
  return path.join(projectsRoot(), ORCH_STORE_DIRNAME);
}

// Every local worktree checkout cc creates lives under one dotfolder at
// `<projectsRoot>/.worktrees/<project>/<key>` — wherever the project itself
// lives. Dot-prefixed so it can never be mistaken for a project directory, and
// `<project>/` scoped so two projects may share a worktree key.
export const LOCAL_WORKTREES_DIRNAME = '.worktrees';

export function localWorktreesRoot(): string {
  return path.join(projectsRoot(), LOCAL_WORKTREES_DIRNAME);
}

// Where the Plugin Library clones an installed plugin. A plugin checkout is an
// ordinary project with an ordinary record; this directory only keeps cc's own
// installs out of the area a user browses for adoptable trees.
export const PLUGINS_DIRNAME = '.plugins';

export function pluginsRoot(): string {
  return path.join(projectsRoot(), PLUGINS_DIRNAME);
}

export function projectStoreDir(name: string): string {
  return path.join(orchStoreRoot(), 'projects', name);
}

// Where a project's worktree REGISTRATIONS live. This directory is the
// authoritative list — listWorktrees enumerates it rather than asking git, so a
// registration survives a system cc cannot reach.
export function worktreesStoreRoot(projectName: string): string {
  return path.join(projectStoreDir(projectName), 'worktrees');
}

export function worktreeStoreDir(projectName: string, worktreeName: string): string {
  return path.join(worktreesStoreRoot(projectName), worktreeName);
}

// THE CLI'S OWN CONFIG DIRECTORY on this machine — `~/.claude` unless the host
// overrode it. Every cc reader of the CLI's state resolves through here rather
// than spelling `~/.claude`, because the CLI's own resolution honours the
// variable and a reader that did not would be looking at a directory the CLI is
// not writing.
//
// NOT the directory a remote-backed worker is pointed at: that one is cc-owned,
// per remote, and comes from `remoteConfigDir()`. This is the SOURCE the farm
// links into, and the directory a LOCAL session keeps using untouched.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

// Where LOCAL places' transcripts live. A remote-backed place resolves its root
// through `transcriptRoot()` instead — this function is that expression's local
// branch, and nothing else may call it to name a remote place's directory.
//
// `CLAUDE_PROJECTS_ROOT` stays cc's own reader override (the fake CLIs in tests
// honour it); unset, cc and the CLI agree by construction.
export function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(claudeConfigDir(), 'projects');
}

// ── ONE CLI CONFIG DIRECTORY PER REMOTE ─────────────────────────────────────
//
// The CLI derives its transcript directory from its own cwd, and under the FUSE
// union a remote-backed worker's cwd is the REMOTE's path spelling — so two
// projects at one absolute path on two boxes derive ONE directory. cc does not
// rename that directory; it gives each remote a config directory of its own, so
// the cwd-derived name is scoped by a root that already differs.
//
// The farm lives under the store, which `buildTierTable` already host-pins whole
// through `projectsRoot` — no tier-table entry is required to reach it.
export const CLAUDE_CONFIG_FARM_DIRNAME = 'claude-config';

export function claudeConfigFarmRoot(): string {
  return path.join(orchStoreRoot(), CLAUDE_CONFIG_FARM_DIRNAME);
}

// A path component built from an arbitrary string: the CHARACTER SET is the
// point, not the prettiness. Empty is a legitimate result and the caller drops
// it — every name still carries the digest below.
function configSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}

// The directory name for one (system, remoteId) — the machine coordinate
// `placementToken` already spells.
//
// NOT `remoteId` ITSELF. `validateRemoteId` deliberately permits `_`, `.`, `/`
// and `..` — it refuses only empty, whitespace, control characters and >128
// chars — so a raw remote id used as a directory name is a path-traversal
// hazard. The 12-hex digest carries the whole uniqueness claim; the slugs are a
// readability hint that truncation may eat down to nothing.
export function remoteConfigDirName(system: string, remoteId: string | null): string {
  const digest = createHash('sha256').update(`${system}\0${remoteId ?? ''}`).digest('hex').slice(0, 12);
  const parts = [configSlug(system), configSlug(remoteId ?? '')].filter(Boolean);
  return [...parts, digest].join('-');
}

// THE DIRECTORY `CLAUDE_CONFIG_DIR` POINTS AT for a worker on this remote.
//
// ITS LAST COMPONENT IS `.claude`, and that is load-bearing rather than
// decorative: the CLI resolves its plans directory as `<configDir>/plans`, and
// `planFileFromToolUse` (src/planFile.ts) recognises a plan file by the
// `/.claude/plans/` fragment — home-agnostically, so it holds for a worker
// whatever machine spelling its config dir has. Renaming this component breaks
// plan-file detection for every remote-backed session.
export function remoteConfigDir(p: { system: string; remoteId: string | null }): string {
  return path.join(claudeConfigFarmRoot(), remoteConfigDirName(p.system, p.remoteId), '.claude');
}

export function encodeCwd(abs: string): string {
  // Mirror Claude Code's own encoding: every char that isn't
  // alphanumeric or a hyphen becomes `-`. This includes underscores!
  // Keeping underscores silently breaks any project path containing
  // `_` (notably the worktree dirs we create at
  // `<project>_worktree_<id>`): the orchestrator's metadata appends
  // land at `<…>_worktree_<…>` while real claude writes the actual
  // session to `<…>-worktree-<…>`. Two separate dirs, both half-empty,
  // and resume / history-replay both broken.
  return abs.replace(/[^A-Za-z0-9-]/g, '-');
}

// The two forms mintPublicId (src/sessionLineage.ts) produces: 8 hex chars, or
// its `xxxxxxxx-xxxx` extension. A full UUID, a base-case id and every existing
// fixture are all longer, so they pass this test.
const MINTED_PUBLIC_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4})?$/;

// True when `id` has one of the shapes mintPublicId produces — i.e. it can only
// ever be a PUBLIC id, so it can never name a transcript file. A caller that has
// already resolved through resolveBacking() and STILL sees this shape is holding
// an id no session on disk answers to: that is an UNKNOWN SESSION, not an error,
// and it must degrade to that caller's normal miss path (null / false / 404)
// rather than trip assertBackingId and surface as a 500.
export function isMintedPublicId(id: unknown): boolean {
  return typeof id === 'string' && MINTED_PUBLIC_ID_RE.test(id);
}

// Loud runtime guard on the public/backing boundary. A session's PUBLIC id is
// neither a filename nor a `--resume` argument — those need its CURRENT backing
// id, obtained from `resolveBacking()` (src/sessionLineage.ts) or read off
// `Instance.backingSessionId`. This throws, with the call site named, when it is
// handed something that looks exactly like one of our minted public ids.
//
// It is an ASSERTION, not a behavioural branch: nothing RESOLVES differently by
// id length. If a fixture ever collides with the pattern, rename the fixture —
// do not weaken the guard.
export function assertBackingId(id: string, where: string): void {
  if (typeof id === 'string' && MINTED_PUBLIC_ID_RE.test(id)) {
    throw new Error(
      `${where}: '${id}' is a public session id, not a backing id — resolve it through `
      + 'resolveBacking() (src/sessionLineage.ts) or read Instance.backingSessionId',
    );
  }
}

// WHERE A PLACE'S TRANSCRIPTS LIVE — the coordinate every transcript path is
// built from.
//
// A CWD ALONE CANNOT NAME A DIRECTORY ANY MORE. Under the FUSE union a
// remote-backed worker runs at the remote's own path spelling, so `/root/app3`
// is the same cwd on two different machines. The machine coordinate is what
// tells them apart, and it is carried here rather than re-derived, so no reader
// can accidentally resolve a remote place against the local root.
export interface TranscriptPlacement {
  system: string;
  remoteId: string | null;
  // The CLI's working directory for this place: the project's or worktree's
  // path on whatever machine it lives on.
  cwd: string;
}

// The explicit spelling of a place on THIS machine. Callers that are local by
// construction — `.conduct`, the summariser's scratch dir, a test fixture —
// say so with this rather than letting a default decide for them: a silent
// local default is precisely how a remote place would resolve against the
// wrong root.
export function localPlace(cwd: string): TranscriptPlacement {
  return { system: LOCAL_SYSTEM_ID, remoteId: null, cwd };
}

// The transcript placement of a path on the SAME machine as an already-resolved
// project or worktree. The machine coordinate comes from the project record; the
// cwd is whichever tree path the caller is asking about.
export function placeOf(p: { system: string; remoteId: string | null }, cwd: string): TranscriptPlacement {
  return { system: p.system, remoteId: p.remoteId, cwd };
}

// The transcript ROOT for a place: the directory whose `<encodeCwd(cwd)>`
// subdirectory holds its session jsonls.
//
// `encodeCwd` IS UNCHANGED FOR EVERY PLACE, local and remote — what differs is
// the root it is joined to. For a local place that root is exactly what it
// always was, which is the control tests/systems-remote-config-dir.test.mjs T5
// pins byte-identically.
export function transcriptRoot(p: TranscriptPlacement): string {
  return p.system === LOCAL_SYSTEM_ID
    ? claudeProjectsRoot()
    : path.join(remoteConfigDir(p), 'projects');
}

// THE chokepoint for a persisted transcript path. Every read, write, append, copy
// and unlink of a session jsonl resolves its path here — enforced by
// tests/session-lineage-chokepoint.test.mjs, which fails on any other
// `${…}.jsonl` construction outside this file.
export function sessionFilePath(place: TranscriptPlacement, backingId: string): string {
  assertBackingId(backingId, 'sessionFilePath');
  return path.join(transcriptRoot(place), encodeCwd(place.cwd), sessionFileName(backingId));
}

// The transcript FILENAME a backing id maps to. Split out of sessionFilePath so
// findOrphanedTranscript — which walks encoded-cwd directories it cannot decode
// back into a cwd — names the file through the same one interpolation site
// (tests/session-lineage-chokepoint.test.mjs G4).
function sessionFileName(backingId: string): string {
  return `${backingId}.jsonl`;
}

// The CLI's sibling sub-agent directory for a session — sidechain transcripts
// live at `<this dir>/subagents/agent-<agentId>.jsonl`. Keyed to the transcript,
// so it is a backing-id path under the same rule as sessionFilePath.
export function subAgentDirPath(place: TranscriptPlacement, backingId: string): string {
  assertBackingId(backingId, 'subAgentDirPath');
  return path.join(transcriptRoot(place), encodeCwd(place.cwd), backingId);
}

// Resolve a caller-supplied session id to the BACKING id that names a transcript,
// or null when nothing on disk can answer to it.
//
// The lazy import is required, not stylistic: sessionLineage.ts imports
// orchStoreRoot() from this module, so a static edge here would close a cycle.
// Same pattern (and same reason) as loadWorktreesFor below. Every caller is async
// and off the hot path.
export async function resolveToBackingId(sessionId: string): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const { resolveBacking } = await import('./sessionLineage.ts');
  const backingId = await resolveBacking(sessionId);
  // Still minted-shaped after resolution ⇒ there is no lineage row, so no file is
  // named by it. Decline cleanly instead of letting sessionFilePath assert.
  return isMintedPublicId(backingId) ? null : backingId;
}

// Project a transcript FILENAME to the id a client should be handed.
//
// A row is projected to its session's PUBLIC id only when it is that session's
// CURRENT segment (or has no lineage row at all — the base case, where the two are
// the same string anyway). That is what makes the sidebar's live/on-disk
// correlation work: a live instance reports its public id, and its one
// non-archived row on disk is always `current`, so the two match again.
//
// A SUPERSEDED segment deliberately keeps its filename. Such a row exists to
// address one specific transcript — Settings → Archived restores and deletes
// individual files — and every superseded segment of a session shares one public
// id, so projecting them would collapse distinct rows onto a single ambiguous
// handle and point Delete at the live transcript instead of the archived one.
function projectRowId(
  filename: string,
  lineage: { byPublic: Map<string, LineageRowLike>; byBacking: Map<string, string> },
): string {
  const publicId = lineage.byBacking.get(filename);
  if (!publicId) return filename; // no row ⇒ public id IS the filename
  return lineage.byPublic.get(publicId)?.current === filename ? publicId : filename;
}

interface LineageRowLike { current: string }

export function validateName(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw httpError(400, 'invalid project name (must match ^[a-zA-Z0-9._-]+$)');
  }
  // `.` and `..` pass NAME_RE (it has no positional rules) but they are PATH
  // TRAVERSAL, not names: `path.join(projectsRoot(), '..')` escapes the root
  // entirely, and every caller that follows treats what it gets back as a
  // project directory it may write into or REMOVE — deleteProject would
  // recursively delete the projects root's parent. Refused here, in the one
  // function every name-taking entry point already funnels through, rather
  // than at each of them. Dot-LEADING names stay legal: `.conduct` is one.
  if (name === '.' || name === '..') {
    throw httpError(400, `invalid project name '${name}' (a dot-only name is a path traversal, not a project)`);
  }
  return name;
}

export interface ProjectInfo {
  name: string;
  path: string;
  workspace: string | null;
  // The System the tree lives on and WHICH TARGET of it — both from
  // placementOf(), so the `.conduct` pin holds here too. Plain strings, not the
  // System HANDLE: both REST and MCP spread this into a response body. `path`
  // is the tree's path ON that system; there is no second path field, which is
  // what makes an in-root and an out-of-root project indistinguishable here.
  system: string;
  remoteId: string | null;
  // Set only when the row's RECORD could not be parsed. The name is recoverable
  // from the store directory without reading the file, so the row is emitted
  // with an empty `path` and this reason rather than dropped — a silently
  // skipped row is the disappearing row the degraded-listing contract exists to
  // prevent.
  degraded?: string;
}

// What the resolver hands back: where the project's tree is, and — threaded
// through every operation on that tree — the System it lives on.
export interface ResolvedProjectDir {
  path: string;
  system: System;
}

// THE resolver every project path in the app comes from: ONE record read, no
// filesystem probing. The record IS the registration, for every kind of
// project, so resolution never depends on the tree still existing — which is
// what lets a vanished or unreachable tree still be unregistered instead of
// reading as a project that never existed.
//
// A LOCAL record's `path` is stored as the target's REALPATH (adoptProject
// resolves it before writing). That is load-bearing, not tidiness: the Claude
// CLI encodes its `~/.claude/projects/<encoded-cwd>/` session dir from
// `getcwd()`, which is always the realpath, so cc's own encodeCwd() must be fed
// the same string or every resume of that project's sessions looks at the wrong
// directory. Claude Code's `CLAUDE.md` upward walk follows the realpath for the
// same reason, and neither has an env lever.
//
// A malformed record THROWS (500, never 404). With the record as the sole
// registration, degrading to an empty one would silently UNREGISTER a project.
export async function resolveProjectDir(name: string): Promise<ResolvedProjectDir | null> {
  const record = await readProjectRecord(name);
  if (!record) return null;
  const placement = placementOf(name, record.location);
  return {
    path: placement.path,
    system: placement.system === LOCAL_SYSTEM_ID
      ? localSystem()
      : await systemById(placement.system, placement.remoteId, `project '${name}'`),
  };
}

// THE CHEAP LOCAL PREFIX OF resolveProjectDir, and a CACHE KEY rather than an
// answer: a string that changes whenever a project's placement changes.
//
// IT NEVER REACHES A SYSTEM, and never throws. Its caller is the plugin
// catalog's per-compose freshness check (src/plugins/contributions.ts), so a
// version that resolved the system would throw on every compose while a box was
// down and flip that catalog permanently degraded. Being lossy is safe here and
// nowhere else: a wrong token only costs a recomputation, and the recomputation
// is what runs the real, refusing resolution above.
export async function placementToken(name: string): Promise<string> {
  let record: ProjectRecord | null;
  try { record = await readProjectRecord(name); }
  catch { return `${LOCAL_SYSTEM_ID}\0\0unreadable`; }
  if (!record) return `${LOCAL_SYSTEM_ID}\0\0gone`;
  const p = placementOf(name, record.location);
  return `${p.system}\0${p.remoteId ?? ''}\0${p.path}`;
}

// resolveProjectDir for the LISTINGS, where a refusal is a VALUE rather than a
// throw — the enrichment half of the promise listProjects already makes for its
// own enumeration, that one bad entry never takes the page down.
//
// It resolves the whole PROJECT, not just its system, because "can these git
// facts be measured?" is exactly "does this project resolve?": a record naming a
// reachable system but carrying no path resolves its SYSTEM fine and still has
// no tree to measure, and a row whose facts were quietly measured against an
// empty path would be wrong rather than absent.
//
// It catches everything, not just the refusals: a listing that must render the
// rest of the list has the same duty for an unexpected fault as for an expected
// one.
export async function tryResolveProject(
  name: string,
): Promise<{ system: System | null; unreachable: string | null }> {
  try {
    const resolved = await resolveProjectDir(name);
    return { system: resolved?.system ?? localSystem(), unreachable: null };
  } catch (e) {
    return { system: null, unreachable: e instanceof Error ? e.message : String(e) };
  }
}

// "Is this name usable?" — the shared existing-name test for the two creation
// paths (createProject, adoptProject). Returns null when the name is free, else
// a reason naming what holds it. A NAME WITH A RECORD IS HELD, whatever state
// that record is in: the repair for an unreadable one is to delete the project,
// not to pick a different explanation.
async function heldNameReason(name: string): Promise<string | null> {
  let held: ProjectRecord | null;
  try { held = await readProjectRecord(name); }
  catch (e) {
    return `project '${name}' already exists but its record could not be read (${errMsg(e)}) — `
      + `delete it to unregister the name, or pick another name.`;
  }
  return held ? `project '${name}' already exists at ${held.location.path}.` : null;
}

// THE PROJECT LIST, derived from the STORE and nothing else. A directory under
// the projects root is not a project unless a record says so, which is what
// lets the root hold grouping directories, `.worktrees/` and `.plugins/`
// without any of them surfacing as a project.
export async function listProjects(
  { includeConduct = false }: { includeConduct?: boolean } = {},
): Promise<ProjectInfo[]> {
  const projectsDir = path.join(orchStoreRoot(), 'projects');
  let names: string[];
  try { names = (await fs.readdir(projectsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch (e) { if (errCode(e) === 'ENOENT') return []; throw e; }
  const out: ProjectInfo[] = [];
  for (const name of names) {
    // A hand-made directory under an unusable name has no project behind it.
    try { validateName(name); } catch { continue; }
    // `.conduct` is where conductor sessions run, not a project anyone browses.
    // The session-locating callers opt back in rather than re-synthesising it.
    if (name === CONDUCT_PROJECT_NAME && !includeConduct) continue;
    let record: ProjectRecord | null;
    try { record = await readProjectRecord(name); }
    catch (e) {
      // The row must not vanish: its name is known without parsing the file,
      // and an invisible project is an undeletable one.
      out.push({
        name, path: '', workspace: null,
        system: LOCAL_SYSTEM_ID, remoteId: null, degraded: errMsg(e),
      });
      continue;
    }
    // A store directory left behind by a deleted project (attachments, debug
    // captures) holds no record and is not a registration.
    if (!record) continue;
    const placement = placementOf(name, record.location);
    out.push({
      name, path: placement.path, workspace: record.workspace,
      system: placement.system, remoteId: placement.remoteId,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Finds the listProjects() entry that IS this running conductor install, by
// comparing realpaths (handles symlinked checkouts). Returns null if this
// install isn't a direct child of projectsRoot() — e.g. running from an
// unmerged worktree, which listProjects() already excludes — callers must
// treat null as "skip silently," never guess which project is self.
// `selfDir` is only ever overridden by tests.
export async function findSelfProject(selfDir: string = SELF_PROJECT_DIR): Promise<ProjectInfo | null> {
  let selfReal: string;
  try { selfReal = await fs.realpath(selfDir); } catch { return null; }
  for (const p of await listProjects()) {
    // A row the resolver refuses carries no path (the listing keeps it visible
    // with an empty one), so there is nothing to compare and nothing to ask a
    // system about — probing it would send a relative path across the wire.
    // Skipped explicitly rather than left to the catch below, which exists for a
    // vanished target, not for a row that was never resolvable.
    const { system } = await tryResolveProject(p.name);
    if (!system || !p.path) continue;
    let real: string;
    try { real = await system.realpath(p.path); } catch { continue; }
    if (real === selfReal) return p;
  }
  return null;
}

// One-time boot seed: place the conductor's own project into `workspaceName`
// if it isn't assigned anywhere yet. No-op if self can't be identified or is
// already assigned — never overrides a deliberate move. Returns the assigned
// project name, or null if nothing was done.
export async function ensureSelfProjectWorkspace(workspaceName: string, selfDir: string = SELF_PROJECT_DIR): Promise<string | null> {
  const self = await findSelfProject(selfDir);
  if (!self || self.workspace != null) return null;
  await writeProjectMeta(self.name, { workspace: workspaceName });
  await addWorkspace(workspaceName);
  return self.name;
}

// Note for maintainers: this validates the *existing* name as well as a new
// one — removeWorkspace/renameWorkspace both run it on their `oldName` arg.
// So a workspace stored under a name that predates a tightening of
// WORKSPACE_RE becomes undeletable and unrenameable through the API;
// recovery is hand-editing `<store>/workspaces.json` plus the `workspace`
// field in each member's `<store>/projects/<name>/project.json`. No live
// name is in that state — the constraint is recorded so a future tightening
// doesn't strand one silently.
export function validateWorkspace(workspace: unknown): string | null {
  if (workspace === null) return null;
  if (typeof workspace !== 'string') {
    throw httpError(400, 'workspace must be a string or null');
  }
  const trimmed = workspace.trim();
  if (trimmed === '') return null;
  if (!WORKSPACE_RE.test(trimmed)) {
    throw httpError(400, 'invalid workspace name (1–40 chars; letters, digits, `.`, `_`, `-` only, and cannot start with `.`)');
  }
  return trimmed;
}

// WHERE A PROJECT LIVES — the one stored answer, and the presence of it in
// `<store>/projects/<name>/project.json` IS the registration. There is no
// second artefact (no in-root directory, no symlink) for any kind of project.
export type ProjectLocation =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; system: string; remoteId: string | null; path: string };

export interface ProjectRecord {
  workspace: string | null;
  location: ProjectLocation;
}

function recordFile(name: string): string {
  return path.join(projectStoreDir(name), 'project.json');
}

function malformed(file: string, why: string): Error {
  return httpError(500, `project record ${file} is malformed: ${why} — repair the file, or remove the project's store directory to unregister it.`);
}

// Read the project's record. `null` means NOT REGISTERED (no file).
//
// A file that exists and cannot be understood THROWS. Degrading it to an empty
// record — which is what this did when an in-root directory registered a
// project independently — would now silently unregister a live project, so the
// refusal is loud and its status is 500, never 404.
export async function readProjectRecord(name: string): Promise<ProjectRecord | null> {
  validateName(name);
  const file = recordFile(name);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw malformed(file, errMsg(e));
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch (e) { throw malformed(file, errMsg(e)); }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw malformed(file, 'the record is not a JSON object');
  }
  const rec = obj as { workspace?: unknown; location?: unknown };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const loc = rec.location;
  if (typeof loc !== 'object' || loc === null || Array.isArray(loc)) {
    throw malformed(file, 'it has no `location`');
  }
  const l = loc as { kind?: unknown; system?: unknown; remoteId?: unknown; path?: unknown };
  const p = str(l.path);
  if (!p) throw malformed(file, 'its `location` has no `path`');
  if (l.kind === 'local') {
    return { workspace: str(rec.workspace), location: { kind: 'local', path: p } };
  }
  if (l.kind === 'remote') {
    const system = str(l.system);
    if (!system) throw malformed(file, 'a remote `location` names no `system`');
    return {
      workspace: str(rec.workspace),
      location: { kind: 'remote', system, remoteId: str(l.remoteId), path: p },
    };
  }
  throw malformed(file, `unknown location kind ${JSON.stringify(l.kind)}`);
}

// Which projects name a NON-LOCAL system, grouped by system id — the
// still-referenced check behind Settings → Systems' delete refusal.
//
// Each entry carries its TARGET as well as its name: one system can serve ten
// containers, and "shipping" alone does not tell the reader which of them holds
// the row open.
export async function projectsBySystem(): Promise<Record<string, Array<{ name: string; remoteId: string | null }>>> {
  const out: Record<string, Array<{ name: string; remoteId: string | null }>> = {};
  for (const { name, system, remoteId, degraded } of await listProjects()) {
    if (degraded || system === LOCAL_SYSTEM_ID) continue;
    (out[system] ??= []).push({ name, remoteId });
  }
  return out;
}

// Write the project's workspace. Atomic rename to avoid torn reads if the
// process dies mid-write. Existence-checked: a record is never MADE by a
// workspace assignment — registerProject is the only thing that mints one.
export async function writeProjectMeta(
  name: string,
  patch: { workspace?: string | null },
): Promise<ProjectRecord> {
  validateName(name);
  await getProject(name);
  return writeProjectRecord(name, patch);
}

// The record write. Module-private and never unlinks the file: with presence of
// the record as the registration, removing it IS unregistering the project, and
// that is `removeProjectStoreDir`'s job alone.
async function writeProjectRecord(
  name: string,
  patch: { workspace?: string | null; location?: ProjectLocation },
): Promise<ProjectRecord> {
  const current = await readProjectRecord(name);
  const location = patch.location ?? current?.location;
  if (!location) {
    throw httpError(500, `cannot write a record for project '${name}' without a location`);
  }
  const workspace = 'workspace' in patch
    ? validateWorkspace(patch.workspace)
    : current?.workspace ?? null;
  const next: ProjectRecord = { workspace, location };
  const onDisk: Record<string, unknown> = { ...(workspace ? { workspace } : {}), location };
  await writeFileAtomic(recordFile(name), JSON.stringify(onDisk, null, 2) + '\n');
  return next;
}

// THE ONE GUARDED WRITER the whole record model rests on: every path that
// brings a project into existence — create, adopt, a Library install, the
// `.conduct` bootstrap — comes through here, so a guard enforced here is an
// INVARIANT rather than a per-surface habit.
//
// Reserved names are the guard that could not live at the surfaces: MCP
// `create_project` reaches createProject through `validateName` alone, which
// deliberately admits dot-leading names because `.conduct` is one. Without this
// refusal, `create_project({name:'.worktrees'})` mints a project occupying
// localWorktreesRoot(); every subsequent worktree of every project is then
// created inside that project's tree, and deleting it with `deleteDirectory`
// removes every checkout at once. `.plugins` is symmetric.
export async function registerProject(name: string, location: ProjectLocation): Promise<ProjectRecord> {
  validateName(name);
  if (name.startsWith('.') && name !== CONDUCT_PROJECT_NAME) {
    throw httpError(400, `invalid project name '${name}' (cannot start with "." — reserved for orchestrator-managed projects)`);
  }
  const held = await heldNameReason(name);
  if (held) throw httpError(409, held, { code: 'PROJECT_EXISTS' });
  const why = await projectKeyCollisionReason(
    location.kind === 'remote' ? location.system : LOCAL_SYSTEM_ID,
    location.kind === 'remote' ? location.remoteId : null,
    name, location.path);
  if (why) throw httpError(409, why, { code: 'TRANSCRIPT_DIR_COLLISION' });
  return writeProjectRecord(name, { location });
}

// ── Workspace registry ────────────────────────────────────────────────
// Workspace existence is persisted independently of membership. A
// workspace with zero member projects still exists if its name appears
// in `<store>/workspaces.json`. Membership remains stored per-project on
// `project.workspace`; the registry is the union source so empty
// workspaces survive the last member leaving.

function workspacesFile(): string {
  return path.join(orchStoreRoot(), 'workspaces.json');
}

export async function listWorkspaces(): Promise<string[]> {
  try {
    const raw = await fs.readFile(workspacesFile(), 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return [];
    const list = (obj as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const v of list) {
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (t) out.push(t);
    }
    return [...new Set(out)].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    console.warn(`projects: failed to read ${workspacesFile()}: ${errMsg(e)}`);
    return [];
  }
}

export interface WorkspaceSummary {
  name: string;
  projectCount: number;
}

// The sidebar workspace summary: the union of registered workspace names and
// names derived from project membership, each with its member count, sorted by
// name. Shared by the REST GET /workspaces route and the MCP list_workspaces
// tool so the union/count logic lives in one place.
export async function summarizeWorkspaces(): Promise<WorkspaceSummary[]> {
  const registered = await listWorkspaces();
  const projects = await listProjects();
  const derived = new Set<string>();
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (p.workspace) {
      derived.add(p.workspace);
      counts.set(p.workspace, (counts.get(p.workspace) ?? 0) + 1);
    }
  }
  const names = [...new Set([...registered, ...derived])].sort((a, b) => a.localeCompare(b));
  return names.map(name => ({ name, projectCount: counts.get(name) ?? 0 }));
}

async function writeWorkspacesRegistry(names: string[]): Promise<string[]> {
  const file = workspacesFile();
  const cleaned = [...new Set(names.map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (cleaned.length === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return cleaned;
  }
  await writeFileAtomic(file, JSON.stringify({ workspaces: cleaned }, null, 2) + '\n');
  return cleaned;
}

export async function addWorkspace(name: string): Promise<{ added: boolean; name: string }> {
  const v = validateWorkspace(name);
  if (!v) {
    throw httpError(400, 'workspace name is required');
  }
  const current = await listWorkspaces();
  if (current.includes(v)) return { added: false, name: v };
  await writeWorkspacesRegistry([...current, v]);
  return { added: true, name: v };
}

// Remove a workspace from the registry and clear the `workspace` field
// on every project that currently points at it. The projects themselves
// are untouched — they just fall back to unassigned.
export async function removeWorkspace(name: string): Promise<{ removed: boolean; name: string; clearedProjects: string[] }> {
  const v = validateWorkspace(name);
  if (!v) {
    throw httpError(400, 'workspace name is required');
  }
  const projects = await listProjects();
  const members = projects.filter(p => p.workspace === v).map(p => p.name);
  for (const m of members) {
    try { await writeProjectMeta(m, { workspace: null }); }
    catch (e) { console.warn(`removeWorkspace: failed clearing '${m}': ${errMsg(e)}`); }
  }
  const current = await listWorkspaces();
  const filtered = current.filter(n => n !== v);
  const removed = filtered.length !== current.length;
  if (removed) await writeWorkspacesRegistry(filtered);
  return { removed: removed || members.length > 0, name: v, clearedProjects: members };
}

// Atomically rename a workspace: rewrite every member project's
// `workspace` field and swap the entry in the registry.
export async function renameWorkspace(oldName: string, newName: string): Promise<{ renamed: boolean; name: string; movedProjects: string[] }> {
  const oldV = validateWorkspace(oldName);
  const newV = validateWorkspace(newName);
  if (!oldV || !newV) {
    throw httpError(400, 'both old and new workspace names are required');
  }
  if (oldV === newV) return { renamed: false, name: newV, movedProjects: [] };
  const current = await listWorkspaces();
  if (!current.includes(oldV)) {
    throw httpError(404, `workspace '${oldV}' not found`);
  }
  const projects = await listProjects();
  const members = projects.filter(p => p.workspace === oldV).map(p => p.name);
  for (const m of members) {
    try { await writeProjectMeta(m, { workspace: newV }); }
    catch (e) { console.warn(`renameWorkspace: failed rewriting '${m}': ${errMsg(e)}`); }
  }
  const next = [...new Set(current.filter(n => n !== oldV).concat(newV))];
  await writeWorkspacesRegistry(next);
  return { renamed: true, name: newV, movedProjects: members };
}

// Why registering PROJECT `name` would put two places in one CLI transcript
// directory, or null when it would not. Both creation paths ask, because a name
// can be free and its cwd still collide: a project named `p_worktree_w` lands
// where worktree `w` of project `p` does. createWorktree asks the same
// predicate directly for the other half of the pair.
//
// Lazy import for the projects.ts ↔ systems/transcriptKey.ts circular edge:
// that module enumerates places through listProjects, which lives here.
async function projectKeyCollisionReason(
  systemId: string, remoteId: string | null, name: string, cwd: string,
): Promise<string | null> {
  const { transcriptCollisionReason, transcriptCwdCollision } =
    await import('./systems/transcriptKey.ts');
  const candidate = { project: name, worktree: null, system: systemId, remoteId, cwd };
  const hit = await transcriptCwdCollision(candidate);
  return hit === null ? null : transcriptCollisionReason(`project '${name}'`, candidate, hit);
}

export async function createProject(
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
): Promise<{ name: string; path: string; system: string; remoteId: string | null }> {
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
  // Every project is a git repo from birth — worktrees, diffs and commits are
  // the whole workflow. The mkdir above proves the dir is brand new, so there
  // is nothing to clobber and no repo check to make: isGitRepo() walks UP, so
  // it would answer "yes" for this empty dir whenever the projects root itself
  // sits inside a repo, and skip the init. Dynamic import because worktrees.ts
  // statically imports this module (as with listWorktrees below).
  const { runGit } = await import('./worktrees.ts');
  const init = await runGit(system, full, ['init', '-q']);
  if (init.code !== 0) {
    throw httpError(500, `git init failed in ${full}: ${init.stderr.trim() || init.stdout.trim()}`);
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
  await commitScaffold(system, full, runGit, scaffolded);
  return { name, path: full, system: system.id, remoteId: system.remoteId };
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
    // anything is staged. An ambient `GIT_DIR` already sends the `git init`
    // above to a foreign repo (a pre-existing dent, pinned by `createProject
    // fails loudly when git init fails`), and without this check the staging
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
    if (where.code !== 0 || gitDir !== path.join(real, '.git') || topLevel !== real) {
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

// The most a caller may name a target with. DELIBERATELY NOT `isSlug`: a remote
// id is a container name, a hostname or a VM id, and those legitimately carry
// `_` and `.`. What is refused is what cannot survive being a wire field or
// cannot be told apart from a mistake — nothing, whitespace, a control
// character, or a length no real identifier has.
export const REMOTE_ID_MAX = 128;

export function validateRemoteId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw httpError(400, 'remoteId must be a string or null');
  const t = v.trim();
  if (t === '') return null;
  if (t.length > REMOTE_ID_MAX) {
    throw httpError(400, `remoteId is ${t.length} characters, above the ${REMOTE_ID_MAX}-character limit`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(t)) {
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
// src/routes.ts). Sessions under ~/.claude/projects/<encoded>/ are
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
  try { await fs.rm(projectStoreDir(name), { recursive: true, force: true }); }
  catch { /* best-effort */ }
}

// Carries the System handle so a caller that has the project has everything it
// needs to operate on the tree. NOT the serialised project shape — that is
// ProjectInfo, which stays a plain record (both REST and MCP spread it into a
// response body).
export interface ResolvedProject {
  name: string;
  path: string;
  system: System;
}

export async function getProject(name: string): Promise<ResolvedProject> {
  validateName(name);
  const resolved = await resolveProjectDir(name);
  if (!resolved) throw httpError(404, `project '${name}' not found`);
  return { name, path: resolved.path, system: resolved.system };
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

export async function adoptProject(
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
  // the same rule in routes.ts; this one lives in the shared function so both
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
    if (p.system === wantSystem && p.remoteId === wantRemote && p.path === real) {
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
  // Do not merge the probes and do not reorder them. Keeping the second inside
  // the `else` holds the common repo-root path to one exec, and a system with no
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
  const { runGit, isGitRepo } = await import('./worktrees.ts');
  const top = await runGit(system, real, ['rev-parse', '--show-toplevel']);
  if (top.code === 0) {
    let topReal = top.stdout.trim();
    try { topReal = await system.realpath(topReal); } catch { /* compare what git printed */ }
    if (topReal !== real) {
      return {
        ok: false, code: 'TARGET_INSIDE_REPO',
        reason: `'${real}' is inside the git repository whose toplevel is '${topReal}' — adopt that instead.`,
      };
    }
  } else if (await isGitRepo(system, real)) {
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

export async function readFirstPrompt(jsonlPath: string): Promise<string | null> {
  const fh = await fs.open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj !== 'object' || obj === null) continue;
      const rec = obj as { type?: unknown; message?: unknown; lastPrompt?: unknown };
      if (rec.type === 'user' && rec.message != null) {
        const c = (rec.message as { content?: unknown }).content;
        if (typeof c === 'string') return c.slice(0, 200);
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 200);
          }
        }
      }
      if (rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') return rec.lastPrompt.slice(0, 200);
    }
    return null;
  } finally {
    await fh.close();
  }
}

export interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  title: string | null;
  conducted: boolean;
  temp: boolean;
  archived: boolean;
  // Epoch ms of the timestamp on the session's last timestamped record — see
  // sessionActivity.ts for why this is not the transcript's mtime.
  lastActivity: number;
  size: number;
  // What `spawn_instance({resume})` would actually come up as — the recorded
  // mode, or DEFAULT_RESUME_MODE when there is none. Always the EFFECTIVE
  // value, never the raw record: a consumer that rendered "no record" as "not
  // hot" would tell a reader a hot resume is safe.
  resumeMode: string;
}

// One directory walk answering both "which sessions are here" and "how many of
// them are archived". A caller that needs the count as well as the rows must
// use this rather than pairing listSessionsForCwd with summarizeSessions: that
// pairing costs a second readdir, a second stat of every transcript and a
// second archived-set load, for a number this walk already has in hand.
// Archived rows are counted before the includeArchived filter, so the count is
// the same either way — but their `firstPrompt` is only read when they are
// actually being listed, which is where the per-transcript cost lives.
export async function listSessionsForCwdWithCounts(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
  { includeArchived = true }: { includeArchived?: boolean } = {},
): Promise<{ rows: SessionRow[]; archivedCount: number }> {
  const dir = path.join(transcriptRoot(place), encodeCwd(place.cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { rows: [], archivedCount: 0 };
    throw e;
  }
  const titles = await loadAllTitles();
  const conducted = await loadAllConducted();
  const temps = await loadAllTemps();
  const archived = await loadAllArchived();
  // One bulk read per scanned cwd, like the four sidecars above — never a file
  // open per session.
  const modes = await loadAllSessionModes();
  // Sixth bulk load, same rule. Lazy import: sessionLineage.ts imports
  // orchStoreRoot() from here, so a static edge would close a cycle.
  const { loadLineage } = await import('./sessionLineage.ts');
  const lineage = await loadLineage();
  const out: SessionRow[] = [];
  let archivedCount = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    // The exclusion filter runs BEFORE the projection, deliberately: both
    // tempSessionIdsForPlace and liveBackingIdsForPlace yield backing ids, because
    // what they exclude is a FILE. Projecting first would make every set miss.
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    const isArchived = archived.has(sid);
    const full = path.join(dir, name);
    // Stat before the archived branch: the count must include only real files,
    // and it is the same stat a listed row needs anyway.
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (isArchived) {
      archivedCount++;
      if (!includeArchived) continue;
    }
    let firstPrompt: string | null = null;
    try { firstPrompt = await readFirstPrompt(full); } catch { /* ignore */ }
    out.push({
      // The one projected field. Every sidecar below stays keyed to the FILENAME
      // — that is what they are keyed to on disk, and re-keying them would have
      // needed a migration, deliberately not written.
      sessionId: projectRowId(sid, lineage),
      firstPrompt,
      title: titles.get(sid) ?? null,
      conducted: conducted.has(sid),
      temp: temps.has(sid),
      archived: isArchived,
      lastActivity: await lastActivityOf(full, stat),
      size: stat.size,
      resumeMode: effectiveResumeMode(modes.get(sid) ?? null),
    });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return { rows: out, archivedCount };
}

export async function listSessionsForCwd(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
  opts: { includeArchived?: boolean } = {},
): Promise<SessionRow[]> {
  return (await listSessionsForCwdWithCounts(place, excludeSessionIds, opts)).rows;
}

export async function listSessions(projectName: string, excludeSessionIds: Set<string> | null = null): Promise<SessionRow[]> {
  const proj = await getProject(projectName);
  return listSessionsForCwd(await projectRootPlace(projectName, proj.path), excludeSessionIds);
}

// The transcript placement of a project's OWN tree (not a worktree's): the
// record's machine coordinate, with the resolved path as the cwd. One home for
// the join, so a caller cannot pair a project's path with another's placement.
export async function projectRootPlace(projectName: string, treePath: string): Promise<TranscriptPlacement> {
  // An unregistered name has no record to read a coordinate from, and resolves
  // to cc's own machine — the same answer `resolveSystem` gives it.
  const placement = await projectPlacement(projectName);
  return placement ? placeOf(placement, treePath) : localPlace(treePath);
}

// Archive the session at the conventional path: keep the jsonl (so it
// stays resumable) and just record the sessionId in the global archived
// set. Title + conducted markers are intentionally kept so a restore
// brings the session back intact. Returns true on success, false if the
// jsonl didn't exist (404 path from the route). This is the single
// "remove from the normal list" action — it never deletes from disk.
export async function archiveSessionForCwd(place: TranscriptPlacement, sessionId: string): Promise<boolean> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return false; // unknown session — the route's 404
  const file = sessionFilePath(place, backingId);
  try {
    await fs.access(file);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
  await markArchived(backingId);
  return true;
}

// Permanently remove the persisted session jsonl at the conventional
// path. Returns true on success, false if the file didn't exist (404
// path from the route). This is the ONLY code path that deletes a
// session jsonl from disk; it is reachable only from the explicit
// per-session Delete on the Settings → Archived page. Caller is
// responsible for killing any running instance attached to this
// sessionId first.
export async function deleteSessionForCwd(place: TranscriptPlacement, sessionId: string): Promise<boolean> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return false; // unknown session — the route's 404
  const file = sessionFilePath(place, backingId);
  try {
    await fs.unlink(file);
    try { await deleteSessionTitle(backingId); } catch { /* sidecar cleanup is best-effort */ }
    try { await unmarkConducted(backingId); } catch { /* sidecar cleanup is best-effort */ }
    try { await unmarkArchived(backingId); } catch { /* sidecar cleanup is best-effort */ }
    try { await unmarkSessionMode(backingId); } catch { /* sidecar cleanup is best-effort */ }
    // Chain integrity: the transcript this segment named is gone for good, so drop
    // it from its lineage row rather than leave `current`/`segments` pointing at a
    // missing file. Deliberately on the DELETE path, not on reads — a write inside
    // a read path races concurrent readers.
    try { const { dropSegment } = await import('./sessionLineage.ts'); await dropSegment(backingId); }
    catch { /* best-effort */ }
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
}

// The two lazy worktrees imports below sit on a circular edge
// (projects ↔ worktrees) that must stay lazy — worktrees.ts already imports
// from projects.ts (encodeCwd, etc.). The dynamic import is typed via the
// static `import type` above, so it stays lazy at runtime with no cast.
async function loadWorktreesFor(projectName: string): Promise<WorktreeMeta[]> {
  const { listWorktrees } = await import('./worktrees.ts');
  return listWorktrees(projectName);
}

// ONE PLACE a session could have run: a project or one of its worktrees, and
// the cwd it admits. A LIST rather than a string because the probe walks it, and
// because a place that cannot be located contributes an empty one.
interface SessionPlace {
  project: string;
  worktreeName: string | null;
  primary: TranscriptPlacement[];
}

// What a hit reports. `place` is the full coordinate the transcript was found
// at — a caller that goes on to READ that transcript needs it, because `cwd`
// alone no longer names a directory.
export interface SessionLocation {
  project: string;
  worktreeName: string | null;
  cwd: string;
  place: TranscriptPlacement;
}

// Look up which project (and optionally which worktree) owns a given
// sessionId, and the cwd its transcript was actually found at, by probing the
// conventional `<transcriptRoot(place)>/<encoded-cwd>/<sid>.jsonl` path against
// every place every known project + worktree admits. Returns a SessionLocation
// on hit, null when nothing matches.
// `encodeCwd` is one-way (lossy: '_' and '/' both collapse to '-'), so
// we can't reverse-map a directory name back to a project — enumerating
// known paths and probing is the only correct approach.
//
// `cwd` IS THE ANSWER, not a convenience: a caller that re-derives it from the
// project's tree path lands on the OTHER MACHINE for a project on a system, and
// then reads an empty transcript. It is REQUIRED for that reason — an optional
// field invites `hit.cwd ?? proj.path`, which is precisely the bug this fixes
// It is NOT a public field: `GET /sessions/:id/locate`
// projects the body explicitly so it stays in-process.
//
// WHICH CWD A PLACE ADMITS is the same question wherever its tree is: the CLI
// runs at the place's own path, on whatever machine that is — exactly one
// candidate per place.
//
// ONE PASS: the place's own path is the primary and only candidate.
// WHAT THIS NEEDS FROM THE SYSTEM. THE ONE HOME for this contract — the sites
// that care (`src/mcp/handlers.ts`'s disk branch, `docs/architecture.md`,
// tests/systems-remote-session-location.test.mjs) point here instead of keeping
// their own copy, because two comfortable summaries are both FALSE and a third
// paraphrase is how the last two got written:
//   NOT "it never touches the box" — `loadWorktreesFor` reaches for it.
//   NOT "a box that is down cannot change what this returns" — it can.
//
// Almost every candidate cwd is computed from cc's own store and disk:
// `listProjects` (store-derived for a remote row) and `worktreePathFor` — and
// the transcripts are on cc's own disk, because the CLI is always local even
// when its cwd names another machine's tree. ONE INPUT IS NOT, the WORKTREE STORE. `loadWorktreesFor` is
// `listWorktrees`, which runs `git worktree list` THROUGH the project's system
// and then lets the answer PRUNE any registration the box no longer reports,
// while SWALLOWING the box's refusal when it cannot answer (so every
// registration lists). Consequences, both real:
//   - A DOWN box SURFACES a worktree place a HEALTHY box PRUNES. The box's git
//     answer is data this lookup consumes, and losing it changes the answer
//     rather than only costing a swallowed failure.
//   - A WEDGED box can stall this lookup up to DEFAULT_OP_TIMEOUT_MS
//     (src/systems/providerSystem.ts) — one exec per project on that box,
//     measured. Bounded, not removed.
// The lazy composition below is what keeps both off a lookup that a nearer
// place already answers.
export async function findSessionLocation(sessionId: string): Promise<SessionLocation | null> {
  // Permissive validation: sessionIds are UUIDs in practice but we accept
  // anything that's safe to interpolate into a filename. The point is to
  // reject path-traversal payloads before they touch the filesystem.
  if (!isSessionId(sessionId)) return null;
  // Resolve ONCE, here, rather than at each of the four call sites — they pass
  // mixed provenance (a conductor's public id, a REST path param, a segment id
  // off an archived row, an already-backing id from _doCreate) and this is the
  // one home that can normalise all of them.
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return null; // unknown session, not an error

  // `.conduct` is included: conductor sessions live there and must still be
  // locatable for summaries/staleness-checks/locate. It is a registered project
  // like any other now, so it is an opt-in on the listing rather than a
  // hand-rolled synthesis.
  const projects: ProjectInfo[] = await listProjects({ includeConduct: true });

  // One place, one cwd, whatever machine it is on. Under the FUSE-union geometry
  // a remote session runs at the project's real path on its system, and a remote
  // row's `path` IS that path (listProjects) — so local and remote compose
  // identically and there is no search space to enumerate any more.
  //
  // THE MACHINE COORDINATE TRAVELS WITH THE CWD. `/root/app3` is the same cwd on
  // two different boxes, so a place that carried only its path would probe one
  // remote's transcripts for another remote's session and answer with the wrong
  // project.
  const compose = async (
    proj: ProjectInfo, worktreeName: string | null, treePath: string,
  ): Promise<SessionPlace> => ({
    project: proj.name, worktreeName, primary: [placeOf(proj, treePath)],
  });

  // THE PLACE LIST IS COMPOSED LAZILY, IN PROBE ORDER, AND MEMOISED — and the
  // laziness is load-bearing rather than a micro-optimisation. Composing a
  // project's WORKTREE places calls `loadWorktreesFor` = `listWorktrees`, which
  // resolves the project and runs `git worktree list` THROUGH ITS SYSTEM: for a
  // project on a remote system that is a real `exec` over the provider wire. An
  // eager list would therefore put every registered system's responsiveness on
  // the critical path of a lookup that a nearer place already answers, so one
  // wedged provider would stall every locate, transcript read, summary and bare
  // resume up to the operation timeout. Pass 1 composes a place only when the
  // sweep reaches it, exactly as the pre-session-root probe did.
  //
  // The memo means a place is composed AT MOST ONCE per lookup, so pass 2 and
  // the read-tolerance loop do not re-walk. Nothing depends on that beyond
  // cost: pass 2 runs only when pass 1 missed everywhere, which is precisely
  // the case that has already composed every place.
  const rootMemo: Array<SessionPlace | undefined> = new Array(projects.length);
  const rootPlace = async (i: number): Promise<SessionPlace> => {
    const cached = rootMemo[i];
    if (cached) return cached;
    const proj = projects[i];
    const built = await compose(proj, null, proj.path);
    rootMemo[i] = built;
    return built;
  };
  const worktreeMemo: Array<SessionPlace[] | undefined> = new Array(projects.length);
  const worktreePlaces = async (i: number): Promise<SessionPlace[]> => {
    const cached = worktreeMemo[i];
    if (cached) return cached;
    const proj = projects[i];
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* project may not be a git repo, skip */ }
    const built: SessionPlace[] = [];
    // A worktree's offsets come from the WORKTREE's own path on the system, not
    // its project's: the two differ under a mirror root wider than the project.
    for (const wt of wts) built.push(await compose(proj, wt.worktreeName, wt.worktreePath));
    worktreeMemo[i] = built;
    return built;
  };

  const probe = async (id: string): Promise<SessionLocation | null> => {
    const holds = async (at: TranscriptPlacement): Promise<boolean> => {
      try {
        return (await fs.stat(sessionFilePath(at, id))).isFile();
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
        return false;
      }
    };
    const first = async (place: SessionPlace, ats: TranscriptPlacement[]) => {
      for (const at of ats) {
        if (await holds(at)) {
          return { project: place.project, worktreeName: place.worktreeName, cwd: at.cwd, place: at };
        }
      }
      return null;
    };
    for (let i = 0; i < projects.length; i++) {
      // The project's own place BEFORE its worktrees, so a hit at a project root
      // does not pay that project's OWN worktree walk either — the within-project
      // half of the same invariant, and the half a per-project eager build would
      // lose silently. Its observable consequence (no frame reaches that
      // project's box) is pinned by T13 in
      // tests/systems-remote-session-location.test.mjs.
      const root = await rootPlace(i);
      const atRoot = await first(root, root.primary);
      if (atRoot) return atRoot;
      for (const pl of await worktreePlaces(i)) {
        const atWt = await first(pl, pl.primary);
        if (atWt) return atWt;
      }
    }
    return null;
  };

  const hit = await probe(backingId);
  if (hit) return hit;

  // READ TOLERANCE. `current`'s transcript can vanish without going through our
  // delete path — Claude prunes its own ~/.claude/projects after ~30 days. Walk
  // the row's segments newest-first and locate the first one that still exists, so
  // a session with a surviving older segment stays findable. Read-only on purpose:
  // self-pruning here would put a write inside a hot read path and race concurrent
  // readers (the delete path and loadHistory's ENOENT branch own the pruning).
  const { publicIdFor, segmentsFor } = await import('./sessionLineage.ts');
  const segments = await segmentsFor(await publicIdFor(sessionId));
  for (let i = segments.length - 1; i >= 0; i--) {
    const id = segments[i].id;
    if (id === backingId || isMintedPublicId(id)) continue;
    const older = await probe(id);
    if (older) return older;
  }
  return null;
}

// Does a transcript for `sessionId` exist ANYWHERE under any transcript root cc
// knows about — the local one or any registered remote's — including under an
// encoded-cwd directory no registered project or worktree owns? Returns the
// absolute path on hit, null otherwise.
//
// Existence only — deliberately NOT a route to the content. `encodeCwd` is
// one-way (see its note above: '_' and '/' both collapse to '-'), so the
// directory name this finds cannot be reversed into the `cwd` that
// `loadPersistedTranscript` requires. A caller can therefore say "this session
// is retired and unreachable" instead of "no such session", which is all the
// distinguishability the refusal needs.
//
// Callers must reach this only AFTER findSessionLocation has already missed —
// it costs one readdir plus one stat per encoded-cwd dir, and that miss is
// itself the proof that no registered project or worktree owns the directory.
export async function findOrphanedTranscript(sessionId: string): Promise<string | null> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return null;
  for (const root of await transcriptRoots()) {
    let dirs: Dirent[];
    try { dirs = await fs.readdir(root, { withFileTypes: true }); }
    catch (e) { if (errCode(e) === 'ENOENT') continue; throw e; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(root, d.name, sessionFileName(backingId));
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) return file;
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

// EVERY transcript root cc knows about: the local one, plus one per registered
// remote. There is no single root any more, so the reverse scanner above has to
// be told where to look — left local-only it would answer "no such session" for
// every remote session, turning the informative SESSION_NOT_LIVE refusal into a
// bare SESSION_UNKNOWN exactly where a transcript does exist.
//
// Store reads only, like `registeredPlaces`: no System handle is taken, so a box
// being down cannot stop a refusal from being composed.
async function transcriptRoots(): Promise<string[]> {
  const roots = new Set<string>([claudeProjectsRoot()]);
  for (const proj of await listProjects()) {
    if (proj.system === LOCAL_SYSTEM_ID) continue;
    roots.add(transcriptRoot(placeOf(proj, proj.path)));
  }
  return [...roots];
}

export interface ArchivedSessionRow {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  lastActivity: number;
  size: number;
  worktreeName: string | null;
}

// List every archived session, grouped by the project (and worktree)
// that owns it. archived-sessions.json only stores sessionIds, so we
// enumerate known project + worktree paths and keep the rows
// listSessionsForCwd already flags as archived (it also reads firstPrompt
// + title). Used by the Settings → Archived page. Only projects with at
// least one archived session are returned; sessions are lastActivity-desc.
//
// DELIBERATELY passes no `excludeSessionIds`. The public-id work required that
// filter to run BEFORE the row projection wherever it is used (both exclusion sets
// yield backing ids, because what they exclude is a FILE) — but there is no filter
// to order here, and adding one would be wrong: both sets name LIVE sessions, and
// a live session's transcript is never in the archived set (archiving force-kills
// the instance first). So the archived view has nothing to exclude, and it keeps
// the behaviour it had before this change. The row ids it reports come already
// projected from listSessionsForCwd, whose rule keeps a SUPERSEDED segment's
// filename precisely so each archived transcript stays individually addressable
// for restore/delete — see projectRowId.
export async function listArchivedGroupedByProject(): Promise<{ project: string; sessions: ArchivedSessionRow[] }[]> {
  // `.conduct` is included here so its archived temp sessions are visible in
  // Settings → Archived — the same opt-in findSessionLocation makes.
  const projects: ProjectInfo[] = await listProjects({ includeConduct: true });

  const groups: { project: string; sessions: ArchivedSessionRow[] }[] = [];
  for (const proj of projects) {
    const sessions: ArchivedSessionRow[] = [];
    const projRows = (await listSessionsForCwd(placeOf(proj, proj.path))).filter(s => s.archived);
    for (const s of projRows) {
      sessions.push({
        sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
        lastActivity: s.lastActivity, size: s.size, worktreeName: null,
      });
    }
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* not a git repo, skip */ }
    for (const wt of wts) {
      const wtRows = (await listSessionsForCwd(placeOf(proj, wt.worktreePath))).filter(s => s.archived);
      for (const s of wtRows) {
        sessions.push({
          sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
          lastActivity: s.lastActivity, size: s.size, worktreeName: wt.worktreeName,
        });
      }
    }
    if (sessions.length > 0) {
      sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      groups.push({ project: proj.name, sessions });
    }
  }
  return groups;
}

// Lightweight session summary — used by /api/projects to show a count +
// "last active" stamp in the sidebar without paying the firstPrompt read
// listSessionsForCwd does on every jsonl.
//
// It reports the SAME recency value as the session rows underneath it, so a
// project's "last N ago" can't disagree with its own sessions. That costs a
// bounded tail read per transcript, but only on a transcript that changed
// since the last walk (lastActivityOf memoizes on the stat this loop already
// does) — so the steady-state fan-out across every project stays readdir +
// stat, which is the property this walk has always been protecting.
export async function summarizeSessions(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
): Promise<{ count: number; archivedCount: number; lastActivity: number }> {
  const dir = path.join(transcriptRoot(place), encodeCwd(place.cwd));
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch (e) { if (errCode(e) === 'ENOENT') return { count: 0, archivedCount: 0, lastActivity: 0 }; throw e; }
  const archivedSet = await loadAllArchived();
  let count = 0;
  let archivedCount = 0;
  let lastActivity = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (archivedSet.has(sid)) {
      archivedCount++;
    } else {
      count++;
      const ts = await lastActivityOf(full, stat);
      if (ts > lastActivity) lastActivity = ts;
    }
  }
  return { count, archivedCount, lastActivity };
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

