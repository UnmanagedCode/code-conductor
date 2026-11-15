// The project registry: name → record resolution, the project listing, the
// record writers and the workspace registry. src/projects.ts imports it and
// re-exports its public names, so it must never import src/projects.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from './httpError.ts';
import { markProjectsChanged, projectsOperation } from './projectsChanged.ts';
import { orchStoreRoot } from './storeRoot.ts';
import {
  NAME_RE, validateName, recordFile, readProjectRecord,
  type ProjectLocation, type ProjectRecord,
} from './projectRecord.ts';
import { CONDUCT_PROJECT_NAME, LOCAL_SYSTEM_ID, localSystem, placementOf, systemById } from './systems/registry.ts';
import { writeFileAtomic } from './systems/localSystem.ts';
import type { System } from './systems/system.ts';
import type { ProjectInfo } from '../shared/wireRows.ts';
import { samePath } from './platform/index.ts';
import { errCode, errMsg } from '../shared/basics.ts';

// The conductor's own repo root — one level up from src/, unlike
// DEFAULT_PROJECTS_ROOT (src/storeRoot.ts) which goes two levels up to the *parent* of
// the repo (where sibling projects, including this one, live).
const SELF_PROJECT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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
// (src/projectRecord.ts), which still admits `.hidden` because `.conduct` is a real project
// name; the dot-ONLY half of the hazard (`.` / `..`) is closed in
// validateName instead, since NAME_RE has no positional rules to close it in.
// Do NOT "restore parity" by loosening this regex — it reopens the hazard for
// workspaces, which have no `.conduct` case to accommodate.
const WORKSPACE_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,39}$/;



// The conductor's own running checkout dir (the dir holding server.ts /
// package.json). Exposed so the plugin supervisor can hand it to backends as
// CONDUCTOR_PROJECT_DIR — they surface the conductor as an app even when its
// checkout isn't under projectsRoot().
export function selfProjectDir(): string {
  return SELF_PROJECT_DIR;
}

// validateName for an argument that ADDRESSES an existing project (the MCP
// tools' `project`): same rule, but a regex failure names the valid form — the
// NAME list_projects prints, not the path a caller most often passes instead.
// validateName itself stays neutral, since it also guards names being created.
// A dot-only name SATISFIES the regex, so its path-traversal refusal passes
// through from validateName unchanged.
export function validateProjectRef(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw httpError(400, `invalid project name ${JSON.stringify(name)} — pass the project's NAME as list_projects prints it (^[a-zA-Z0-9._-]+$), not its path`);
  }
  return validateName(name);
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
export async function heldNameReason(name: string): Promise<string | null> {
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
    if (samePath(real, selfReal)) return p;
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
function validateWorkspace(workspace: unknown): string | null {
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
export async function writeProjectRecord(
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
  markProjectsChanged();
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
    try {
      await fs.unlink(file);
      markProjectsChanged();
    } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return cleaned;
  }
  await writeFileAtomic(file, JSON.stringify({ workspaces: cleaned }, null, 2) + '\n');
  markProjectsChanged();
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
// are untouched — they just fall back to unassigned. One `projects` signal
// for the whole removal, however many members it clears.
export function removeWorkspace(...args: Parameters<typeof removeWorkspaceSteps>) {
  return projectsOperation(() => removeWorkspaceSteps(...args));
}

async function removeWorkspaceSteps(name: string): Promise<{ removed: boolean; name: string; clearedProjects: string[] }> {
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
// `workspace` field and swap the entry in the registry. One `projects` signal
// for the whole rename.
export function renameWorkspace(...args: Parameters<typeof renameWorkspaceSteps>) {
  return projectsOperation(() => renameWorkspaceSteps(...args));
}

async function renameWorkspaceSteps(oldName: string, newName: string): Promise<{ renamed: boolean; name: string; movedProjects: string[] }> {
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

// Assign or clear a project's workspace, registering a newly named one: the one
// implementation behind REST PUT /projects/:name/workspace and MCP
// set_project_workspace, so the pair is one `projects` signal on both. "" and
// undefined clear it; workspace names are validated in writeProjectMeta.
export function setProjectWorkspace(name: string, workspace: unknown): Promise<{ name: string; workspace: string | null }> {
  return projectsOperation(async () => {
    if (name === CONDUCT_PROJECT_NAME) {
      throw httpError(400, 'the .conduct project cannot be assigned to a workspace');
    }
    const target = workspace === '' || workspace === undefined ? null : workspace;
    const meta = await writeProjectMeta(name, { workspace: target as string | null });
    if (meta.workspace) {
      try { await addWorkspace(meta.workspace); } catch { /* validateWorkspace already ran in writeProjectMeta */ }
    }
    return { name, workspace: meta.workspace ?? null };
  });
}

// Why registering PROJECT `name` would put two places in one CLI transcript
// directory, or null when it would not. Both creation paths ask, because a name
// can be free and its cwd still collide: a project named `p_worktree_w` lands
// where worktree `w` of project `p` does. createWorktree asks the same
// predicate directly for the other half of the pair.
//
// Lazy import for the projects.ts ↔ systems/transcriptKey.ts circular edge:
// that module enumerates places through listProjects, which lives here.
export async function projectKeyCollisionReason(
  systemId: string, remoteId: string | null, name: string, cwd: string,
): Promise<string | null> {
  const { transcriptCollisionReason, transcriptCwdCollision } =
    await import('./systems/transcriptKey.ts');
  const candidate = { project: name, worktree: null, system: systemId, remoteId, cwd };
  const hit = await transcriptCwdCollision(candidate);
  return hit === null ? null : transcriptCollisionReason(`project '${name}'`, candidate, hit);
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
  if (!resolved) throw httpError(404, `project '${name}' not found`, { code: 'PROJECT_UNKNOWN' });
  return { name, path: resolved.path, system: resolved.system };
}
