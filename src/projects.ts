import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadAll as loadAllTitles, deleteTitle as deleteSessionTitle } from './sessionTitles.ts';
import { loadAll as loadAllConducted, unmarkConducted } from './conductedSessions.ts';
import { loadAllTemps } from './tempSessions.ts';
import { loadAllArchived, markArchived, unmarkArchived } from './archivedSessions.ts';
import type { WorktreeMeta } from './worktrees.ts';

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
// above, which has the same hole (`..` passes it) and is left alone as
// pre-existing: do NOT "restore parity" with NAME_RE here, it reopens this.
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

// The conductor's own running checkout dir (the dir holding server.js /
// package.json). Exposed so the plugin supervisor can hand it to backends as
// CONDUCTOR_PROJECT_DIR — they surface the conductor as an app even when its
// checkout isn't under projectsRoot().
export function selfProjectDir(): string {
  return SELF_PROJECT_DIR;
}

export function orchStoreRoot(): string {
  return path.join(projectsRoot(), ORCH_STORE_DIRNAME);
}

export function projectStoreDir(name: string): string {
  return path.join(orchStoreRoot(), 'projects', name);
}

export function worktreeStoreDir(projectName: string, worktreeName: string): string {
  return path.join(projectStoreDir(projectName), 'worktrees', worktreeName);
}

export function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
}

export function encodeCwd(abs: string): string {
  // Mirror Claude Code's own encoding: every char that isn't
  // alphanumeric or a hyphen becomes `-`. This includes underscores!
  // Previously we kept underscores, which silently broke any project
  // path containing `_` (notably the worktree dirs we create at
  // `<project>_worktree_<id>`): the orchestrator's metadata appends
  // landed at `<…>_worktree_<…>` while real claude wrote the actual
  // session to `<…>-worktree-<…>`. Two separate dirs, both half-empty,
  // and resume / history-replay both broke.
  return abs.replace(/[^A-Za-z0-9-]/g, '-');
}

export function validateName(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw httpError(400, 'invalid project name (must match ^[a-zA-Z0-9._-]+$)');
  }
  return name;
}

// Build the set of every worktree dir-name registered under any project
// in the central store. listProjects() uses this to hide worktree dirs
// from the sidebar's top-level project list — replacing the older
// per-dir marker probe with a single readdir.
async function listAllWorktreeDirNames(): Promise<Set<string>> {
  const out = new Set<string>();
  const projectsDir = path.join(orchStoreRoot(), 'projects');
  let projects: string[];
  try { projects = await fs.readdir(projectsDir); }
  catch (e) { if (errCode(e) === 'ENOENT') return out; throw e; }
  for (const p of projects) {
    const wtDir = path.join(projectsDir, p, 'worktrees');
    let wts: string[];
    try { wts = await fs.readdir(wtDir); }
    catch (e) { if (errCode(e) === 'ENOENT') continue; throw e; }
    for (const wt of wts) out.add(wt);
  }
  return out;
}

export interface ProjectInfo {
  name: string;
  path: string;
  workspace: string | null;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const root = projectsRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const worktreeDirs = await listAllWorktreeDirNames();
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Skip dotfile dirs — the central store itself sits at
    // `<root>/.code-conductor/` and would otherwise surface as a fake
    // project named ".code-conductor".
    if (e.name.startsWith('.')) continue;
    // Skip orchestrator-owned worktree dirs — they're surfaced under
    // their parent project, not as top-level projects.
    if (worktreeDirs.has(e.name)) continue;
    const full = path.join(root, e.name);
    const meta = await readProjectMeta(e.name);
    out.push({ name: e.name, path: full, workspace: meta.workspace });
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
    let real: string;
    try { real = await fs.realpath(p.path); } catch { continue; }
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

// Read the project's optional metadata file from the central store.
// Missing file or malformed JSON → {workspace: null}. The store dir may
// not exist yet — that's fine.
export async function readProjectMeta(name: string): Promise<{ workspace: string | null }> {
  validateName(name);
  const file = path.join(projectStoreDir(name), 'project.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj: unknown = JSON.parse(raw);
    let workspace: string | null = null;
    if (typeof obj === 'object' && obj !== null) {
      const w = (obj as { workspace?: unknown }).workspace;
      if (typeof w === 'string' && w.trim() !== '') workspace = w.trim();
    }
    return { workspace };
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { workspace: null };
    // Malformed JSON or unreadable — degrade to unassigned rather than
    // throwing. A single console.warn (not an error) so noisy systems
    // don't spam logs on every list.
    console.warn(`projects: failed to read ${file}: ${errMsg(e)}`);
    return { workspace: null };
  }
}

// Write the project's metadata. Atomic rename to avoid torn reads if the
// process dies mid-write. Passing {workspace: null} clears the field and
// deletes the file if it would otherwise be empty.
export async function writeProjectMeta(
  name: string,
  patch: { workspace?: string | null },
): Promise<Record<string, string | null>> {
  validateName(name);
  await getProject(name);
  const dir = projectStoreDir(name);
  const file = path.join(dir, 'project.json');
  const current = await readProjectMeta(name);
  const merged: Record<string, string | null | undefined> = { ...current, ...patch };
  if ('workspace' in patch) merged.workspace = validateWorkspace(patch.workspace);
  // Drop empty fields so the on-disk file stays minimal.
  const next: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null && v !== undefined) next[k] = v;
  }
  if (Object.keys(next).length === 0) {
    // Nothing to persist — remove the file. Leave the surrounding
    // store dir (it may still hold attachments/debug/worktrees).
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return next;
  }
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// Shared mkdir-parent → write tmp(.pid) → rename helper. The tmp file is
// created and atomically renamed away, so its exact name is unobservable;
// the .pid suffix just keeps concurrent same-process writers from colliding.
// Homed here because projects.ts is the lowest module already imported by the
// other call sites (appSettings.ts, rootClaudeMd.ts) — no import cycle.
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, filePath);
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

export async function createProject(
  name: string,
  { conventionsDoc = null }: { conventionsDoc?: string | null } = {},
): Promise<{ name: string; path: string }> {
  validateName(name);
  const root = projectsRoot();
  const full = path.join(root, name);
  try {
    await fs.mkdir(full, { recursive: false });
  } catch (e) {
    if (errCode(e) === 'EEXIST') {
      throw httpError(409, `project '${name}' already exists`);
    }
    throw e;
  }
  // Seed a CLAUDE.md that imports the workspace-wide one at ~/project/CLAUDE.md.
  // Using @../CLAUDE.md so Claude Code's import resolver pulls the workspace
  // file in regardless of where the project ends up being mounted.
  // When conventions were selected the caller passes the composed CONVENTIONS.md
  // document; we add an in-project `@CONVENTIONS.md` import and write the file.
  // That file is app-owned + regenerated later (src/projectClaudeMd.ts); the
  // caller composes it (no circular dep on projectConventions here).
  const importLine = conventionsDoc != null ? '@../CLAUDE.md\n@CONVENTIONS.md\n' : '@../CLAUDE.md\n';
  const claudeMdPath = path.join(full, 'CLAUDE.md');
  try {
    await fs.writeFile(claudeMdPath, importLine, { flag: 'wx' });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  if (conventionsDoc != null) {
    await fs.writeFile(path.join(full, 'CONVENTIONS.md'), conventionsDoc);
  }
  return { name, path: full };
}

// Delete the entire project directory + the project's central-store
// entry. Caller is responsible for first killing any running instances
// and removing worktree registrations (the cascade is orchestrated in
// src/routes.ts). Sessions under ~/.claude/projects/<encoded>/ are
// deliberately left in place — they might still be referenced by
// `claude --resume` outside the orchestrator.
export async function deleteProject(name: string): Promise<{ name: string; path: string }> {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    await fs.rm(full, { recursive: true, force: true });
  } catch (e) {
    throw httpError(500, `failed to delete project '${name}': ${errMsg(e)}`);
  }
  // Central-store entry holds attachments, debug captures, worktree
  // metadata — all of it goes with the project.
  try { await fs.rm(projectStoreDir(name), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  return { name, path: full };
}

export async function getProject(name: string): Promise<{ name: string; path: string }> {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    const stat = await fs.stat(full);
    if (!stat.isDirectory()) {
      throw httpError(404, `'${name}' is not a directory`);
    }
    return { name, path: full };
  } catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw httpError(404, `project '${name}' not found`);
    }
    throw e;
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
  mtime: number;
  size: number;
}

export async function listSessionsForCwd(
  absCwd: string,
  excludeSessionIds: Set<string> | null = null,
  { includeArchived = true }: { includeArchived?: boolean } = {},
): Promise<SessionRow[]> {
  const encoded = encodeCwd(absCwd);
  const dir = path.join(claudeProjectsRoot(), encoded);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  const titles = await loadAllTitles();
  const conducted = await loadAllConducted();
  const temps = await loadAllTemps();
  const archived = await loadAllArchived();
  const out: SessionRow[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    if (!includeArchived && archived.has(sid)) continue;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let firstPrompt: string | null = null;
    try { firstPrompt = await readFirstPrompt(full); } catch { /* ignore */ }
    out.push({
      sessionId: sid,
      firstPrompt,
      title: titles.get(sid) ?? null,
      conducted: conducted.has(sid),
      temp: temps.has(sid),
      archived: archived.has(sid),
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function listSessions(projectName: string, excludeSessionIds: Set<string> | null = null): Promise<SessionRow[]> {
  const proj = await getProject(projectName);
  return listSessionsForCwd(proj.path, excludeSessionIds);
}

// Archive the session at the conventional path: keep the jsonl (so it
// stays resumable) and just record the sessionId in the global archived
// set. Title + conducted markers are intentionally kept so a restore
// brings the session back intact. Returns true on success, false if the
// jsonl didn't exist (404 path from the route). This is the single
// "remove from the normal list" action — it never deletes from disk.
export async function archiveSessionForCwd(absCwd: string, sessionId: string): Promise<boolean> {
  const file = path.join(claudeProjectsRoot(), encodeCwd(absCwd), `${sessionId}.jsonl`);
  try {
    await fs.access(file);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
  await markArchived(sessionId);
  return true;
}

// Permanently remove the persisted session jsonl at the conventional
// path. Returns true on success, false if the file didn't exist (404
// path from the route). This is the ONLY code path that deletes a
// session jsonl from disk; it is reachable only from the explicit
// per-session Delete on the Settings → Archived page. Caller is
// responsible for killing any running instance attached to this
// sessionId first.
export async function deleteSessionForCwd(absCwd: string, sessionId: string): Promise<boolean> {
  const file = path.join(claudeProjectsRoot(), encodeCwd(absCwd), `${sessionId}.jsonl`);
  try {
    await fs.unlink(file);
    try { await deleteSessionTitle(sessionId); } catch { /* sidecar cleanup is best-effort */ }
    try { await unmarkConducted(sessionId); } catch { /* sidecar cleanup is best-effort */ }
    try { await unmarkArchived(sessionId); } catch { /* sidecar cleanup is best-effort */ }
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

// Look up which project (and optionally which worktree) owns a given
// sessionId by probing the conventional `~/.claude/projects/<encoded-cwd>/
// <sid>.jsonl` path against every known project + worktree. Returns
// { project, worktreeName: string|null } on hit, null when nothing matches.
// `encodeCwd` is one-way (lossy: '_' and '/' both collapse to '-'), so
// we can't reverse-map a directory name back to a project — enumerating
// known paths and probing is the only correct approach.
export async function findSessionLocation(sessionId: string): Promise<{ project: string; worktreeName: string | null } | null> {
  // Permissive validation: sessionIds are UUIDs in practice but we accept
  // anything that's safe to interpolate into a filename. The point is to
  // reject path-traversal payloads before they touch the filesystem.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  // Lazy import to avoid the projects.ts ↔ worktrees.ts circular dep
  // worktrees.ts already imports from projects.ts (encodeCwd, etc.).
  const projects: ProjectInfo[] = await listProjects();

  // Include .conduct (the hidden conductor project) — listProjects() skips
  // dot-prefixed dirs, but conductor sessions live there and must still be
  // locatable for summaries/staleness-checks/locate. Mirrors the same
  // append in listArchivedGroupedByProject below.
  const conductPath = path.join(projectsRoot(), '.conduct');
  try {
    const s = await fs.stat(conductPath);
    if (s.isDirectory()) projects.push({ name: '.conduct', path: conductPath, workspace: null });
  } catch { /* .conduct doesn't exist yet — skip */ }

  for (const proj of projects) {
    const file = path.join(claudeProjectsRoot(), encodeCwd(proj.path), `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) return { project: proj.name, worktreeName: null };
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* project may not be a git repo, skip */ }
    for (const wt of wts) {
      const wtFile = path.join(claudeProjectsRoot(), encodeCwd(wt.worktreePath), `${sessionId}.jsonl`);
      try {
        const stat = await fs.stat(wtFile);
        if (stat.isFile()) return { project: proj.name, worktreeName: wt.worktreeName };
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

export interface ArchivedSessionRow {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  mtime: number;
  size: number;
  worktreeName: string | null;
}

// List every archived session, grouped by the project (and worktree)
// that owns it. archived-sessions.json only stores sessionIds, so we
// enumerate known project + worktree paths and keep the rows
// listSessionsForCwd already flags as archived (it also reads firstPrompt
// + title). Used by the Settings → Archived page. Only projects with at
// least one archived session are returned; sessions are mtime-desc.
export async function listArchivedGroupedByProject(): Promise<{ project: string; sessions: ArchivedSessionRow[] }[]> {
  const projects: ProjectInfo[] = await listProjects();

  // Include .conduct (the hidden conductor project) in the archive view only.
  // listProjects() intentionally skips dot-prefixed dirs; we add .conduct here
  // so its archived temp sessions are visible in Settings → Archived.
  const conductPath = path.join(projectsRoot(), '.conduct');
  try {
    const s = await fs.stat(conductPath);
    if (s.isDirectory()) projects.push({ name: '.conduct', path: conductPath, workspace: null });
  } catch { /* .conduct doesn't exist yet — skip */ }

  const groups: { project: string; sessions: ArchivedSessionRow[] }[] = [];
  for (const proj of projects) {
    const sessions: ArchivedSessionRow[] = [];
    const projRows = (await listSessionsForCwd(proj.path)).filter(s => s.archived);
    for (const s of projRows) {
      sessions.push({
        sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
        mtime: s.mtime, size: s.size, worktreeName: null,
      });
    }
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* not a git repo, skip */ }
    for (const wt of wts) {
      const wtRows = (await listSessionsForCwd(wt.worktreePath)).filter(s => s.archived);
      for (const s of wtRows) {
        sessions.push({
          sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
          mtime: s.mtime, size: s.size, worktreeName: wt.worktreeName,
        });
      }
    }
    if (sessions.length > 0) {
      sessions.sort((a, b) => b.mtime - a.mtime);
      groups.push({ project: proj.name, sessions });
    }
  }
  return groups;
}

// Lightweight session summary — used by /api/projects to show a count +
// "last active" stamp in the sidebar without paying the file-read cost
// of listSessionsForCwd (which extracts firstPrompt from every jsonl).
// Just readdir + stat, no opens.
export async function summarizeSessions(
  absCwd: string,
  excludeSessionIds: Set<string> | null = null,
): Promise<{ count: number; archivedCount: number; lastMtime: number }> {
  const dir = path.join(claudeProjectsRoot(), encodeCwd(absCwd));
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch (e) { if (errCode(e) === 'ENOENT') return { count: 0, archivedCount: 0, lastMtime: 0 }; throw e; }
  const archivedSet = await loadAllArchived();
  let count = 0;
  let archivedCount = 0;
  let lastMtime = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(path.join(dir, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    if (archivedSet.has(sid)) {
      archivedCount++;
    } else {
      count++;
      if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
    }
  }
  return { count, archivedCount, lastMtime };
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

// Throw an Error carrying an HTTP statusCode for the REST layer, using the
// same Object.assign pattern the routes consume (`err.statusCode`). Typed as
// `Error & { statusCode: number }` so callers can rely on the code without a
// cast.
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
