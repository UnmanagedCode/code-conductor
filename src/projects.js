import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadAll as loadAllTitles, deleteTitle as deleteSessionTitle } from './sessionTitles.js';

// Default projects root = parent directory of the code-conductor repo,
// resolved once at module load. Layout: <parent>/code-conductor/src/
// projects.js → <parent>/. Matches the convention that the orchestrator
// + its sibling projects all live under a single workspace dir (the
// user's ~/cc-projects/ by default). Override with PROJECTS_ROOT.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Workspace names are looser than project names: spaces and slashes are
// allowed so users can type a natural label ("Work", "Side projects",
// "client/Foo"). Bounded length + no control chars so it remains safe to
// render and serialise.
const WORKSPACE_RE = /^[\w][\w \-./]{0,39}$/;

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

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

export function orchStoreRoot() {
  return path.join(projectsRoot(), ORCH_STORE_DIRNAME);
}

export function projectStoreDir(name) {
  return path.join(orchStoreRoot(), 'projects', name);
}

export function worktreeStoreDir(projectName, worktreeName) {
  return path.join(projectStoreDir(projectName), 'worktrees', worktreeName);
}

export function claudeProjectsRoot() {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
}

export function encodeCwd(abs) {
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

export function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    const err = new Error('invalid project name (must match ^[a-zA-Z0-9._-]+$)');
    err.statusCode = 400;
    throw err;
  }
  return name;
}

// Build the set of every worktree dir-name registered under any project
// in the central store. listProjects() uses this to hide worktree dirs
// from the sidebar's top-level project list — replacing the older
// per-dir marker probe with a single readdir.
async function listAllWorktreeDirNames() {
  const out = new Set();
  const projectsDir = path.join(orchStoreRoot(), 'projects');
  let projects;
  try { projects = await fs.readdir(projectsDir); }
  catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const p of projects) {
    const wtDir = path.join(projectsDir, p, 'worktrees');
    let wts;
    try { wts = await fs.readdir(wtDir); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const wt of wts) out.add(wt);
  }
  return out;
}

export async function listProjects() {
  const root = projectsRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const worktreeDirs = await listAllWorktreeDirNames();
  const out = [];
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

export function validateWorkspace(workspace) {
  if (workspace === null) return null;
  if (typeof workspace !== 'string') {
    const err = new Error('workspace must be a string or null');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = workspace.trim();
  if (trimmed === '') return null;
  if (!WORKSPACE_RE.test(trimmed)) {
    const err = new Error('invalid workspace name (1–40 chars, no control chars; spaces / `/`,`.`,`-`,`_` allowed)');
    err.statusCode = 400;
    throw err;
  }
  return trimmed;
}

// Read the project's optional metadata file from the central store.
// Missing file or malformed JSON → {workspace: null}. The store dir may
// not exist yet — that's fine.
export async function readProjectMeta(name) {
  validateName(name);
  const file = path.join(projectStoreDir(name), 'project.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    const workspace = typeof obj?.workspace === 'string' && obj.workspace.trim() !== ''
      ? obj.workspace.trim()
      : null;
    return { workspace };
  } catch (e) {
    if (e.code === 'ENOENT') return { workspace: null };
    // Malformed JSON or unreadable — degrade to unassigned rather than
    // throwing. A single console.warn (not an error) so noisy systems
    // don't spam logs on every list.
    console.warn(`projects: failed to read ${file}: ${e.message}`);
    return { workspace: null };
  }
}

// Write the project's metadata. Atomic rename to avoid torn reads if the
// process dies mid-write. Passing {workspace: null} clears the field and
// deletes the file if it would otherwise be empty.
export async function writeProjectMeta(name, patch) {
  validateName(name);
  await getProject(name);
  const dir = projectStoreDir(name);
  const file = path.join(dir, 'project.json');
  const current = await readProjectMeta(name);
  const next = { ...current, ...patch };
  if ('workspace' in patch) next.workspace = validateWorkspace(patch.workspace);
  // Drop empty fields so the on-disk file stays minimal.
  for (const k of Object.keys(next)) {
    if (next[k] === null || next[k] === undefined) delete next[k];
  }
  if (Object.keys(next).length === 0) {
    // Nothing to persist — remove the file. Leave the surrounding
    // store dir (it may still hold attachments/debug/worktrees).
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return next;
  }
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmp, file);
  return next;
}

// ── Workspace registry ────────────────────────────────────────────────
// Workspace existence is persisted independently of membership. A
// workspace with zero member projects still exists if its name appears
// in `<store>/workspaces.json`. Membership remains stored per-project on
// `project.workspace`; the registry is the union source so empty
// workspaces survive the last member leaving.

function workspacesFile() {
  return path.join(orchStoreRoot(), 'workspaces.json');
}

export async function listWorkspaces() {
  try {
    const raw = await fs.readFile(workspacesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.workspaces)) return [];
    const out = [];
    for (const v of obj.workspaces) {
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (t) out.push(t);
    }
    return [...new Set(out)].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`projects: failed to read ${workspacesFile()}: ${e.message}`);
    return [];
  }
}

async function writeWorkspacesRegistry(names) {
  const file = workspacesFile();
  const cleaned = [...new Set(names.map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (cleaned.length === 0) {
    try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return cleaned;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify({ workspaces: cleaned }, null, 2) + '\n');
  await fs.rename(tmp, file);
  return cleaned;
}

export async function addWorkspace(name) {
  const v = validateWorkspace(name);
  if (!v) {
    const err = new Error('workspace name is required');
    err.statusCode = 400;
    throw err;
  }
  const current = await listWorkspaces();
  if (current.includes(v)) return { added: false, name: v };
  await writeWorkspacesRegistry([...current, v]);
  return { added: true, name: v };
}

// Remove a workspace from the registry and clear the `workspace` field
// on every project that currently points at it. The projects themselves
// are untouched — they just fall back to unassigned.
export async function removeWorkspace(name) {
  const v = validateWorkspace(name);
  if (!v) {
    const err = new Error('workspace name is required');
    err.statusCode = 400;
    throw err;
  }
  const projects = await listProjects();
  const members = projects.filter(p => p.workspace === v).map(p => p.name);
  for (const m of members) {
    try { await writeProjectMeta(m, { workspace: null }); }
    catch (e) { console.warn(`removeWorkspace: failed clearing '${m}': ${e.message}`); }
  }
  const current = await listWorkspaces();
  const filtered = current.filter(n => n !== v);
  const removed = filtered.length !== current.length;
  if (removed) await writeWorkspacesRegistry(filtered);
  return { removed: removed || members.length > 0, name: v, clearedProjects: members };
}

// Atomically rename a workspace: rewrite every member project's
// `workspace` field and swap the entry in the registry. If the old name
// isn't in the registry but has members on disk (legacy path), still
// rewrites the members and adds the new name.
export async function renameWorkspace(oldName, newName) {
  const oldV = validateWorkspace(oldName);
  const newV = validateWorkspace(newName);
  if (!oldV || !newV) {
    const err = new Error('both old and new workspace names are required');
    err.statusCode = 400;
    throw err;
  }
  if (oldV === newV) return { renamed: false, name: newV, movedProjects: [] };
  const projects = await listProjects();
  const members = projects.filter(p => p.workspace === oldV).map(p => p.name);
  for (const m of members) {
    try { await writeProjectMeta(m, { workspace: newV }); }
    catch (e) { console.warn(`renameWorkspace: failed rewriting '${m}': ${e.message}`); }
  }
  const current = await listWorkspaces();
  const next = [...new Set(current.filter(n => n !== oldV).concat(newV))];
  await writeWorkspacesRegistry(next);
  return { renamed: true, name: newV, movedProjects: members };
}

export async function createProject(name) {
  validateName(name);
  const root = projectsRoot();
  const full = path.join(root, name);
  try {
    await fs.mkdir(full, { recursive: false });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const err = new Error(`project '${name}' already exists`);
      err.statusCode = 409;
      throw err;
    }
    throw e;
  }
  // Seed a CLAUDE.md that imports the workspace-wide one at ~/project/CLAUDE.md.
  // Using @../CLAUDE.md so Claude Code's import resolver pulls the workspace
  // file in regardless of where the project ends up being mounted.
  const claudeMdPath = path.join(full, 'CLAUDE.md');
  try {
    await fs.writeFile(claudeMdPath, '@../CLAUDE.md\n', { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { name, path: full };
}

// Delete the entire project directory + the project's central-store
// entry. Caller is responsible for first killing any running instances
// and removing worktree registrations (the cascade is orchestrated in
// src/routes.js). Sessions under ~/.claude/projects/<encoded>/ are
// deliberately left in place — they might still be referenced by
// `claude --resume` outside the orchestrator.
export async function deleteProject(name) {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    await fs.rm(full, { recursive: true, force: true });
  } catch (e) {
    const err = new Error(`failed to delete project '${name}': ${e.message}`);
    err.statusCode = 500;
    throw err;
  }
  // Central-store entry holds attachments, debug captures, worktree
  // metadata — all of it goes with the project.
  try { await fs.rm(projectStoreDir(name), { recursive: true, force: true }); }
  catch { /* best-effort */ }
  return { name, path: full };
}

export async function getProject(name) {
  validateName(name);
  const full = path.join(projectsRoot(), name);
  try {
    const stat = await fs.stat(full);
    if (!stat.isDirectory()) {
      const err = new Error(`'${name}' is not a directory`);
      err.statusCode = 404;
      throw err;
    }
    return { name, path: full };
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error(`project '${name}' not found`);
      err.statusCode = 404;
      throw err;
    }
    throw e;
  }
}

async function readFirstPrompt(jsonlPath) {
  const fh = await fs.open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'user' && obj.message) {
        const c = obj.message.content;
        if (typeof c === 'string') return c.slice(0, 200);
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 200);
          }
        }
      }
      if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') return obj.lastPrompt.slice(0, 200);
    }
    return null;
  } finally {
    await fh.close();
  }
}

export async function listSessionsForCwd(absCwd, excludeSessionIds = null) {
  const encoded = encodeCwd(absCwd);
  const dir = path.join(claudeProjectsRoot(), encoded);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const titles = await loadAllTitles();
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let firstPrompt = null;
    try { firstPrompt = await readFirstPrompt(full); } catch { /* ignore */ }
    out.push({
      sessionId: sid,
      firstPrompt,
      title: titles.get(sid) ?? null,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function listSessions(projectName, excludeSessionIds = null) {
  const proj = await getProject(projectName);
  return listSessionsForCwd(proj.path, excludeSessionIds);
}

// Remove the persisted session jsonl at the conventional path.
// Returns true on success, false if the file didn't exist (404 path
// from the route). Caller is responsible for killing any running
// instance attached to this sessionId first.
export async function deleteSessionForCwd(absCwd, sessionId) {
  const file = path.join(claudeProjectsRoot(), encodeCwd(absCwd), `${sessionId}.jsonl`);
  try {
    await fs.unlink(file);
    try { await deleteSessionTitle(sessionId); } catch { /* sidecar cleanup is best-effort */ }
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// Look up which project (and optionally which worktree) owns a given
// sessionId by probing the conventional `~/.claude/projects/<encoded-cwd>/
// <sid>.jsonl` path against every known project + worktree. Returns
// { project, worktreeName: string|null } on hit, null when nothing matches.
// `encodeCwd` is one-way (lossy: '_' and '/' both collapse to '-'), so
// we can't reverse-map a directory name back to a project — enumerating
// known paths and probing is the only correct approach.
export async function findSessionLocation(sessionId) {
  // Permissive validation: sessionIds are UUIDs in practice but we accept
  // anything that's safe to interpolate into a filename. The point is to
  // reject path-traversal payloads before they touch the filesystem.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  // Lazy import to avoid the projects.js ↔ worktrees.js circular dep
  // worktrees.js already imports from projects.js (encodeCwd, etc.).
  const { listWorktrees } = await import('./worktrees.js');
  const projects = await listProjects();
  for (const proj of projects) {
    const file = path.join(claudeProjectsRoot(), encodeCwd(proj.path), `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) return { project: proj.name, worktreeName: null };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    let wts = [];
    try { wts = await listWorktrees(proj.name); } catch { /* project may not be a git repo, skip */ }
    for (const wt of wts) {
      const wtFile = path.join(claudeProjectsRoot(), encodeCwd(wt.worktreePath), `${sessionId}.jsonl`);
      try {
        const stat = await fs.stat(wtFile);
        if (stat.isFile()) return { project: proj.name, worktreeName: wt.worktreeName };
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

// Lightweight session summary — used by /api/projects to show a count +
// "last active" stamp in the sidebar without paying the file-read cost
// of listSessionsForCwd (which extracts firstPrompt from every jsonl).
// Just readdir + stat, no opens.
export async function summarizeSessions(absCwd, excludeSessionIds = null) {
  const dir = path.join(claudeProjectsRoot(), encodeCwd(absCwd));
  let entries;
  try { entries = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return { count: 0, lastMtime: 0 }; throw e; }
  let count = 0;
  let lastMtime = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    let stat;
    try { stat = await fs.stat(path.join(dir, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    count++;
    if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
  }
  return { count, lastMtime };
}
